// End-to-end smoke test against the live devnet deployment.
//
// Exercises both layers in the order a user would hit them:
//   base  faucet -> deposit
//   ER    read the book back and confirm the deposit was absorbed and is accruing
//
// The gap between the two reads at the end is the point of the whole architecture:
// Solana holds the last committed NAV, the rollup holds the live one.
import { BN } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  BASE_RPC,
  PROGRAM_ID,
  agyldMint,
  bookPda,
  erEndpointFor,
  loadKeypair,
  programFor,
  sleep,
  usdcMint,
  vaultPda,
} from "./common";

const AMOUNT = new BN(500_000_000); // 500 USDC
const usdc = (v: any) => (Number(v.toString()) / 1e6).toFixed(6);

async function main() {
  const wallet = loadKeypair();
  const me = wallet.publicKey;
  const base = new Connection(BASE_RPC, "confirmed");
  const p = programFor(base, wallet);

  const claim = PublicKey.findProgramAddressSync(
    [Buffer.from("faucet-claim"), me.toBuffer()],
    PROGRAM_ID,
  )[0];
  const userUsdc = getAssociatedTokenAddressSync(usdcMint, me);
  const userAgyld = getAssociatedTokenAddressSync(agyldMint, me);
  const vaultUsdc = getAssociatedTokenAddressSync(usdcMint, vaultPda, true);

  console.log("[base] faucet 1,000 USDC");
  console.log(
    "  ",
    await p.methods
      .faucet()
      .accounts({
        user: me,
        vault: vaultPda,
        claim,
        usdcMint,
        userUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc(),
  );

  console.log(`[base] deposit ${usdc(AMOUNT)} USDC`);
  console.log(
    "  ",
    await p.methods
      .deposit(AMOUNT)
      .accounts({
        user: me,
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
      .rpc(),
  );

  const vault: any = await p.account.vault.fetch(vaultPda);
  console.log(
    `[base] vault  shares=${usdc(vault.shares)}  in=${usdc(vault.totalIn)}  out=${usdc(vault.totalOut)}`,
  );

  // Give the keeper a couple of ticks to absorb the deposit into the pools.
  const erUrl = await erEndpointFor(bookPda);
  const er = programFor(new Connection(erUrl, "confirmed"), wallet);
  console.log(`\n[er]   ${erUrl}`);
  await sleep(4000);

  const book: any = await er.account.poolBook.fetch(bookPda);
  console.log(`[er]   ticks=${book.ticks}  nav=${usdc(book.nav)}  marked_in=${usdc(book.markedIn)}`);
  for (const pool of book.pools) {
    const name = Buffer.from(pool.name).toString("utf8").replace(/\0+$/, "");
    const sector = Buffer.from(pool.sector).toString("utf8").replace(/\0+$/, "");
    console.log(
      `        ${name.padEnd(8)} ${sector.padEnd(22)} ${(pool.aprBps / 100).toFixed(2)}%  ` +
        `principal=${usdc(pool.principal)}  accrued=${usdc(pool.accrued)}`,
    );
  }

  const baseBook: any = await p.account.poolBook.fetch(bookPda);
  console.log(
    `\n[base] committed nav=${usdc(baseBook.nav)}   [er] live nav=${usdc(book.nav)}` +
      `   drift=${usdc(book.nav.sub(baseBook.nav))} USDC`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
