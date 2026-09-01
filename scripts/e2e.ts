// The journey the app actually puts a user through, from a keypair that has never
// existed. This mirrors the UI's private-deposit flow instruction for instruction,
// which is the point: the risk it is testing is whether the batched Solana leg
// still fits in a transaction, and whether the enclave leg works right after it.
//
//   1 base tx     deposit + open ledger + pay clone rent + authorise a session
//                 key + delegate. The wallet signs this and nothing else.
//   0 wallet      everything on the rollup is signed by the session key, because
//                 wallets refuse Ephemeral Rollup transactions outright.
//   1 rollup tx   gate the ledger + mark it
//
// Then it reads the ledger back three ways, which is the claim.
import { BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  BASE_RPC,
  IS_LOCAL,
  LOCALNET_VALIDATOR,
  PROGRAM_ID,
  TEE_VALIDATOR,
  agyldMint,
  authedConnectionTo,
  bookPda,
  erEndpointFor,
  loadKeypair,
  positionPda,
  programFor,
  sendAndPoll,
  sleep,
  usdcMint,
  vaultPda,
} from "./common";

const PERMISSION_PROGRAM_ID = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const EPHEMERAL_VAULT_ID = new PublicKey("MagicVau1t999999999999999999999999999999999");
const MAGIC_PROGRAM_ID = new PublicKey("Magic11111111111111111111111111111111111111");
const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const PRIVACY_VALIDATOR = IS_LOCAL ? LOCALNET_VALIDATOR : TEE_VALIDATOR;
const DEPOSIT = new BN(250_000_000);
/// Stands in for the keypair a browser would keep in localStorage.
const SESSION = Keypair.generate();

const usdc = (v: any) => (Number(v.toString()) / 1e6).toFixed(6);
const step = (n: string, m: string) => console.log(`\n${n} ${m}`);

async function rawRead(url: string, account: PublicKey) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [account.toBase58(), { encoding: "base64" }],
    }),
  });
  return r.json();
}

async function main() {
  const funder = loadKeypair();
  const user = Keypair.generate();
  const base = new Connection(BASE_RPC, "confirmed");
  const p = programFor(base, user);

  const userUsdc = getAssociatedTokenAddressSync(usdcMint, user.publicKey);
  const userAgyld = getAssociatedTokenAddressSync(agyldMint, user.publicKey);
  const vaultUsdc = getAssociatedTokenAddressSync(usdcMint, vaultPda, true);
  const position = positionPda(user.publicKey);
  const claim = PublicKey.findProgramAddressSync(
    [Buffer.from("faucet-claim"), user.publicKey.toBuffer()],
    PROGRAM_ID,
  )[0];
  const permission = PublicKey.findProgramAddressSync(
    [Buffer.from("permission:"), position.toBuffer()],
    PERMISSION_PROGRAM_ID,
  )[0];
  const pda = (tag: string, owner: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from(tag), position.toBuffer()], owner)[0];

  console.log("funder ", funder.publicKey.toBase58());
  console.log("user   ", user.publicKey.toBase58(), "(brand new)");

  step("[1]", "fund the wallet and get test USDC");
  await sendAndPoll(
    base,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: funder.publicKey,
        toPubkey: user.publicKey,
        lamports: 200_000_000,
      }),
    ),
    [funder],
  );
  await p.methods
    .faucet()
    .accounts({
      user: user.publicKey,
      vault: vaultPda,
      claim,
      usdcMint,
      userUsdc,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  // The whole Solana leg, exactly as the app bundles it.
  console.log("session", SESSION.publicKey.toBase58(), "(browser-held)");
  step("[2]", `one transaction: deposit ${usdc(DEPOSIT)} USDC + open + fund + authorise + delegate`);
  const ixs: TransactionInstruction[] = [
    await p.methods
      .deposit(DEPOSIT)
      .accounts({
        user: user.publicKey,
        vault: vaultPda,
        book: bookPda,
        usdcMint,
        agyldMint,
        userUsdc,
        userAgyld,
        vaultUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    await p.methods
      .initPosition()
      .accounts({
        owner: user.publicKey,
        vault: vaultPda,
        position,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    await p.methods
      .prepareForRollup()
      .accounts({
        owner: user.publicKey,
        position,
        ownerAgyld: userAgyld,
        agyldMint,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
    await p.methods
      .authorizeSession(SESSION.publicKey)
      .accounts({ owner: user.publicKey, position })
      .instruction(),
    await p.methods
      .delegatePosition()
      .accounts({
        owner: user.publicKey,
        bufferPosition: pda("buffer", PROGRAM_ID),
        delegationRecordPosition: pda("delegation", DELEGATION_PROGRAM_ID),
        delegationMetadataPosition: pda("delegation-metadata", DELEGATION_PROGRAM_ID),
        position,
        validator: PRIVACY_VALIDATOR,
        ownerProgram: PROGRAM_ID,
        delegationProgram: DELEGATION_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction(),
  ];

  const tx = new Transaction().add(...ixs);
  tx.feePayer = user.publicKey;
  tx.recentBlockhash = (await base.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(user);
  const size = tx.serialize().length;
  console.log(`      ${ixs.length} instructions, ${size} bytes of a 1232 byte limit`);
  const baseSig = await base.sendRawTransaction(tx.serialize());
  await base.confirmTransaction(baseSig, "confirmed");
  console.log("      ", baseSig);
  console.log("      holds", (await base.getTokenAccountBalance(userAgyld)).value.uiAmountString, "agYLD");

  step("[3]", "wait for Solana to hand the ledger to the enclave");
  let erUrl: string | null = null;
  for (let i = 0; i < 12 && !erUrl; i++) {
    await sleep(2500);
    erUrl = await erEndpointFor(position).catch(() => null);
  }
  if (!erUrl) throw new Error("the rollup never took the ledger");
  console.log("      ", erUrl);

  step("[4]", "the session key signs in and seals, with no wallet involved");
  const erConn = await authedConnectionTo(erUrl, SESSION);
  const er = programFor(erConn, SESSION);
  const permissionAccounts = {
    signer: SESSION.publicKey,
    position,
    permission,
    permissionProgram: PERMISSION_PROGRAM_ID,
    ephemeralVault: EPHEMERAL_VAULT_ID,
    magicProgram: MAGIC_PROGRAM_ID,
  };
  const erTx = new Transaction().add(
    await er.methods.initPermission([]).accounts(permissionAccounts).instruction(),
    await er.methods
      .syncPosition()
      .accounts({
        signer: SESSION.publicKey,
        position,
        owner: user.publicKey,
        vault: vaultPda,
        book: bookPda,
        ownerAgyld: userAgyld,
      })
      .instruction(),
  );
  console.log("      ", await sendAndPoll(erConn, erTx, [SESSION]));

  step("[5]", "who can read the ledger");
  const stranger = Keypair.generate();
  const strangerConn = await authedConnectionTo(erUrl, stranger);
  const asOwner = await erConn.getAccountInfo(position);
  const asStranger = await strangerConn.getAccountInfo(position).catch(() => null);
  const asAnon: any = await rawRead(erUrl, position);
  console.log(`       session key (a member)    ${asOwner ? `${asOwner.data.length} bytes` : "nothing"}`);
  console.log(`       stranger (valid login)    ${asStranger ? `${asStranger.data.length} bytes` : "nothing"}`);
  console.log(`       anonymous (no login)      ${asAnon?.result?.value ? "data" : "nothing"}`);

  const pos: any = await er.account.position.fetch(position);
  console.log(
    `\nposition  shares=${usdc(pos.shares)}  value=${usdc(pos.valueUsdc)}  ` +
      `basis=${usdc(pos.costBasis)}  yield=${usdc(pos.yieldUsdc)}  ` +
      `entry=${usdc(pos.entryPrice)}  private=${pos.isPrivate}`,
  );

  step("[6]", "a second deposit needs no setup at all");
  const before = await base.getTokenAccountBalance(userAgyld);
  const sig2 = await p.methods
    .deposit(new BN(100_000_000))
    .accounts({
      user: user.publicKey,
      vault: vaultPda,
      book: bookPda,
      usdcMint,
      agyldMint,
      userUsdc,
      userAgyld,
      vaultUsdc,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  const after = await base.getTokenAccountBalance(userAgyld);
  console.log(`      1 transaction, ${before.value.uiAmountString} -> ${after.value.uiAmountString} agYLD`);
  console.log("      ", sig2);

  console.log("\nagYLD stays a public SPL balance. The ledger above does not.");
}

main().catch((e) => {
  console.error("ERROR:", e?.message ?? e);
  if (e?.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
