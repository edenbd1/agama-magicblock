// Read the same deployment from both sides and print the gap.
//
// The whole architecture in one command: Solana holds the NAV as of the last
// commit, the rollup holds the live one, and the difference is yield that has
// accrued since. Everything else here is what the app's Earn page shows.
import { Connection } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { BASE_RPC, bookPda, erEndpointFor, loadKeypair, programFor, vaultPda } from "./common";
import { committedShielded } from "./private-keeper";

const usdc = (v: any) => (Number(v.toString()) / 1e6).toFixed(6);
const price = (nav: any, shares: any) =>
  Number(shares.toString()) === 0
    ? "1.00000000"
    : (Number(nav.toString()) / Number(shares.toString())).toFixed(8);

async function main() {
  const wallet = loadKeypair();
  const base = programFor(new Connection(BASE_RPC, "confirmed"), wallet);
  const erUrl = await erEndpointFor(bookPda);
  const er = programFor(new Connection(erUrl, "confirmed"), wallet);

  const vault: any = await base.account.vault.fetch(vaultPda);
  const settled: any = await base.account.poolBook.fetch(bookPda);
  const live: any = await er.account.poolBook.fetch(bookPda);
  // The private custody, as Solana last saw it. Its live state is in the TEE,
  // gated to the authority; the batched commit is all the public ever gets.
  const sh: any = (await committedShielded(base)) ?? { shares: new BN(0), totalIn: new BN(0), totalOut: new BN(0) };
  const totalIn = vault.totalIn.add(sh.totalIn);
  const totalOut = vault.totalOut.add(sh.totalOut);
  const supply = vault.shares.add(sh.shares);

  // NAV as the program computes it: the book's marked value plus dollars sitting
  // in custody that this copy of the book has not absorbed yet. Comparing raw
  // `book.nav` across layers would count unabsorbed principal as drift.
  const navOf = (book: any) =>
    book.nav.add(totalIn.sub(book.markedIn)).sub(totalOut.sub(book.markedOut));
  const settledNav = navOf(settled);
  const liveNav = navOf(live);

  console.log(
    `public   shares=${usdc(vault.shares)}  in=${usdc(vault.totalIn)}  out=${usdc(vault.totalOut)}   (agYLD)`,
  );
  console.log(
    `private  shares=${usdc(sh.shares)}  in=${usdc(sh.totalIn)}  out=${usdc(sh.totalOut)}   (last batched commit)`,
  );
  console.log(
    `solana   nav=${usdc(settledNav)}  price=${price(settledNav, supply)}  ` +
      `ticks=${settled.ticks}  (committed marks ${usdc(settled.nav)})`,
  );
  console.log(
    `rollup   nav=${usdc(liveNav)}  price=${price(liveNav, supply)}  ` +
      `ticks=${live.ticks}   ${erUrl}`,
  );
  console.log(`drift    ${usdc(liveNav.sub(settledNav))} USDC accrued since the last commit\n`);

  for (const p of live.pools) {
    const name = Buffer.from(p.name).toString("utf8").replace(/\0+$/, "");
    const sector = Buffer.from(p.sector).toString("utf8").replace(/\0+$/, "");
    console.log(
      `  ${name.padEnd(7)} ${sector.padEnd(22)} ${(p.aprBps / 100).toFixed(2)}%  ` +
        `w=${(p.weightBps / 100).toFixed(0)}%  principal=${usdc(p.principal)}  accrued=${usdc(p.accrued)}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
