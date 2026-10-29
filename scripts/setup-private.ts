// Stand up the private side of the vault. Idempotent: each step checks first.
//
//   1. Shielded (the private aggregate) and the ExitBook (open private
//      redemptions): init on Solana, delegate to the TEE, then gate both inside
//      the enclave so only the vault authority reads them live.
//   2. The private custody: an eATA under MagicBlock's Ephemeral SPL Token
//      program, owned by the operator custody key (.keys/private-custody.json),
//      permissioned, delegated to the TEE.
//      Its base-layer ATA has to exist first, or the rollup cannot materialise
//      it and the first transfer in fails with InvalidAccountData.
//   3. MagicBlock's private transfer queue for (USDC, TEE), which private
//      redemptions leave through, and the crank that drains it.
//
//   npx tsx scripts/setup-private.ts
import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  createEataPermissionIx,
  delegateEphemeralAtaIx,
  delegateTransferQueueIx,
  deriveEphemeralAta,
  deriveRentPda,
  deriveTransferQueue,
  deriveVault,
  ensureTransferQueueCrankIx,
  initEphemeralAtaIx,
  initRentPdaIx,
  initTransferQueueIx,
  initVaultAtaIx,
  initVaultIx,
  deriveVaultAta,
  magicFeeVaultPdaFromValidator,
  toTransactionInstruction,
  PERMISSION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  BASE_RPC,
  PROGRAM_ID,
  TEE_RPC,
  TEE_VALIDATOR,
  authedConnectionTo,
  delegationStatus,
  exitsPda,
  loadCustodyKeypair,
  loadKeypair,
  programFor,
  sendAndPoll,
  shieldedPda,
  sleep,
  usdcMint,
  vaultPda,
} from "./common";

async function main() {
  const wallet = loadKeypair();
  const custodyOwner = loadCustodyKeypair().publicKey;
  const base = new Connection(BASE_RPC, "confirmed");
  const program = programFor(base, wallet);
  const send = async (label: string, conn: Connection, ...ixs: any[]) =>
    console.log(label.padEnd(26), await sendAndPoll(conn, new Transaction().add(...ixs), [wallet]));

  // 1. Shielded
  if (!(await base.getAccountInfo(shieldedPda))) {
    await send("init shielded + exits", base, await program.methods.initShielded(custodyOwner)
      .accounts({ authority: wallet.publicKey, vault: vaultPda, shielded: shieldedPda, exits: exitsPda, systemProgram: SystemProgram.programId })
      .instruction());
  }
  if (!(await delegationStatus(shieldedPda))?.isDelegated) {
    await send("delegate shielded -> TEE", base, await program.methods.delegateShielded()
      .accounts({ payer: wallet.publicKey, vault: vaultPda, shielded: shieldedPda, validator: TEE_VALIDATOR })
      .instruction());
  }
  if (!(await delegationStatus(exitsPda))?.isDelegated) {
    await send("delegate exits -> TEE", base, await program.methods.delegateExits()
      .accounts({ payer: wallet.publicKey, vault: vaultPda, exits: exitsPda, validator: TEE_VALIDATOR })
      .instruction());
  }
  const tee = await authedConnectionTo(TEE_RPC, wallet);
  for (let i = 0; i < 30 && !((await tee.getAccountInfo(shieldedPda)) && (await tee.getAccountInfo(exitsPda))); i++) await sleep(2000);
  const permissionOf = (a: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("permission:"), a.toBuffer()], PERMISSION_PROGRAM_ID)[0];
  const teeProgram = programFor(tee, wallet);
  await send("gate shielded (TEE)", tee, await teeProgram.methods.initShieldedPermission()
    .accounts({
      authority: wallet.publicKey, vault: vaultPda, shielded: shieldedPda, permission: permissionOf(shieldedPda),
      exits: exitsPda, exitsPermission: permissionOf(exitsPda),
      permissionProgram: PERMISSION_PROGRAM_ID, ephemeralVault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID,
    })
    .instruction());

  // 2. Private custody
  const [rentPda] = deriveRentPda();
  if (!(await base.getAccountInfo(rentPda))) await send("init rent pda", base, initRentPdaIx(wallet.publicKey, rentPda));
  const [gvault] = deriveVault(usdcMint);
  if (!(await base.getAccountInfo(gvault))) {
    await send("init global vault", base,
      initVaultIx(gvault, usdcMint, wallet.publicKey),
      initVaultAtaIx(wallet.publicKey, deriveVaultAta(usdcMint, gvault), gvault, usdcMint));
  }
  const [custodyEata] = deriveEphemeralAta(custodyOwner, usdcMint);
  const custodyAta = getAssociatedTokenAddressSync(usdcMint, custodyOwner);
  if (!(await base.getAccountInfo(custodyEata))) {
    await send("custody eATA -> TEE", base,
      createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, custodyAta, custodyOwner, usdcMint),
      initEphemeralAtaIx(custodyEata, custodyOwner, usdcMint, wallet.publicKey),
      createEataPermissionIx(custodyEata, wallet.publicKey),
      delegateEphemeralAtaIx(wallet.publicKey, custodyEata, TEE_VALIDATOR));
  }

  // 3. Exit queue
  const [queue] = deriveTransferQueue(usdcMint, TEE_VALIDATOR);
  if (!(await base.getAccountInfo(queue))) {
    await send("init transfer queue", base, toTransactionInstruction(initTransferQueueIx(wallet.publicKey, queue, usdcMint, TEE_VALIDATOR)));
    await send("delegate transfer queue", base, toTransactionInstruction(delegateTransferQueueIx(queue, wallet.publicKey, usdcMint)));
    for (let i = 0; i < 15 && !(await tee.getAccountInfo(queue)); i++) await sleep(2000);
  }
  await send("ensure queue crank (TEE)", tee,
    toTransactionInstruction(ensureTransferQueueCrankIx(wallet.publicKey, queue, magicFeeVaultPdaFromValidator(TEE_VALIDATOR))));

  console.log("\nshielded ", shieldedPda.toBase58());
  console.log("exits    ", exitsPda.toBase58());
  console.log("custody  ", custodyOwner.toBase58(), "eATA", custodyEata.toBase58(), "ATA", custodyAta.toBase58());
  console.log("queue    ", queue.toBase58());
  console.log("program  ", PROGRAM_ID.toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
