// A private position the wallet never touches on the Agama program.
//
//   [1] a wallet with USDC and SOL (sent by the funder, not the faucet, so no
//       Agama instruction is in its history from the start)
//   [2] the wallet signs one message; the position key is derived from it
//   [3] the sponsor opens the position for that key
//   [4] the wallet sends privately to a throwaway key, which shields (sponsored)
//   [5] inside the enclave the position key and the shield key credit it
//   [6] the position key redeems half to the wallet; refusals on the way
//   [7] every public transaction in the wallet's history: none invokes Agama
//
//   npx tsx scripts/e2e-stealth.ts
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import {
  BASE_RPC,
  PROGRAM_ID,
  TEE_RPC,
  assertTeeAttested,
  authedConnectionTo,
  erEndpointFor,
  exitsPda,
  loadCustodyKeypair,
  loadKeypair,
  loadSponsorKeypair,
  positionPda,
  programFor,
  sendAndPoll,
  sleep,
  usdcMint,
  vaultPda,
} from "./common";
import {
  POSITION_KEY_MESSAGE,
  ata,
  depositPrivateIxs,
  encryptedSendIxs,
  positionKeyFromSignature,
  redeemPrivateIx,
  redeemPrivateToIx,
  randomGroupId,
  sponsoredOpenIxs,
  sponsoredShieldIxs,
} from "./private";

const AMOUNT = 200_000_000n;
const usdc = (v: any) => (Number(v.toString()) / 1e6).toFixed(6);
const step = (n: string, m: string) => console.log(`\n${n} ${m}`);

async function programsOf(sig: string): Promise<string[]> {
  for (let i = 0; i < 10; i++) {
    const r: any = await fetch(BASE_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 1 }] }),
    }).then((x) => x.json());
    const m = r?.result?.transaction?.message;
    if (m) {
      const inner = (r.result.meta?.innerInstructions ?? []).flatMap((g: any) => g.instructions);
      return [...new Set<string>([...m.instructions, ...inner].map((ix: any) => m.accountKeys[ix.programIdIndex]))];
    }
    await sleep(1500);
  }
  return [];
}

async function main() {
  const funder = loadKeypair();
  const sponsor = loadSponsorKeypair();
  const custody = loadCustodyKeypair();
  const wallet = Keypair.generate();
  const base = new Connection(BASE_RPC, "confirmed");
  await assertTeeAttested(TEE_RPC);

  step("[1]", "a wallet with SOL and USDC, funded directly (no Agama instruction in its history)");
  const pf = programFor(base, funder);
  const claim = PublicKey.findProgramAddressSync([Buffer.from("faucet-claim"), funder.publicKey.toBuffer()], PROGRAM_ID)[0];
  if ((await base.getTokenAccountBalance(ata(funder.publicKey)).then((r) => BigInt(r.value.amount)).catch(() => 0n)) < 400_000_000n) {
    await pf.methods.faucet().accounts({ user: funder.publicKey, vault: vaultPda, claim, usdcMint, userUsdc: ata(funder.publicKey), tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc();
  }
  await sendAndPoll(base, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: wallet.publicKey, lamports: 100_000_000 }),
    createAssociatedTokenAccountIdempotentInstruction(funder.publicKey, ata(wallet.publicKey), wallet.publicKey, usdcMint),
    createTransferInstruction(ata(funder.publicKey), ata(wallet.publicKey), funder.publicKey, 400_000_000n),
  ), [funder]);
  console.log("       wallet", wallet.publicKey.toBase58(), "holds 400 USDC");

  step("[2]", "the wallet signs one message; the position key comes from it");
  const sig1 = nacl.sign.detached(Buffer.from(POSITION_KEY_MESSAGE), wallet.secretKey);
  const key = positionKeyFromSignature(sig1);
  const again = positionKeyFromSignature(nacl.sign.detached(Buffer.from(POSITION_KEY_MESSAGE), wallet.secretKey));
  console.log("       position key", key.publicKey.toBase58(), again.publicKey.equals(key.publicKey) ? "(same on every signing)" : "DIFFERS");
  const position = positionPda(key.publicKey);

  step("[3]", "the sponsor opens the position for that key");
  const pk = programFor(base, key);
  const openSig = await sendAndPoll(base, new Transaction().add(...(await sponsoredOpenIxs(pk, key.publicKey, sponsor.publicKey))), [sponsor, key]);
  const openTx = await base.getTransaction(openSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  const openKeys = openTx!.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
  console.log("      ", openSig, `\n       names the wallet: ${openKeys.includes(wallet.publicKey.toBase58()) ? "YES" : "no"}`);

  step("[4]", "the wallet sends privately; a throwaway key shields what arrives");
  const shieldKey = Keypair.generate();
  await sendAndPoll(base, new Transaction().add(...(await encryptedSendIxs(wallet.publicKey, shieldKey.publicKey, AMOUNT, { minDelayMs: 2000n, maxDelayMs: 6000n, split: 2 }))), [wallet]);
  for (let i = 0; (await base.getTokenAccountBalance(ata(shieldKey.publicKey)).then((r) => BigInt(r.value.amount)).catch(() => 0n)) < AMOUNT; i++) {
    if (i > 60) throw new Error("not delivered");
    await sleep(2000);
  }
  await sendAndPoll(base, new Transaction().add(...sponsoredShieldIxs(shieldKey.publicKey, sponsor.publicKey, AMOUNT)), [sponsor, shieldKey]);
  console.log("       delivered and shielded");

  step("[5]", "inside the enclave: the position key seals and credits, no session key, no wallet");
  let url: string | null = null;
  for (let i = 0; i < 15 && !url; i++) {
    await sleep(2000);
    url = await erEndpointFor(position).catch(() => null);
  }
  const teeP = await authedConnectionTo(url!, key);
  const er = programFor(teeP, key);
  const teeK = await authedConnectionTo(TEE_RPC, shieldKey);
  for (let i = 0; i < 20; i++) {
    const b: any = await teeK.getTokenAccountBalance(ata(shieldKey.publicKey)).catch(() => null);
    if (b?.value?.amount === AMOUNT.toString()) break;
    await sleep(2000);
  }
  const permission = PublicKey.findProgramAddressSync([Buffer.from("permission:"), position.toBuffer()], PERMISSION_PROGRAM_ID)[0];
  await sendAndPoll(teeP, new Transaction().add(await er.methods.initPermission([]).accounts({
    signer: key.publicKey, position, permission, permissionProgram: PERMISSION_PROGRAM_ID, ephemeralVault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID,
  }).instruction()), [key]);
  await sendAndPoll(teeP, new Transaction().add(...(await depositPrivateIxs(er, {
    shieldKey: shieldKey.publicKey, signer: key.publicKey, position, custodyOwner: custody.publicKey, amount: AMOUNT,
  }))), [key, shieldKey]);
  const pos: any = await er.account.position.fetch(position);
  console.log(`       private shares ${usdc(pos.privateShares)}  value ${usdc(pos.valueUsdc)}`);

  step("[6]", "the position key redeems half to the wallet");
  const half = new BN(pos.privateShares.toString()).divn(2);
  const stranger = Keypair.generate();
  const erS = programFor(await authedConnectionTo(url!, stranger), stranger);
  const strangerTo = await redeemPrivateToIx(erS, { owner: stranger.publicKey, position, shares: half, groupId: randomGroupId(), payout: stranger.publicKey });
  const r1 = await sendAndPoll(await authedConnectionTo(url!, stranger), new Transaction().add(strangerTo), [stranger]).then(() => "ACCEPTED", (e) => /"Custom":6007/.test(String(e?.message)) ? "refused, Unauthorized" : String(e?.message).slice(0, 80));
  console.log(`       a stranger redeems it to themselves   ${r1}`);
  if (r1 === "ACCEPTED") process.exitCode = 1;
  const before = BigInt((await base.getTokenAccountBalance(ata(wallet.publicKey))).value.amount);
  await sendAndPoll(teeP, new Transaction().add(await redeemPrivateToIx(er, { owner: key.publicKey, position, shares: half, groupId: randomGroupId(), payout: wallet.publicKey, maxDelayMs: 3000 })), [key]);
  for (let i = 0; i < 60; i++) {
    const now = BigInt((await base.getTokenAccountBalance(ata(wallet.publicKey))).value.amount);
    if (now > before) { console.log(`       wallet received ${usdc(now - before)} USDC (the keeper paid the ticket)`); break; }
    if (i === 59) { console.log("       nothing arrived"); process.exitCode = 1; }
    await sleep(3000);
  }

  step("[7]", "every public transaction in the wallet's history");
  const sigs = await base.getSignaturesForAddress(wallet.publicKey, { limit: 50 });
  const usdcSigs = await base.getSignaturesForAddress(ata(wallet.publicKey), { limit: 50 });
  const all = [...new Set([...sigs, ...usdcSigs].map((s) => s.signature))];
  let touched = 0;
  for (const s of all) {
    const progs = await programsOf(s);
    const agama = progs.includes(PROGRAM_ID.toBase58());
    if (agama) touched++;
    console.log(`       ${s.slice(0, 12)}…  ${agama ? "AGAMA" : "no Agama"}  (${progs.map((p) => p.slice(0, 6)).join(",")})`);
  }
  console.log(`\n${all.length} transactions involve the wallet; ${touched} invoke the Agama program`);
  if (touched > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
