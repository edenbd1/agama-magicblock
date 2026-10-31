// The private path, as instruction builders shared by the e2e, the keeper and
// (mirrored) the app.
//
//   shield         base layer, one wallet approval. Wallet -> a throwaway key ->
//                  MagicBlock's Global Vault, credited to that key's private eATA
//                  on the TEE. Nothing in it names Agama.
//   deposit        TEE. An SPL Token transfer from the throwaway key into the
//                  private custody, then `deposit_private`, which credits shares
//                  only after reading that transfer next to it.
//   redeem         TEE. `redeem_private` burns shares and opens an exit ticket.
//   pay exit       TEE, keeper. MagicBlock's queued private transfer out of the
//                  custody to the ticket's owner, then `settle_exit`, which
//                  closes the ticket only after reading that payment.
//
// The enclave's query filter refuses any transaction that hands a private eATA
// to a program other than SPL Token or MagicBlock's own, which is why each token
// movement is its own top-level instruction and the Agama program only reads it.
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { createHash } from "crypto";
import { Ed25519Program, Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  createEataPermissionIx,
  delegateEphemeralAtaIx,
  EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  deriveEphemeralAta,
  deriveGroupReceipt,
  deriveQueueVaultAta,
  deriveTransferQueue,
  deriveVault,
  deriveVaultAta,
  initEphemeralAtaIx,
  transferSpl,
  transferToVaultIx,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { TEE_VALIDATOR, agyldMint, bookPda, exitsPda, shieldedPda, usdcMint, vaultPda } from "./common";

export const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(usdcMint, owner, true);

/// Base layer. `wallet` pays and signs; `shieldKey` signs as the eATA owner.
export function shieldIxs(wallet: PublicKey, shieldKey: PublicKey, amount: bigint): TransactionInstruction[] {
  const [eata] = deriveEphemeralAta(shieldKey, usdcMint);
  const [gvault] = deriveVault(usdcMint);
  return [
    createAssociatedTokenAccountIdempotentInstruction(wallet, ata(shieldKey), shieldKey, usdcMint),
    createTransferInstruction(ata(wallet), ata(shieldKey), wallet, amount),
    initEphemeralAtaIx(eata, shieldKey, usdcMint, wallet),
    transferToVaultIx(eata, gvault, usdcMint, ata(shieldKey), deriveVaultAta(usdcMint, gvault), shieldKey, amount),
    createEataPermissionIx(eata, wallet),
    delegateEphemeralAtaIx(wallet, eata, TEE_VALIDATOR),
  ];
}

/// TEE. Signers: `shieldKey` and `signer` (the session key or the owner).
export async function depositPrivateIxs(
  program: anchor.Program,
  args: { shieldKey: PublicKey; signer: PublicKey; position: PublicKey; custodyOwner: PublicKey; amount: bigint },
): Promise<TransactionInstruction[]> {
  return [
    createTransferInstruction(ata(args.shieldKey), ata(args.custodyOwner), args.shieldKey, args.amount),
    await program.methods
      .depositPrivate(new BN(args.amount.toString()))
      .accounts({
        depositor: args.shieldKey,
        signer: args.signer,
        position: args.position,
        vault: vaultPda,
        book: bookPda,
        shielded: shieldedPda,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction(),
  ];
}

export function randomGroupId(): number {
  return 1 + Math.floor(Math.random() * 0xfffffe);
}

/// TEE. Signer: the session key or the owner.
export async function redeemPrivateIx(
  program: anchor.Program,
  args: { signer: PublicKey; position: PublicKey; shares: BN; groupId: number; minDelayMs?: number; maxDelayMs?: number; split?: number },
): Promise<TransactionInstruction> {
  return program.methods
    .redeemPrivate(args.shares, args.groupId, new BN(args.minDelayMs ?? 0), new BN(args.maxDelayMs ?? 0), args.split ?? 1)
    .accounts({
      signer: args.signer,
      position: args.position,
      vault: vaultPda,
      book: bookPda,
      shielded: shieldedPda,
      exits: exitsPda,
    })
    .instruction();
}

export interface OpenExit {
  owner: PublicKey;
  assets: BN;
  minDelayMs: BN;
  maxDelayMs: BN;
  groupId: number;
  split: number;
}

/// TEE, keeper. Signers: the custody key and the vault authority.
export async function payExitIxs(
  program: anchor.Program,
  args: { exit: OpenExit; custodyOwner: PublicKey; authority: PublicKey },
): Promise<TransactionInstruction[]> {
  const { exit } = args;
  const pay = queueTransferIx({
    source: ata(args.custodyOwner),
    owner: args.custodyOwner,
    destination: exit.owner,
    amount: BigInt(exit.assets.toString()),
    groupId: exit.groupId,
    minDelayMs: BigInt(exit.minDelayMs.toString()),
    maxDelayMs: BigInt(exit.maxDelayMs.toString()),
    split: exit.split,
  });
  const settle = await program.methods
    .settleExit(exit.groupId)
    .accounts({ authority: args.authority, vault: vaultPda, shielded: shieldedPda, exits: exitsPda, instructions: SYSVAR_INSTRUCTIONS_PUBKEY })
    .instruction();
  return [pay, settle];
}

/// MagicBlock's `DepositAndQueueTransfer`, built by hand because the SDK's
/// builder draws its own random group id, and the payout has to carry the
/// ticket's. Layout from the SDK: [16, amount u64, group id u24, min delay u64,
/// max delay u64, split u32]; the group receipt PDA is keyed on the same id.
export function queueTransferIx(a: {
  source: PublicKey;
  owner: PublicKey;
  destination: PublicKey;
  amount: bigint;
  groupId: number;
  minDelayMs: bigint;
  maxDelayMs: bigint;
  split: number;
}): TransactionInstruction {
  const [queue] = deriveTransferQueue(usdcMint, TEE_VALIDATOR);
  const data = Buffer.alloc(32);
  data[0] = 16;
  data.writeBigUInt64LE(a.amount, 1);
  data[9] = a.groupId & 0xff;
  data[10] = (a.groupId >> 8) & 0xff;
  data[11] = (a.groupId >> 16) & 0xff;
  data.writeBigUInt64LE(a.minDelayMs, 12);
  data.writeBigUInt64LE(a.maxDelayMs, 20);
  data.writeUInt32LE(a.split, 28);
  const [receipt] = deriveGroupReceipt(queue, a.owner, a.groupId);
  return new TransactionInstruction({
    programId: EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: queue, isSigner: false, isWritable: true },
      { pubkey: queue, isSigner: false, isWritable: false },
      { pubkey: usdcMint, isSigner: false, isWritable: false },
      { pubkey: a.source, isSigner: false, isWritable: true },
      { pubkey: deriveQueueVaultAta(usdcMint, TEE_VALIDATOR), isSigner: false, isWritable: true },
      { pubkey: a.destination, isSigner: false, isWritable: false },
      { pubkey: a.owner, isSigner: true, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: a.source, isSigner: false, isWritable: true },
      { pubkey: receipt, isSigner: false, isWritable: true },
      { pubkey: EPHEMERAL_VAULT_ID, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function newShieldKey(): Keypair {
  return Keypair.generate();
}

/// What the owner's wallet signs to hand a delegated position to a new session
/// key. Must match `session_message` in the program byte for byte.
export function sessionMessage(position: PublicKey, sessionKey: PublicKey, expiry: number): Buffer {
  return Buffer.from(`Agama on MagicBlock\nAuthorize session key ${sessionKey.toBase58()} for position ${position.toBase58()} until ${expiry}`);
}

/// TEE. The Ed25519 precompile verifying the wallet's signature, then
/// `rotate_session`, which reads that verification. Signer: anyone (the new key).
export async function rotateSessionIxs(
  program: anchor.Program,
  args: { owner: PublicKey; position: PublicKey; submitter: PublicKey; sessionKey: PublicKey; expiry: number; signature: Uint8Array; signedBy?: PublicKey; message?: Buffer },
): Promise<TransactionInstruction[]> {
  const message = args.message ?? sessionMessage(args.position, args.sessionKey, args.expiry);
  const verify = Ed25519Program.createInstructionWithPublicKey({
    publicKey: (args.signedBy ?? args.owner).toBytes(),
    message,
    signature: args.signature,
  });
  const rotate = await program.methods
    .rotateSession(args.sessionKey, new BN(args.expiry))
    .accounts({
      submitter: args.submitter,
      position: args.position,
      permission: PublicKey.findProgramAddressSync([Buffer.from("permission:"), args.position.toBuffer()], PERMISSION_PROGRAM_ID)[0],
      permissionProgram: PERMISSION_PROGRAM_ID,
      ephemeralVault: EPHEMERAL_VAULT_ID,
      magicProgram: MAGIC_PROGRAM_ID,
      instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
  return [verify, rotate];
}

// ------------------------------------------------ encrypted-destination shield
//
// The plain shield above puts wallet -> throwaway key in a public transfer. This
// variant hides that link. The wallet sends a MagicBlock private transfer whose
// destination is encrypted to the TEE validator's key, so the throwaway key
// appears nowhere in the base transaction; the queue delivers it after a random
// delay, optionally in parts, from MagicBlock's queue vault. The key then
// shields what it received into its own private eATA. It holds no SOL (sending
// it some would recreate the link), so a sponsor pays that transaction's fees and
// rent, and signs nothing else.

/// Base layer, signed by the wallet. Destination encrypted, delivery delayed.
export async function encryptedSendIxs(
  wallet: PublicKey,
  shieldKey: PublicKey,
  amount: bigint,
  opts: { minDelayMs?: bigint; maxDelayMs?: bigint; split?: number } = {},
): Promise<TransactionInstruction[]> {
  return transferSpl(wallet, shieldKey, usdcMint, amount, {
    visibility: "private",
    fromBalance: "base",
    toBalance: "base",
    validator: TEE_VALIDATOR,
    privateTransfer: { minDelayMs: opts.minDelayMs ?? 5_000n, maxDelayMs: opts.maxDelayMs ?? 30_000n, split: opts.split ?? 2 },
  });
}

/// Base layer, signed by the shield key (as token owner) and the sponsor (fees,
/// rent). Moves what the key received into its private eATA on the TEE.
export function sponsoredShieldIxs(shieldKey: PublicKey, sponsor: PublicKey, amount: bigint): TransactionInstruction[] {
  const [eata] = deriveEphemeralAta(shieldKey, usdcMint);
  const [gvault] = deriveVault(usdcMint);
  return [
    initEphemeralAtaIx(eata, shieldKey, usdcMint, sponsor),
    transferToVaultIx(eata, gvault, usdcMint, ata(shieldKey), deriveVaultAta(usdcMint, gvault), shieldKey, amount),
    createEataPermissionIx(eata, sponsor),
    delegateEphemeralAtaIx(sponsor, eata, TEE_VALIDATOR),
  ];
}

// ----------------------------------------------------------- stealth owners
//
// A position owned by the wallet has to be opened by the wallet, on Solana:
// "this wallet has a private Agama position", in public. A stealth position is
// owned by a key derived from the wallet's signature over a fixed message, so
// the same wallet gets the same key on any device and nothing has to be stored.
// That key opens the position (the sponsor pays), acts on it inside the enclave
// directly (it is the owner, no session key needed), and redeems to the wallet
// with `redeem_private_to`. The wallet's only public transactions are the
// private send into MagicBlock and the payout it receives from MagicBlock.

export const POSITION_KEY_MESSAGE =
  "Agama private position key\n\n" +
  "Signing this derives the key that owns your private Agama position on MagicBlock. " +
  "Anyone holding this signature can redeem that position, so only sign it on app.agama.finance.";

/// Ed25519 signatures are deterministic, so this is the same key every time.
export function positionKeyFromSignature(signature: Uint8Array): Keypair {
  const seed = createHash("sha256").update(Buffer.from("agama-position-key-v1")).update(signature).digest();
  return Keypair.fromSeed(seed);
}

/// What the sponsor sends the stealth key so it can open its position: rent for
/// the Position, the permission prefund, the rollup clone floor and the
/// delegation accounts. Measured on devnet; the key keeps only dust.
export const OPEN_LAMPORTS = 35_000_000;

/// Base layer, fee payer the sponsor, signers the sponsor and the stealth key.
export async function sponsoredOpenIxs(program: anchor.Program, key: PublicKey, sponsor: PublicKey): Promise<TransactionInstruction[]> {
  const position = PublicKey.findProgramAddressSync([Buffer.from("position-v3"), key.toBuffer()], program.programId)[0];
  const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
  const pda = (tag: string, owner: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from(tag), position.toBuffer()], owner)[0];
  return [
    SystemProgram.transfer({ fromPubkey: sponsor, toPubkey: key, lamports: OPEN_LAMPORTS }),
    await program.methods.initPosition().accounts({ owner: key, vault: vaultPda, position, systemProgram: SystemProgram.programId }).instruction(),
    await program.methods.prepareForRollup().accounts({ owner: key, position, ownerAgyld: null, agyldMint, vault: vaultPda, systemProgram: SystemProgram.programId }).instruction(),
    // The key is its own session key, so clients that look for one find it.
    await program.methods.authorizeSession(key).accounts({ owner: key, position }).instruction(),
    await program.methods.delegatePosition().accounts({
      owner: key,
      bufferPosition: pda("buffer", program.programId),
      delegationRecordPosition: pda("delegation", DLP),
      delegationMetadataPosition: pda("delegation-metadata", DLP),
      position,
      validator: TEE_VALIDATOR,
      ownerProgram: program.programId,
      delegationProgram: DLP,
      systemProgram: SystemProgram.programId,
    }).instruction(),
  ];
}

/// TEE, signed by the stealth key: burn shares, pay `payout` through the queue.
export async function redeemPrivateToIx(
  program: anchor.Program,
  args: { owner: PublicKey; position: PublicKey; shares: BN; groupId: number; payout: PublicKey; minDelayMs?: number; maxDelayMs?: number },
): Promise<TransactionInstruction> {
  return program.methods
    .redeemPrivateTo(args.shares, args.groupId, new BN(args.minDelayMs ?? 0), new BN(args.maxDelayMs ?? 0), 1, args.payout)
    .accounts({ signer: args.owner, position: args.position, vault: vaultPda, book: bookPda, shielded: shieldedPda, exits: exitsPda })
    .instruction();
}

/// The n-th shield key of a stealth position, as the app derives it, so a
/// deposit cut off halfway can be found and finished from any device.
export function shieldKeyAt(positionKey: Keypair, index: number): Keypair {
  const idx = Buffer.alloc(4);
  idx.writeUInt32LE(index, 0);
  return Keypair.fromSeed(createHash("sha256").update(Buffer.from("agama-shield-key-v1")).update(positionKey.secretKey.subarray(0, 32)).update(idx).digest());
}
