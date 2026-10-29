// The fully private path, end to end, from a wallet that has never existed.
//
//   [1] fund the wallet, get test USDC
//   [2] open a private position: no amount anywhere in this transaction
//   [3] shield: wallet -> throwaway key -> MagicBlock's Global Vault. One wallet
//       approval, and no Agama instruction in it
//   [4] inside the enclave: seal the position, transfer into the private
//       custody, credit private shares
//   [5] what each reader sees: owner, stranger, anonymous, and Solana itself
//   [6] the aggregate reaches Solana in one batched commit
//   [7] redeem half privately: the custody pays the ticket through MagicBlock's
//       queue, and the USDC lands in the wallet
//   [8] the program refuses what it should refuse
//   [9] the session key is lost: the wallet signs a message, a new key takes
//       over inside the enclave, and redeems the rest
//
//   npx tsx scripts/e2e-private.ts
import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createTransferInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  BASE_RPC,
  PROGRAM_ID,
  TEE_RPC,
  TEE_VALIDATOR,
  agyldMint,
  authedConnectionTo,
  erEndpointFor,
  exitsPda,
  loadCustodyKeypair,
  loadKeypair,
  positionPda,
  programFor,
  sendAndPoll,
  shieldedPda,
  sleep,
  usdcMint,
  vaultPda,
} from "./common";
import nacl from "tweetnacl";
import { ata, depositPrivateIxs, payExitIxs, randomGroupId, redeemPrivateIx, rotateSessionIxs, sessionMessage, shieldIxs } from "./private";

const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const DEPOSIT = 300_000_000n;
const usdc = (v: any) => (Number(v.toString()) / 1e6).toFixed(6);
const step = (n: string, m: string) => console.log(`\n${n} ${m}`);

async function anonRead(url: string, account: PublicKey) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [account.toBase58(), { encoding: "base64" }] }),
  });
  return ((await r.json()) as any)?.result?.value ?? null;
}

/// Program ids a transaction invoked at the top level. Raw RPC, because the
/// queue's payouts are version-1 transactions, which web3.js 1.x cannot decode.
async function programsIn(conn: Connection, sig: string): Promise<string[]> {
  for (let i = 0; i < 10; i++) {
    const r: any = await fetch(conn.rpcEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "getTransaction",
        params: [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 1 }],
      }),
    }).then((x) => x.json());
    const m = r?.result?.transaction?.message;
    if (m) return [...new Set<string>(m.instructions.map((ix: any) => m.accountKeys[ix.programIdIndex]))];
    await sleep(1500);
  }
  return [];
}

const NAMES: Record<string, string> = {
  [PROGRAM_ID.toBase58()]: "AGAMA",
  [EPHEMERAL_SPL_TOKEN_PROGRAM_ID.toBase58()]: "MagicBlock Ephemeral SPL Token",
  [TOKEN_PROGRAM_ID.toBase58()]: "SPL Token",
  [ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()]: "Associated Token",
  [SystemProgram.programId.toBase58()]: "System",
  DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh: "MagicBlock Delegation (commit)",
  noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV: "Noop",
};
const named = (ids: string[]) => ids.map((id) => NAMES[id] ?? id).join(", ");

/// Expect a TEE transaction to fail with one of `codes`, and say which.
let ERRORS: Record<number, string> = {};
async function refuses(what: string, conn: Connection, ixs: any[], signers: Keypair[], ...codes: string[]) {
  const r = await sendAndPoll(conn, new Transaction().add(...ixs), signers).then(
    () => "ACCEPTED",
    (e: any) => {
      const n = Number(/"Custom":(\d+)/.exec(String(e?.message))?.[1]);
      const name = ERRORS[n] ?? `error ${n || String(e?.message).slice(0, 60)}`;
      return codes.includes(name) ? `refused, ${name}` : `REFUSED FOR THE WRONG REASON: ${name}`;
    },
  );
  console.log(`       ${what.padEnd(44)} ${r}`);
  if (!r.startsWith("refused, ")) process.exitCode = 1;
}

async function main() {
  const funder = loadKeypair(); // vault authority, also the keeper
  const custody = loadCustodyKeypair(); // operator key that owns the private custody
  const wallet = Keypair.generate(); // the user's wallet: signs base-layer transactions only
  const session = Keypair.generate(); // browser-held, acts on the position inside the enclave
  const shieldKey = Keypair.generate(); // browser-held, one deposit, then empty
  const stranger = Keypair.generate();
  const base = new Connection(BASE_RPC, "confirmed");
  const p = programFor(base, wallet);
  ERRORS = Object.fromEntries(((p.idl as any).errors ?? []).map((e: any) => [e.code, e.name[0].toUpperCase() + e.name.slice(1)]));
  const position = positionPda(wallet.publicKey);
  const permission = PublicKey.findProgramAddressSync([Buffer.from("permission:"), position.toBuffer()], PERMISSION_PROGRAM_ID)[0];
  const claim = PublicKey.findProgramAddressSync([Buffer.from("faucet-claim"), wallet.publicKey.toBuffer()], PROGRAM_ID)[0];
  const pda = (tag: string, owner: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from(tag), position.toBuffer()], owner)[0];
  const decodeShielded = async () => {
    const info = await base.getAccountInfo(shieldedPda);
    return info ? (p.coder.accounts.decode("shielded", info.data) as any) : null;
  };

  console.log("wallet    ", wallet.publicKey.toBase58(), "(brand new)");
  console.log("session   ", session.publicKey.toBase58(), "(browser-held)");
  console.log("shield key", shieldKey.publicKey.toBase58(), "(browser-held, one deposit)");

  step("[1]", "fund the wallet and get test USDC");
  await sendAndPoll(base, new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: wallet.publicKey, lamports: 200_000_000 })), [funder]);
  await p.methods.faucet().accounts({
    user: wallet.publicKey, vault: vaultPda, claim, usdcMint, userUsdc: ata(wallet.publicKey),
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).rpc();
  const startUsdc = BigInt((await base.getTokenAccountBalance(ata(wallet.publicKey))).value.amount);
  console.log(`      wallet holds ${usdc(startUsdc)} USDC`);

  step("[2]", "open a private position (Solana learns it exists, nothing about its size)");
  const openSig = await sendAndPoll(base, new Transaction().add(
    await p.methods.initPosition().accounts({ owner: wallet.publicKey, vault: vaultPda, position, systemProgram: SystemProgram.programId }).instruction(),
    await p.methods.prepareForRollup().accounts({ owner: wallet.publicKey, position, ownerAgyld: null, agyldMint, vault: vaultPda, systemProgram: SystemProgram.programId }).instruction(),
    await p.methods.authorizeSession(session.publicKey).accounts({ owner: wallet.publicKey, position }).instruction(),
    await p.methods.delegatePosition().accounts({
      owner: wallet.publicKey,
      bufferPosition: pda("buffer", PROGRAM_ID),
      delegationRecordPosition: pda("delegation", DELEGATION_PROGRAM_ID),
      delegationMetadataPosition: pda("delegation-metadata", DELEGATION_PROGRAM_ID),
      position, validator: TEE_VALIDATOR, ownerProgram: PROGRAM_ID,
      delegationProgram: DELEGATION_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction(),
  ), [wallet]);
  console.log("      ", openSig);

  step("[3]", `shield ${usdc(DEPOSIT)} USDC: wallet -> throwaway key -> MagicBlock Global Vault`);
  const shieldSig = await sendAndPoll(base, new Transaction().add(...shieldIxs(wallet.publicKey, shieldKey.publicKey, DEPOSIT)), [wallet, shieldKey]);
  console.log("      ", shieldSig);
  console.log("       programs it touched:", named(await programsIn(base, shieldSig)));

  step("[4]", "inside the enclave: seal the position, deposit privately");
  let teeUrl: string | null = null;
  for (let i = 0; i < 15 && !teeUrl; i++) {
    await sleep(2000);
    teeUrl = await erEndpointFor(position).catch(() => null);
  }
  if (!teeUrl) throw new Error("the enclave never took the position");
  const teeS = await authedConnectionTo(teeUrl, session);
  const er = programFor(teeS, session);
  const teeK = await authedConnectionTo(TEE_RPC, shieldKey);
  for (let i = 0; i < 20; i++) {
    const b: any = await teeK.getTokenAccountBalance(ata(shieldKey.publicKey)).catch(() => null);
    if (b?.value?.amount === DEPOSIT.toString()) break;
    await sleep(2000);
  }
  const seal = await er.methods.initPermission([]).accounts({
    signer: session.publicKey, position, permission,
    permissionProgram: PERMISSION_PROGRAM_ID, ephemeralVault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID,
  }).instruction();
  console.log("       seal   ", await sendAndPoll(teeS, new Transaction().add(seal), [session]));

  // Refusals that need the funds still in the shield key, before the real deposit.
  const [transfer, credit] = await depositPrivateIxs(er, {
    shieldKey: shieldKey.publicKey, signer: session.publicKey, position, custodyOwner: custody.publicKey, amount: DEPOSIT,
  });
  const [, creditMore] = await depositPrivateIxs(er, {
    shieldKey: shieldKey.publicKey, signer: session.publicKey, position, custodyOwner: custody.publicKey, amount: DEPOSIT + 1n,
  });
  step("[8a]", "deposits the program must refuse");
  await refuses("credit with no transfer before it", teeS, [credit], [session, shieldKey], "TransferMismatch");
  await refuses("credit more than was transferred", teeS, [transfer, creditMore], [session, shieldKey], "TransferMismatch");
  // To an account that exists in the enclave, so the transfer itself succeeds
  // and it is the credit that has to catch it.
  const toElsewhere = createTransferInstruction(ata(shieldKey.publicKey), ata(shieldKey.publicKey), shieldKey.publicKey, DEPOSIT);
  await refuses("credit a transfer that went elsewhere", teeS, [toElsewhere, credit], [session, shieldKey], "TransferMismatch");
  await refuses("one transfer, credited twice", teeS, [transfer, credit, credit], [session, shieldKey], "TransferMismatch");

  console.log("\n       deposit", await sendAndPoll(teeS, new Transaction().add(transfer, credit), [session, shieldKey]));
  const pos: any = await er.account.position.fetch(position);
  console.log(`       private shares ${usdc(pos.privateShares)}  value ${usdc(pos.valueUsdc)}  entry ${usdc(pos.entryPrice)}  agYLD 0`);

  step("[5]", "who can see what");
  const strangerConn = await authedConnectionTo(teeUrl, stranger);
  const custodyAsStranger: any = await strangerConn.getTokenAccountBalance(ata(custody.publicKey)).catch(() => null);
  console.log(`       position, session key          ${(await teeS.getAccountInfo(position))?.data.length ?? 0} bytes`);
  console.log(`       position, stranger             ${(await strangerConn.getAccountInfo(position).catch(() => null)) ? "DATA" : "nothing"}`);
  console.log(`       position, anonymous            ${(await anonRead(teeUrl, position)) ? "DATA" : "nothing"}`);
  console.log(`       private aggregate, stranger    ${(await strangerConn.getAccountInfo(shieldedPda).catch(() => null)) ? "DATA" : "nothing"}`);
  console.log(`       exit book, stranger            ${(await strangerConn.getAccountInfo(exitsPda).catch(() => null)) ? "DATA" : "nothing"}`);
  console.log(`       custody balance, stranger      ${custodyAsStranger?.value?.decimals === 6 ? custodyAsStranger.value.amount : "masked"}`);
  const agyld = await base.getAccountInfo(getAssociatedTokenAddressSync(agyldMint, wallet.publicKey));
  const before = await decodeShielded();
  console.log(`       Solana: wallet agYLD account   ${agyld ? "EXISTS" : "none"}`);
  console.log(`       Solana: private aggregate      in=${usdc(before.totalIn)} (as of the last commit: this deposit is not in it)`);

  step("[6]", "the authority commits the aggregate: one batched number reaches Solana");
  const teeA = await authedConnectionTo(TEE_RPC, funder);
  const erA = programFor(teeA, funder);
  const commitTx = await erA.methods.commitShielded().accounts({ payer: funder.publicKey, vault: vaultPda, shielded: shieldedPda }).transaction();
  console.log("      ", await sendAndPoll(teeA, commitTx, [funder]));
  let after: any = before;
  for (let i = 0; i < 20 && after.totalIn.toString() === before.totalIn.toString(); i++) {
    await sleep(2000);
    after = await decodeShielded();
  }
  console.log(`       Solana: private aggregate      shares=${usdc(after.shares)} in=${usdc(after.totalIn)} out=${usdc(after.totalOut)}`);
  await refuses("a stranger commits the aggregate", strangerConn,
    [await erA.methods.commitShielded().accounts({ payer: stranger.publicKey, vault: vaultPda, shielded: shieldedPda }).instruction()],
    [stranger], "Unauthorized");

  step("[7]", "redeem half privately");
  const half = new BN(pos.privateShares.toString()).divn(2);
  const groupId = randomGroupId();
  const walletBefore = BigInt((await base.getTokenAccountBalance(ata(wallet.publicKey))).value.amount);
  const thief = Keypair.generate();
  const erThief = programFor(await authedConnectionTo(teeUrl, thief), thief);
  await refuses("someone else's session redeems it", teeS,
    [await redeemPrivateIx(erThief, { signer: thief.publicKey, position, shares: half, groupId })], [thief], "Unauthorized");
  console.log("       ticket ", await sendAndPoll(teeS, new Transaction().add(
    await redeemPrivateIx(er, { signer: session.publicKey, position, shares: half, groupId, minDelayMs: 0, maxDelayMs: 3000, split: 1 }),
  ), [session]));
  const book: any = await erA.account.exitBook.fetch(exitsPda);
  const exit = book.slots.find((e: any) => e.groupId === groupId);
  console.log(`       ticket as the keeper reads it: ${usdc(exit.assets)} USDC to ${exit.owner.toBase58().slice(0, 8)}…, delay 0-3 s`);

  step("[8b]", "settlements the program must refuse");
  const [, settleOnly] = await payExitIxs(erA, { exit, custodyOwner: custody.publicKey, authority: funder.publicKey });
  await refuses("close the ticket with no payment", teeA, [settleOnly], [funder], "PaymentMismatch", "TransferMismatch");
  const [short] = await payExitIxs(erA, { exit: { ...exit, assets: exit.assets.subn(1) }, custodyOwner: custody.publicKey, authority: funder.publicKey });
  await refuses("close it after paying one unit short", teeA, [short, settleOnly], [funder, custody], "PaymentMismatch");
  const [toThief] = await payExitIxs(erA, { exit: { ...exit, owner: thief.publicKey }, custodyOwner: custody.publicKey, authority: funder.publicKey });
  await refuses("close it after paying someone else", teeA, [toThief, settleOnly], [funder, custody], "PaymentMismatch");

  step("[7b]", "the keeper pays the ticket through MagicBlock's queue");
  // The running keeper pays tickets once they are EXIT_GRACE_S old. Without one,
  // after a minute, this pays it the same way.
  const open = async () => ((await erA.account.exitBook.fetch(exitsPda)) as any).slots.some((e: any) => e.groupId === groupId);
  let waited = 0;
  while ((await open()) && waited < 60) {
    await sleep(3000);
    waited += 3;
  }
  if (await open()) {
    const teeC = await authedConnectionTo(TEE_RPC, custody);
    const pay = await payExitIxs(erA, { exit, custodyOwner: custody.publicKey, authority: funder.publicKey });
    console.log("       no keeper running; paid here", await sendAndPoll(teeC, new Transaction().add(...pay), [custody, funder]));
  } else {
    console.log(`       the keeper paid it after ~${waited}s`);
  }
  let arrived = 0n;
  for (let i = 0; i < 60; i++) {
    const now = BigInt((await base.getTokenAccountBalance(ata(wallet.publicKey))).value.amount);
    if (now > walletBefore) {
      arrived = now - walletBefore;
      console.log(`       wallet received ${usdc(arrived)} USDC after ~${i * 2}s`);
      break;
    }
    await sleep(2000);
  }
  if (arrived === 0n) {
    console.log("       nothing arrived after 120s");
    process.exitCode = 1;
  }
  const sigs = await base.getSignaturesForAddress(ata(wallet.publicKey), { limit: 1 });
  if (sigs[0]) console.log("       the payment touched:", named(await programsIn(base, sigs[0].signature)));
  const left: any = await erA.account.exitBook.fetch(exitsPda);
  console.log(`       ticket ${left.slots.some((e: any) => e.groupId === groupId) ? "STILL OPEN" : "closed"}`);
  const pos2: any = await er.account.position.fetch(position);
  console.log(`       private shares ${usdc(pos2.privateShares)}  value ${usdc(pos2.valueUsdc)}`);

  step("[9]", "the session key is lost: the wallet signs one message, a new key takes over");
  const session2 = Keypair.generate();
  const teeS2 = await authedConnectionTo(teeUrl, session2);
  const er2 = programFor(teeS2, session2);
  const current: any = await er.account.position.fetch(position);
  const expiry = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  const sign = (k: Keypair, m: Buffer) => nacl.sign.detached(m, k.secretKey);
  const msg = sessionMessage(position, session2.publicKey, expiry);
  const forged = await rotateSessionIxs(er2, { owner: wallet.publicKey, position, submitter: session2.publicKey, sessionKey: session2.publicKey, expiry, signature: sign(stranger, msg), signedBy: stranger.publicKey });
  await refuses("a stranger's signature hands it over", teeS2, forged, [session2], "BadSessionRotation");
  const stale = Number(current.sessionExpiry.toString());
  const replay = await rotateSessionIxs(er2, { owner: wallet.publicKey, position, submitter: session2.publicKey, sessionKey: session2.publicKey, expiry: stale, signature: sign(wallet, sessionMessage(position, session2.publicKey, stale)) });
  await refuses("an expiry that does not move forward", teeS2, replay, [session2], "BadSessionRotation");
  const rotate = await rotateSessionIxs(er2, { owner: wallet.publicKey, position, submitter: session2.publicKey, sessionKey: session2.publicKey, expiry, signature: sign(wallet, msg) });
  console.log("       rotated", await sendAndPoll(teeS2, new Transaction().add(...rotate), [session2]));
  await refuses("the same signed message, replayed", teeS2, rotate, [session2], "BadSessionRotation");
  const asNew: any = await er2.account.position.fetch(position).catch(() => null);
  console.log(`       new key reads the ledger      ${asNew && !asNew.owner.equals(PublicKey.default) ? `yes, ${usdc(asNew.privateShares)} private shares` : "NO"}`);
  const oldReads = await teeS.getAccountInfo(position).catch(() => null);
  console.log(`       old key reads the ledger      ${oldReads && !new PublicKey(oldReads.data.subarray(8, 40)).equals(PublicKey.default) ? "STILL YES" : "no"}`);
  await refuses("the old key redeems", teeS,
    [await redeemPrivateIx(er, { signer: session.publicKey, position, shares: new BN(1), groupId: randomGroupId() })], [session], "Unauthorized");
  const rest = new BN(asNew.privateShares.toString());
  const before9 = BigInt((await base.getTokenAccountBalance(ata(wallet.publicKey))).value.amount);
  console.log("       new key redeems the rest", await sendAndPoll(teeS2, new Transaction().add(
    await redeemPrivateIx(er2, { signer: session2.publicKey, position, shares: rest, groupId: randomGroupId(), maxDelayMs: 3000 }),
  ), [session2]));
  for (let i = 0; i < 60; i++) {
    const now = BigInt((await base.getTokenAccountBalance(ata(wallet.publicKey))).value.amount);
    if (now > before9) { console.log(`       wallet received ${usdc(now - before9)} USDC`); break; }
    if (i === 59) { console.log("       nothing arrived"); process.exitCode = 1; }
    await sleep(3000);
  }
  console.log(`\nwallet USDC  ${usdc(startUsdc)} -> ${usdc(BigInt((await base.getTokenAccountBalance(ata(wallet.publicKey))).value.amount))}, agYLD never minted`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
