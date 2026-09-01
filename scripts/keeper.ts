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
import { BASE_RPC, authedConnectionTo, bookPda, erEndpointFor, loadKeypair, programFor, vaultPda, sleep } from "./common";

const TICK_MS = Number(process.env.TICK_MS ?? 1000);
// The validator accepts 10 plain commits per delegation before the fee-vault path
// is required, so keep this slow on devnet and close the session by re-delegating.
const COMMIT_EVERY = Number(process.env.COMMIT_EVERY ?? 600);
// Absorption is a treasury action, not a per-deposit one; checking every 15 s is
// plenty and keeps the base-layer read rate low.
const ABSORB_EVERY = Number(process.env.ABSORB_EVERY ?? 15);

const usdc = (v: any) => (Number(v.toString()) / 1e6).toFixed(6);

async function main() {
  const wallet = loadKeypair();
  const erUrl = await erEndpointFor(bookPda);
  console.log("book     ", bookPda.toBase58());
  console.log("ER       ", erUrl);
  console.log(`tick ${TICK_MS}ms · absorb every ${ABSORB_EVERY} ticks · commit every ${COMMIT_EVERY}\n`);

  const base = programFor(new Connection(BASE_RPC, "confirmed"), wallet);
  const er = programFor(await authedConnectionTo(erUrl, wallet), wallet);

  let n = 0;
  for (;;) {
    try {
      // Deploy anything Solana has taken in that the book has not marked yet.
      if (n % ABSORB_EVERY === 0) {
        const [vault, book]: any[] = await Promise.all([
          base.account.vault.fetch(vaultPda),
          er.account.poolBook.fetch(bookPda),
        ]);
        const inflow = BN.max(vault.totalIn.sub(book.markedIn), new BN(0));
        const outflow = BN.max(vault.totalOut.sub(book.markedOut), new BN(0));
        if (!inflow.isZero() || !outflow.isZero()) {
          const sig = await er.methods
            .absorb(inflow, outflow)
            .accounts({ authority: wallet.publicKey, book: bookPda })
            .rpc({ skipPreflight: true });
          console.log(`absorb  +${usdc(inflow)} / -${usdc(outflow)} USDC  ${sig}`);
        }
      }

      await er.methods
        .tick()
        .accounts({ payer: wallet.publicKey, book: bookPda })
        .rpc({ skipPreflight: true });
      n++;

      if (n % 25 === 0) {
        const book: any = await er.account.poolBook.fetch(bookPda);
        console.log(
          `tick ${n}  nav=${usdc(book.nav)} USDC  ticks=${book.ticks}  marked_in=${usdc(book.markedIn)}`,
        );
      }

      if (n % COMMIT_EVERY === 0) {
        const sig = await er.methods
          .commitBook()
          .accounts({ payer: wallet.publicKey, book: bookPda })
          .rpc({ skipPreflight: true });
        console.log(`commit @ tick ${n}  ${sig}`);
      }
    } catch (e: any) {
      console.error("tick failed:", (e?.message ?? String(e)).split("\n")[0]);
      await sleep(2000);
    }
    await sleep(TICK_MS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
