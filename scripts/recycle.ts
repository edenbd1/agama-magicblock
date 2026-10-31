// Close the book's rollup session and open a fresh one.
//
// A delegation sponsors exactly 10 commits. The 11th fails on the rollup with
//
//   ScheduleCommit ERR: sponsored commit limit exceeded for account <book>:
//   current commit nonce 10 reached the limit of 10. Undelegate and re-delegate
//   the account or use a delegated account as the payer
//
// and from then on Solana keeps pricing deposits and redemptions on the last
// committed NAV while the rollup ticks on without it. Undelegating commits the
// current marks on the way out, so the cycle is also the commit.
//
//   npx tsx scripts/recycle.ts        (stop the keeper first, it holds the book)
import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  BASE_RPC,
  ER_VALIDATOR,
  PROGRAM_ID,
  authedConnectionTo,
  bookPda,
  delegationStatus,
  erEndpointFor,
  loadKeypair,
  programFor,
  sendAndPoll,
  sleep,
  vaultPda,
} from "./common";

const CLONE_RENT_FLOOR = 20_000_000; // same floor as setup.ts

export const COMMIT_LIMIT = 10;

export async function recycleBook(log = console.log): Promise<void> {
  const wallet = loadKeypair();
  const baseConn = new Connection(BASE_RPC, "confirmed");
  const base = programFor(baseConn, wallet);

  // Every step checks where the book actually is before acting, so a recycle
  // cut off halfway (on 30 Oct a network drop stopped one between undelegate
  // and delegate) finishes on the next call instead of failing at step 1
  // forever on a book that is no longer delegated.

  // 1. Commit and undelegate, from the rollup, if it is still delegated.
  if ((await delegationStatus(bookPda))?.isDelegated) {
    const erUrl = await erEndpointFor(bookPda);
    const erConn = await authedConnectionTo(erUrl, wallet);
    const er = programFor(erConn, wallet);
    const tx = await er.methods.undelegateBook().accounts({ payer: wallet.publicKey, book: bookPda }).transaction();
    log("undelegate", await sendAndPoll(erConn, tx, [wallet]));
  } else {
    log("already undelegated, resuming");
  }

  // 2. Wait for the book to land back on Solana, owned by the program again.
  for (let i = 0; ; i++) {
    const info = await baseConn.getAccountInfo(bookPda);
    if (info?.owner.equals(PROGRAM_ID)) break;
    if (i >= 60) throw new Error("book did not return to Solana within 120s");
    await sleep(2000);
  }
  const b: any = await base.account.poolBook.fetch(bookPda);
  log(`book back on Solana  nav=${(Number(b.nav.toString()) / 1e6).toFixed(6)}  ticks=${b.ticks}`);

  // 3. Clone rent, then a fresh delegation with a fresh commit budget.
  for (const account of [vaultPda, bookPda] as PublicKey[]) {
    const have = (await baseConn.getAccountInfo(account))?.lamports ?? 0;
    if (have >= CLONE_RENT_FLOOR) continue;
    const fund = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: account, lamports: CLONE_RENT_FLOOR - have }),
    );
    log("top up", account.toBase58(), await sendAndPoll(baseConn, fund, [wallet]));
  }
  if (!(await delegationStatus(bookPda))?.isDelegated) {
  const del = await base.methods
    .delegateBook()
    .accounts({ payer: wallet.publicKey, vault: vaultPda, book: bookPda, validator: ER_VALIDATOR })
    .transaction();
  log("delegate", await sendAndPoll(baseConn, del, [wallet]));
  }

  for (let i = 0; i < 30; i++) {
    const st = await delegationStatus(bookPda);
    if (st?.isDelegated) {
      log("delegated to", st.fqdn);
      break;
    }
    if (i === 29) throw new Error("router does not see the book as delegated after 60s");
    await sleep(2000);
  }

  // The router saying "delegated" is not the rollup accepting writes. On 29 Oct
  // the EU rollup kept answering "required to be delegated to the current
  // validator" for a book the delegation program said was delegated to it, and
  // every tick after that failed quietly. So prove it with one tick.
  const url = await erEndpointFor(bookPda);
  const conn = await authedConnectionTo(url, wallet);
  const er2 = programFor(conn, wallet);
  for (let i = 0; ; i++) {
    try {
      const tick = await er2.methods.tick().accounts({ payer: wallet.publicKey, book: bookPda }).transaction();
      log("first tick", await sendAndPoll(conn, tick, [wallet]));
      return;
    } catch (e: any) {
      if (i >= 10) throw new Error(`the rollup will not write the re-delegated book (${String(e?.message).slice(0, 120)}); see migrate-book.ts`);
      await sleep(3000);
    }
  }
}

if (require.main === module) {
  recycleBook().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
