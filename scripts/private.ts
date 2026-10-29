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
import { Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from "@solana/web3.js";
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
  deriveEphemeralAta,
  deriveGroupReceipt,
  deriveQueueVaultAta,
  deriveTransferQueue,
  deriveVault,
  deriveVaultAta,
  initEphemeralAtaIx,
  transferToVaultIx,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { TEE_VALIDATOR, bookPda, exitsPda, shieldedPda, usdcMint, vaultPda } from "./common";

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
