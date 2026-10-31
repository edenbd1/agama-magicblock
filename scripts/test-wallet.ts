// A funded devnet wallet for browser tests: 0.25 SOL from the authority and
// the faucet's 1000 test USDC. Writes the secret key to the path given.
//
//   npx tsx scripts/test-wallet.ts /tmp/wallet.json

import fs from "fs";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { BASE_RPC, PROGRAM_ID, loadKeypair, programFor, sendAndPoll, usdcMint, vaultPda } from "./common";
(async () => {
  const funder = loadKeypair(); const w = Keypair.generate(); const base = new Connection(BASE_RPC, "confirmed");
  await sendAndPoll(base, new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: w.publicKey, lamports: 250_000_000 })), [funder]);
  const p = programFor(base, w);
  const claim = PublicKey.findProgramAddressSync([Buffer.from("faucet-claim"), w.publicKey.toBuffer()], PROGRAM_ID)[0];
  await p.methods.faucet().accounts({ user: w.publicKey, vault: vaultPda, claim, usdcMint, userUsdc: getAssociatedTokenAddressSync(usdcMint, w.publicKey), tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).rpc();
  fs.writeFileSync(process.argv[2], JSON.stringify(Array.from(w.secretKey))); console.log(w.publicKey.toBase58());
})();
