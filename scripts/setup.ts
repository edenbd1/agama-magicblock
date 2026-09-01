// One-shot initialisation, run once after `anchor deploy`.
//
//   1. initialize   vault PDA, the devnet USDC mint, the agYLD mint, custody ATA
//   2. init_book    the four lending pools and their allocation weights
//   3. delegate     hand the book to MagicBlock's TEE validator
//
// After step 3 the book is no longer writable on Solana. That is deliberate: from
// here the pools only move on the ER, and the base layer sees them at commit
// granularity. Deposits keep working because they price on the committed NAV plus
// whatever is still sitting unmarked in custody.
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  BASE_RPC,
  ER_VALIDATOR,
  IS_LOCAL,
  LOCALNET_VALIDATOR,
  agyldMint,
  bookPda,
  delegationStatus,
  loadKeypair,
  programFor,
  usdcMint,
  vaultPda,
} from "./common";

// Same four pools Agama runs on Starknet, same weights.
const POOLS = [
  { name: "Pool A", sector: "Private credit", aprBps: 1200, weightBps: 4000 },
  { name: "Pool B", sector: "Tokenized treasuries", aprBps: 480, weightBps: 2000 },
  { name: "Pool C", sector: "Bonds", aprBps: 620, weightBps: 1000 },
  { name: "Pool D", sector: "Onchain RWA yield", aprBps: 900, weightBps: 3000 },
];

const CLONE_RENT_FLOOR = 20_000_000; // 0.02 SOL, comfortably above the ER's ask

async function topUpForCloning(connection: Connection, wallet: any, accounts: PublicKey[]) {
  for (const account of accounts) {
    const info = await connection.getAccountInfo(account);
    const have = info?.lamports ?? 0;
    if (have >= CLONE_RENT_FLOOR) {
      console.log(`      ${account.toBase58()} has ${(have / 1e9).toFixed(4)} SOL, enough`);
      continue;
    }
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: account,
        lamports: CLONE_RENT_FLOOR - have,
      }),
    );
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
      commitment: "confirmed",
    });
    console.log(`      topped up ${account.toBase58()} -> ${sig}`);
  }
}

const fixed = (s: string, n: number) => {
  const b = Buffer.alloc(n);
  Buffer.from(s, "utf8").copy(b, 0, 0, Math.min(n, Buffer.byteLength(s)));
  return Array.from(b);
};

async function main() {
  const wallet = loadKeypair();
  const connection = new Connection(BASE_RPC, "confirmed");
  const program = programFor(connection, wallet);

  console.log("payer   ", wallet.publicKey.toBase58());
  console.log("program ", program.programId.toBase58());
  console.log("vault   ", vaultPda.toBase58());
  console.log("book    ", bookPda.toBase58());
  console.log("USDC    ", usdcMint.toBase58());
  console.log("agYLD   ", agyldMint.toBase58());

  const vaultUsdc = getAssociatedTokenAddressSync(usdcMint, vaultPda, true);

  // 1. Vault + mints + custody.
  if (await connection.getAccountInfo(vaultPda)) {
    console.log("\n[1/3] vault already initialised, skipping");
  } else {
    const sig = await program.methods
      .initialize()
      .accounts({
        payer: wallet.publicKey,
        vault: vaultPda,
        usdcMint,
        agyldMint,
        vaultUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("\n[1/3] initialize", sig);
  }

  // 2. The lending book.
  if (await connection.getAccountInfo(bookPda)) {
    console.log("[2/3] book already initialised, skipping");
  } else {
    const pools = POOLS.map((p) => ({
      name: fixed(p.name, 24),
      sector: fixed(p.sector, 32),
      aprBps: p.aprBps,
      weightBps: p.weightBps,
    }));
    const sig = await program.methods
      .initBook(pools)
      .accounts({
        authority: wallet.publicKey,
        vault: vaultPda,
        book: bookPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("[2/3] init_book  ", sig);
  }

  // 2b. Top up every account the rollup will have to clone.
  //
  //     The ER re-creates each account it touches inside its own state and charges
  //     rent for it against the account's own lamports. Solana's rent-exempt
  //     minimum is not enough, and the failure surfaces as
  //     `Failed to clone regular account <pubkey>: InsufficientFundsForRent`,
  //     which reads like a problem with the clone and is really a funding one.
  //     Both the delegated book and the read-only vault clone need it.
  await topUpForCloning(connection, wallet, [vaultPda, bookPda]);

  console.log("[2b/3] funding accounts the rollup will clone");
  // 3. Delegate the machinery to the public rollup. The book is public state, so
  //    it does not belong behind the TEE gate. Positions do, and they are
  //    delegated separately, per user, from the app.
  const status = await delegationStatus(bookPda);
  if (status?.isDelegated) {
    console.log("[3/3] book already delegated to", status?.fqdn ?? "an ER");
  } else {
    const sig = await program.methods
      .delegateBook()
      .accounts({
        payer: wallet.publicKey,
        vault: vaultPda,
        book: bookPda,
        validator: IS_LOCAL ? LOCALNET_VALIDATOR : ER_VALIDATOR,
      })
      .rpc();
    console.log("[3/3] delegate   ", sig);
  }

  // The router is the source of truth for where the book now lives.
  await new Promise((r) => setTimeout(r, 3000));
  console.log("\nrouter status:", JSON.stringify(await delegationStatus(bookPda)));

  console.log(
    "\naddresses for the frontend:\n" +
      JSON.stringify(
        {
          programId: program.programId.toBase58(),
          vault: vaultPda.toBase58(),
          book: bookPda.toBase58(),
          usdcMint: usdcMint.toBase58(),
          agyldMint: agyldMint.toBase58(),
          vaultUsdc: vaultUsdc.toBase58(),
        },
        null,
        2,
      ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
