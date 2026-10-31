// The Agama keeper, MagicBlock edition.
//
// On Starknet and Stellar this process pokes an `accrue` entrypoint every few
// blocks and pays gas for it. Here it ticks the book on the rollup, where a tick
// is free and lands in ~10 ms, then commits the marked NAV back to Solana on a
// much slower cadence, because the commit is the only part that costs anything.
//
//   tick    free, ER-only, every TICK_MS
//   absorb  ER-only, when Solana has taken deposits the book has not marked yet
//   commit  paid, base-layer settlement, every COMMIT_EVERY ticks
//
// The base-layer read that drives `absorb` happens *here*, not by handing the
// rollup a Solana account. A read-only clone of an account that keeps changing on
// Solana has to be re-cloned on every deposit, and a re-clone in flight fails the
// whole transaction with `Failed to clone regular account ... InsufficientFundsForRent`.
// Keeping the cross-layer read off-chain means a deposit never stalls the tick.
import { Connection } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { BASE_RPC, authedConnectionTo, bookPda, delegationStatus, erEndpointFor, loadKeypair, programFor, sendAndPoll, vaultPda, sleep } from "./common";
import { COMMIT_LIMIT, recycleBook } from "./recycle";
import { PrivateKeeper, committedShielded } from "./private-keeper";

const TICK_MS = Number(process.env.TICK_MS ?? 1000);
// A delegation sponsors 10 commits. Past that every commit fails with "sponsored
// commit limit exceeded", so the keeper recycles the delegation (undelegate, which
// commits, then delegate again) instead of letting Solana's NAV go stale.
const COMMIT_EVERY = Number(process.env.COMMIT_EVERY ?? 600);
// Absorption is a treasury action, not a per-deposit one; checking every 15 s is
// plenty and keeps the base-layer read rate low.
const ABSORB_EVERY = Number(process.env.ABSORB_EVERY ?? 15);

const usdc = (v: any) => (Number(v.toString()) / 1e6).toFixed(6);

async function main() {
  const wallet = loadKeypair();
  // A recycle cut off halfway leaves the book on Solana; finish it first, or
  // there is no rollup to tick on.
  if (!(await delegationStatus(bookPda))?.isDelegated) {
    console.log("book is not delegated, finishing the recycle");
    await recycleBook((...a: any[]) => console.log("recycle ", ...a));
  }
  const erUrl = await erEndpointFor(bookPda);
  console.log("book     ", bookPda.toBase58());
  console.log("ER       ", erUrl);
  console.log(`tick ${TICK_MS}ms · absorb every ${ABSORB_EVERY} ticks · commit every ${COMMIT_EVERY}\n`);

  const base = programFor(new Connection(BASE_RPC, "confirmed"), wallet);
  let erConn = await authedConnectionTo(erUrl, wallet);
  let er = programFor(erConn, wallet);

  // The keeper cannot read a delegation's commit nonce, so it counts its own and
  // also treats the limit error as a signal, which covers a restart mid-session.
  let commits = 0;
  const recycle = async () => {
    await recycleBook((...a: any[]) => console.log("recycle ", ...a));
    erConn = await authedConnectionTo(await erEndpointFor(bookPda), wallet);
    er = programFor(erConn, wallet);
    commits = 0;
  };

  // The private side: batched commits of the aggregate, and paying exit tickets.
  // Its failures are logged and retried without stopping the book.
  const priv = new PrivateKeeper();
  await priv.connect();
  await priv.heal();

  let n = 0;
  let privAt = 0;
  let lastTicks = -1;
  let stalled = 0;
  for (;;) {
    try {
      // Deploy anything Solana has taken in that the book has not marked yet.
      //
      // Both custodies count. The private one only as of its last commit, never
      // its live state: that is all Solana can check `marked_in` against, so a
      // book that absorbed a private deposit Solana has not seen yet would trip
      // `BookAheadOfVault` on every public deposit until the next commit.
      if (n % ABSORB_EVERY === 0) {
        const [vault, book, shielded]: any[] = await Promise.all([
          base.account.vault.fetch(vaultPda),
          er.account.poolBook.fetch(bookPda),
          committedShielded(base),
        ]);
        const totalIn = vault.totalIn.add(shielded?.totalIn ?? new BN(0));
        const totalOut = vault.totalOut.add(shielded?.totalOut ?? new BN(0));
        const inflow = BN.max(totalIn.sub(book.markedIn), new BN(0));
        const outflow = BN.max(totalOut.sub(book.markedOut), new BN(0));
        if (!inflow.isZero() || !outflow.isZero()) {
          const sig = await er.methods
            .absorb(inflow, outflow)
            .accounts({ authority: wallet.publicKey, book: bookPda })
            .rpc({ skipPreflight: true });
          console.log(`absorb  +${usdc(inflow)} / -${usdc(outflow)} USDC  ${sig}`);
        }
      }

      // Fire and forget. `.rpc()` waits for a websocket confirmation the rollup's
      // proxy does not relay, so it threw `Unknown action 'undefined'` on ticks
      // that had landed, and the loop stalled on them. A tick is idempotent and
      // the next one catches up, so there is nothing to wait for.
      const tickTx = await er.methods.tick().accounts({ payer: wallet.publicKey, book: bookPda }).transaction();
      tickTx.feePayer = wallet.publicKey;
      tickTx.recentBlockhash = (await erConn.getLatestBlockhash("confirmed")).blockhash;
      tickTx.sign(wallet);
      await erConn.sendRawTransaction(tickTx.serialize(), { skipPreflight: true });
      n++;

      if (n % 25 === 0) {
        const book: any = await er.account.poolBook.fetch(bookPda);
        // Ticks are sent without waiting, so a rollup that stops accepting them
        // would otherwise go unnoticed. Two reads in a row with no progress is a
        // stall worth shouting about (see migrate-book.ts for the one we hit).
        const t = Number(book.ticks.toString());
        stalled = t === lastTicks ? stalled + 1 : 0;
        lastTicks = t;
        if (stalled >= 2) console.error(`STALL: the book has not ticked for ${stalled * 25} sends; the rollup may have lost its delegation`);
        console.log(
          `tick ${n}  nav=${usdc(book.nav)} USDC  ticks=${book.ticks}  marked_in=${usdc(book.markedIn)}`,
        );
      }

      if (n % COMMIT_EVERY === 0) {
        if (commits >= COMMIT_LIMIT) {
          await recycle();
        } else {
          const tx = await er.methods.commitBook().accounts({ payer: wallet.publicKey, book: bookPda }).transaction();
          try {
            console.log(`commit @ tick ${n}  ${await sendAndPoll(erConn, tx, [wallet])}`);
            commits++;
          } catch (e: any) {
            // 0xa0000000: the sponsored commit limit, the only commit failure that
            // a fresh delegation fixes.
            if (!String(e?.message).includes('"Custom":2684354560')) throw e;
            console.log(`commit @ tick ${n}  limit reached, recycling the delegation`);
            await recycle();
          }
        }
      }
    } catch (e: any) {
      const msg = (e?.message ?? String(e)).split("\n")[0];
      console.error("tick failed:", msg);
      if (msg.includes("is not delegated")) {
        // A recycle that did not finish. Finish it rather than failing forever.
        try {
          await recycle();
        } catch (r: any) {
          console.error("recycle failed:", String(r?.message ?? r).split("\n")[0]);
        }
      }
      await sleep(2000);
    }
    // On its own clock, so a run of failed ticks never holds up paying an exit.
    try {
      await priv.step(++privAt);
    } catch (e: any) {
      console.error("private step failed:", (e?.message ?? String(e)).split("\n")[0]);
    }
    await sleep(TICK_MS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
