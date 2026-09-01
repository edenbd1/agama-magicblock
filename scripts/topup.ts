// Fund the keeper's ephemeral balance on the rollup.
//
// The ER charges rent when it first clones a delegated account into its own state,
// and it charges it to the transaction's payer, though not to their Solana balance,
// but to an *escrow* the delegation program holds for them. Without one, the first
// tick fails with `Failed to clone regular account ... InsufficientFundsForRent`,
// which reads like a problem with the account being cloned and is not.
//
// Runs on the base layer. One top-up covers many sessions.
import { Connection, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  createTopUpEscrowInstruction,
  escrowPdaFromEscrowAuthority,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { BASE_RPC, loadKeypair } from "./common";

const AMOUNT = Number(process.env.AMOUNT ?? 50_000_000); // 0.05 SOL

async function main() {
  const wallet = loadKeypair();
  const conn = new Connection(BASE_RPC, "confirmed");
  const escrow = escrowPdaFromEscrowAuthority(wallet.publicKey);

  console.log("authority", wallet.publicKey.toBase58());
  console.log("escrow   ", escrow.toBase58());
  console.log("amount   ", AMOUNT / 1e9, "SOL");

  const tx = new Transaction().add(
    createTopUpEscrowInstruction(escrow, wallet.publicKey, wallet.publicKey, AMOUNT),
  );
  const sig = await sendAndConfirmTransaction(conn, tx, [wallet], { commitment: "confirmed" });
  console.log("topped up", sig);

  const info = await conn.getAccountInfo(escrow);
  console.log("escrow balance", (info?.lamports ?? 0) / 1e9, "SOL");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
