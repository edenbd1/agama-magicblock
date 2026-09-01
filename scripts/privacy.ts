// The full private-position walk, and then the part that actually proves anything:
// reading the account back as somebody who is not on the permission.
//
//   1. init_position      base    open the ledger, pre-fund its permission rent
//   2. delegate_position  base    hand it to the privacy validator
//   3. read (ungated)     rollup  anyone can see it
//   4. init_permission    rollup  gate it to the owner (+ any viewers)
//   5. read (gated)       rollup  a stranger cannot
//   6. sync_position      rollup  mark it inside the enclave
//
// On devnet steps 4 to 6 need a TEE write token. Locally the query-filtering
// service stands in, which exercises the same permission logic without the
// hardware attestation.
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  BASE_RPC,
  ER_RPC_OVERRIDE,
  IS_LOCAL,
  LOCALNET_VALIDATOR,
  PROGRAM_ID,
  TEE_VALIDATOR,
  agyldMint,
  bookPda,
  authedConnectionTo,
  sendAndPoll,
  delegationStatus,
  erEndpointFor,
  loadKeypair,
  positionPda,
  programFor,
  sleep,
  vaultPda,
} from "./common";

const PRIVACY_VALIDATOR = IS_LOCAL ? LOCALNET_VALIDATOR : TEE_VALIDATOR;
const PERMISSION_PROGRAM_ID = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
const EPHEMERAL_VAULT_ID = new PublicKey("MagicVau1t999999999999999999999999999999999");
const MAGIC_PROGRAM_ID = new PublicKey("Magic11111111111111111111111111111111111111");

const usdc = (v: any) => (Number(v.toString()) / 1e6).toFixed(6);
const ata = (mint: PublicKey, owner: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [
      owner.toBuffer(),
      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(),
      mint.toBuffer(),
    ],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
  )[0];

/// Raw JSON-RPC, deliberately unauthenticated: this is what a stranger sees.
async function rawRead(url: string, account: PublicKey) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [account.toBase58(), { encoding: "base64" }],
    }),
  });
  return res.json();
}

async function main() {
  const wallet = loadKeypair();
  const me = wallet.publicKey;
  const base = new Connection(BASE_RPC, "confirmed");
  const p = programFor(base, wallet);
  const position = positionPda(me);
  const permission = PublicKey.findProgramAddressSync(
    // PERMISSION_SEED is b"permission:", the colon is part of the seed.
    [Buffer.from("permission:"), position.toBuffer()],
    PERMISSION_PROGRAM_ID,
  )[0];

  console.log("owner     ", me.toBase58());
  console.log("position  ", position.toBase58());
  console.log("permission", permission.toBase58());
  console.log("validator ", PRIVACY_VALIDATOR.toBase58(), IS_LOCAL ? "(local stand-in)" : "(TEE)");

  // 1. Open the ledger.
  if (await base.getAccountInfo(position)) {
    console.log("\n[1] ledger already open");
  } else {
    const sig = await p.methods
      .initPosition()
      .accounts({ owner: me, vault: vaultPda, position, systemProgram: SystemProgram.programId })
      .rpc();
    console.log("\n[1] init_position    ", sig);
  }

  // 2. Delegate it.
  const before = await delegationStatus(position);
  if (before?.isDelegated) {
    console.log("[2] already delegated");
  } else {
    const sig = await p.methods
      .delegatePosition()
      .accounts({ owner: me, position, validator: PRIVACY_VALIDATOR })
      .rpc();
    console.log("[2] delegate_position", sig);
    await sleep(3000);
  }

  const erUrl = await erEndpointFor(position);
  // Writes to a private rollup need a QFS token; reads do not.
  const erConn = await authedConnectionTo(erUrl, wallet);
  const er = programFor(erConn, wallet);
  console.log("    rollup:", erUrl);

  // 3. What a stranger sees before the gate goes up.
  const openRead: any = await rawRead(erUrl, position);
  console.log(
    "\n[3] unauthenticated read, before gating:",
    openRead?.result?.value ? `${openRead.result.value.data[0].length} bytes of data` : "no data",
  );

  // 4. Gate it. Empty viewer list = owner only.
  const sig4 = await sendAndPoll(
    erConn,
    await er.methods
      .initPermission([])
      .accounts({
        owner: me,
        position,
        permission,
        permissionProgram: PERMISSION_PROGRAM_ID,
        ephemeralVault: EPHEMERAL_VAULT_ID,
        magicProgram: MAGIC_PROGRAM_ID,
      })
      .transaction(),
    [wallet],
  );
  console.log("[4] init_permission  ", sig4);
  await sleep(2000);

  // 5. What a stranger sees after.
  const gatedRead: any = await rawRead(erUrl, position);
  console.log(
    "[5] unauthenticated read, after gating: ",
    gatedRead?.result?.value
      ? `${gatedRead.result.value.data[0].length} bytes of data  <- STILL VISIBLE`
      : JSON.stringify(gatedRead?.result ?? gatedRead?.error ?? gatedRead),
  );

  // 6. Mark it from inside.
  const sig6 = await sendAndPoll(
    erConn,
    await er.methods
      .syncPosition()
      .accounts({
        owner: me,
        position,
        vault: vaultPda,
        book: bookPda,
        ownerAgyld: ata(agyldMint, me),
      })
      .transaction(),
    [wallet],
  );
  console.log("[6] sync_position    ", sig6);
  await sleep(2000);

  // 7. The three readers, side by side. This is the actual claim.
  //
  //    A token only proves which pubkey you are. Whether the rollup then shows you
  //    the account is decided by the on-chain permission member list, so a
  //    perfectly valid token minted for the wrong pubkey still sees nothing.
  const stranger = Keypair.generate();
  const strangerConn = await authedConnectionTo(erUrl, stranger);

  const asOwner = await erConn.getAccountInfo(position);
  const asStranger = await strangerConn.getAccountInfo(position).catch(() => null);
  const asAnon: any = await rawRead(erUrl, position);

  console.log("\n[7] who can read the ledger on the rollup");
  console.log(`      owner (member)          ${asOwner ? `${asOwner.data.length} bytes` : "nothing"}`);
  console.log(`      stranger (valid token)  ${asStranger ? `${asStranger.data.length} bytes` : "nothing"}`);
  console.log(`      anonymous (no token)    ${asAnon?.result?.value ? "data" : "nothing"}`);

  const pos: any = await er.account.position.fetch(position);
  console.log(
    `\nposition  shares=${usdc(pos.shares)}  value=${usdc(pos.valueUsdc)}  ` +
      `basis=${usdc(pos.costBasis)}  yield=${usdc(pos.yieldUsdc)}  ` +
      `entry=${usdc(pos.entryPrice)}  syncs=${pos.syncs}  private=${pos.isPrivate}`,
  );
}

main().catch((e) => {
  console.error("ERROR:", e?.message ?? e);
  if (e?.logs) console.error(e.logs.join("\n"));
  if (e?.stack) console.error(e.stack.split("\n").slice(0, 8).join("\n"));
  process.exit(1);
});
