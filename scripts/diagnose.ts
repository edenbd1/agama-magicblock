// Where is everything, and does the rollup agree?
//
// For each delegated account: what the router says, what Solana says (owner,
// delegation record), and for the book, whether the rollup accepts a tick. The
// two failures this was written for: a rollup that has lost a delegation Solana
// still records (README #9), and a recycle cut off halfway, leaving an account
// back on Solana and nothing ticking.
//
//   npx tsx scripts/diagnose.ts
import { Connection, PublicKey } from "@solana/web3.js";
import {
  BASE_RPC,
  authedConnectionTo,
  bookPda,
  delegationStatus,
  erEndpointFor,
  exitsPda,
  loadKeypair,
  programFor,
  sendAndPoll,
  shieldedPda,
} from "./common";

const DLP = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

(async () => {
  const base = new Connection(BASE_RPC, "confirmed");
  for (const [name, account] of [["book", bookPda], ["shielded", shieldedPda], ["exits", exitsPda]] as [string, PublicKey][]) {
    const status = await delegationStatus(account);
    const info = await base.getAccountInfo(account);
    const record = await base.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("delegation"), account.toBuffer()], DLP)[0]);
    console.log(
      `${name.padEnd(9)} router=${status?.isDelegated ? status.fqdn : "not delegated"}  ` +
        `solana owner=${info?.owner.toBase58().slice(0, 8) ?? "none"}  record=${record ? new PublicKey(record.data.subarray(8, 40)).toBase58().slice(0, 8) : "none"}`,
    );
  }
  const wallet = loadKeypair();
  try {
    const conn = await authedConnectionTo(await erEndpointFor(bookPda), wallet);
    const er = programFor(conn, wallet);
    const tx = await er.methods.tick().accounts({ payer: wallet.publicKey, book: bookPda }).transaction();
    console.log("tick      accepted", await sendAndPoll(conn, tx, [wallet]));
    const b: any = await er.account.poolBook.fetch(bookPda);
    console.log(`book      nav=${(Number(b.nav) / 1e6).toFixed(6)} ticks=${b.ticks}`);
  } catch (e: any) {
    console.log("tick      REFUSED:", String(e?.message ?? e).slice(0, 160));
  }
})();
