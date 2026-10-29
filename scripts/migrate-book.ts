// Move the lending book to its current PDA when a rollup has lost track of the
// old one's delegation (it refuses every write with "illegally used as
// writable" and "required to be delegated to the current validator", while the
// delegation program still says it is delegated there).
//
//   1. migrate_book: copy the legacy book's last committed state into the new PDA
//   2. fund the new book's clone rent, delegate it to the public rollup
//   3. prove the rollup now accepts a write: one tick, polled to confirmation
//
//   npx tsx scripts/migrate-book.ts      (stop the keeper first)
import { Connection, SystemProgram, Transaction } from "@solana/web3.js";
import {
  BASE_RPC,
  ER_VALIDATOR,
  authedConnectionTo,
  bookPda,
  delegationStatus,
  erEndpointFor,
  legacyBookPda,
  loadKeypair,
  programFor,
  sendAndPoll,
  sleep,
  vaultPda,
} from "./common";

const CLONE_RENT_FLOOR = 20_000_000;

async function main() {
  const wallet = loadKeypair();
  const base = new Connection(BASE_RPC, "confirmed");
  const program = programFor(base, wallet);

  if (!(await base.getAccountInfo(bookPda))) {
    const tx = await program.methods.migrateBook()
      .accounts({ authority: wallet.publicKey, vault: vaultPda, legacyBook: legacyBookPda, book: bookPda, systemProgram: SystemProgram.programId })
      .transaction();
    console.log("migrate  ", await sendAndPoll(base, tx, [wallet]));
  }
  const copy: any = await program.account.poolBook.fetch(bookPda).catch(() => null);
  if (copy) console.log(`copied    nav=${(Number(copy.nav) / 1e6).toFixed(6)} marked_in=${(Number(copy.markedIn) / 1e6).toFixed(6)} ticks=${copy.ticks}`);

  const have = (await base.getAccountInfo(bookPda))?.lamports ?? 0;
  if (have < CLONE_RENT_FLOOR) {
    const fund = new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: bookPda, lamports: CLONE_RENT_FLOOR - have }));
    console.log("clone rent", await sendAndPoll(base, fund, [wallet]));
  }
  if (!(await delegationStatus(bookPda))?.isDelegated) {
    const del = await program.methods.delegateBook()
      .accounts({ payer: wallet.publicKey, vault: vaultPda, book: bookPda, validator: ER_VALIDATOR })
      .transaction();
    console.log("delegate ", await sendAndPoll(base, del, [wallet]));
  }
  for (let i = 0; i < 30 && !(await delegationStatus(bookPda))?.isDelegated; i++) await sleep(2000);
  const url = await erEndpointFor(bookPda);
  const conn = await authedConnectionTo(url, wallet);
  const er = programFor(conn, wallet);
  await sleep(3000);
  const tick = await er.methods.tick().accounts({ payer: wallet.publicKey, book: bookPda }).transaction();
  console.log("tick     ", await sendAndPoll(conn, tick, [wallet]), "on", url);
  const live: any = await er.account.poolBook.fetch(bookPda);
  console.log(`live      nav=${(Number(live.nav) / 1e6).toFixed(6)} ticks=${live.ticks}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
