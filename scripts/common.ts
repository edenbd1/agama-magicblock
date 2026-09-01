// Shared wiring for the Agama-on-MagicBlock scripts.
//
// Three endpoints, three jobs, and mixing them up is the single most common way
// to lose an afternoon:
//   BASE   Solana devnet. Program deploy, initialisation, delegation, deposits.
//   ROUTER Tells us which ER a delegated account currently lives on.
//   ER     Where delegated accounts are actually writable. Ticks and commits.
import fs from "fs";
import os from "os";
import path from "path";
import * as anchor from "@coral-xyz/anchor";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";

const LOCAL = process.env.MB_ENV === "local";

export const BASE_RPC =
  process.env.SOLANA_RPC_ENDPOINT ?? (LOCAL ? "http://127.0.0.1:8899" : "https://rpc.magicblock.app/devnet");
export const ROUTER_RPC =
  process.env.ROUTER_ENDPOINT ?? (LOCAL ? "http://127.0.0.1:6699" : "https://devnet-router.magicblock.app/");
/// Set when the router cannot be asked (the local stack exposes the rollup
/// directly on its public port rather than behind a discovery service).
export const ER_RPC_OVERRIDE = process.env.ER_ENDPOINT ?? (LOCAL ? "http://127.0.0.1:6699" : undefined);

/// Two validators, because the two halves of the machinery want different things.
///
/// The lending book is public (pool marks, APRs and NAV are things Agama publishes)
/// so it runs on an open devnet ER. Per-depositor positions are not public, so they
/// go to the TEE validator. Note that writing to the devnet TEE is token-gated;
/// reads are open. Until MagicBlock issues one, positions run on the local stack.
export const ER_VALIDATOR = new PublicKey("MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e");
export const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");

/// The single validator the local `mb-stack` runs. Locally there is only one, and
/// its query-filtering entrypoint stands in for the TEE's: enough to exercise the
/// EphemeralPermission logic, not enough to claim hardware attestation.
export const LOCALNET_VALIDATOR = new PublicKey("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev");

/// Which validator new delegations target. `MB_ENV=local` switches the whole
/// script suite onto the local stack.
export const IS_LOCAL = process.env.MB_ENV === "local";

export const BOOK_SEED_NAME = "lending-book";

export const PROGRAM_ID = new PublicKey("GVHsSaFUkVAZJdRKWtK1SxYUhW2P7a7z1xBL5SaFj5vC");

export const VAULT_SEED = Buffer.from("agama-vault");
export const BOOK_SEED = Buffer.from(BOOK_SEED_NAME);
// Bumped with the layout when positions gained a session key.
export const POSITION_SEED = Buffer.from("position-v2");
export const USDC_SEED = Buffer.from("usdc-mint");
export const AGYLD_SEED = Buffer.from("agyld-mint");

export const [vaultPda] = PublicKey.findProgramAddressSync([VAULT_SEED], PROGRAM_ID);
export const [bookPda] = PublicKey.findProgramAddressSync(
  [BOOK_SEED, vaultPda.toBuffer()],
  PROGRAM_ID,
);
export const [usdcMint] = PublicKey.findProgramAddressSync([USDC_SEED], PROGRAM_ID);
export const [agyldMint] = PublicKey.findProgramAddressSync([AGYLD_SEED], PROGRAM_ID);

export function positionPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([POSITION_SEED, owner.toBuffer()], PROGRAM_ID)[0];
}

export function loadKeypair(): Keypair {
  const file = process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

export function loadIdl(): anchor.Idl {
  const p = path.join(__dirname, "..", "target", "idl", "agama_magicblock.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/// A program bound to a specific connection. Delegation lives on base, ticks live
/// on the ER, so we build one of these per endpoint rather than juggling providers.
export function programFor(connection: Connection, wallet: Keypair): anchor.Program {
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), {
    commitment: "confirmed",
  });
  return new anchor.Program(loadIdl(), provider);
}

/// Ask the router where a delegated account is actually running. Returns null when
/// the account is not delegated, which is also how we detect a completed
/// undelegation.
export async function delegationStatus(account: PublicKey): Promise<any | null> {
  const res = await fetch(ROUTER_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getDelegationStatus",
      params: [account.toBase58()],
    }),
  });
  const json: any = await res.json();
  return json?.result ?? null;
}

/// The ER endpoint for an account, straight from the router. Never hardcode this:
/// the validator that holds an account can change between delegations.
export async function erEndpointFor(account: PublicKey): Promise<string> {
  if (ER_RPC_OVERRIDE) return ER_RPC_OVERRIDE;
  const status = await delegationStatus(account);
  const fqdn = status?.fqdn ?? status?.delegationRecord?.fqdn;
  if (!fqdn) throw new Error(`account ${account.toBase58()} is not delegated (router said: ${JSON.stringify(status)})`);
  return fqdn.startsWith("http") ? fqdn : `https://${fqdn}`;
}

/// A connection with the right websocket endpoint attached.
///
/// The hosted rollups serve RPC and websocket on the same port; the local stack
/// puts the websocket on port + 1. Guessing wrong shows up as a flood of
/// `ws error: Unexpected server response: 200`, which does not mention websockets
/// at all.
export function connectionTo(url: string): Connection {
  const u = new URL(url);
  const ws = new URL(url);
  ws.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  if (u.port) ws.port = String(Number(u.port) + 1);
  return new Connection(url, { commitment: "confirmed", wsEndpoint: ws.toString() });
}

/// Log in to a Query Filtering Service and get a write token.
///
/// The private rollup endpoints (devnet's TEE one, and the local stack's port
/// 6699) sit behind a QFS that gates *writes*. Reads are open, which is why a
/// half-wired client looks fine until the first transaction and then fails with
/// `401 Missing token query param`.
///
/// The token is a 30-day JWT, minted by signing a challenge with the same keypair
/// that will sign the transactions. It is self-serve: no allowlist, no API key.
/// It proves who you are and nothing else: whether the rollup then *accepts* the
/// transaction is still decided by the on-chain EphemeralPermission.
export async function qfsToken(url: string, wallet: Keypair): Promise<string> {
  const { token } = await getAuthToken(url.replace(/\/$/, ""), wallet.publicKey, async (msg) =>
    nacl.sign.detached(msg, wallet.secretKey),
  );
  return token;
}

/// A connection to a rollup, authenticated if that rollup asks for it.
///
/// The open rollups (devnet-eu and friends) have no `/auth/challenge`, so the login
/// simply fails and we fall through to a plain connection. That keeps one code path
/// for both, instead of making every call site know which kind of endpoint it has.
export async function authedConnectionTo(url: string, wallet: Keypair): Promise<Connection> {
  let token: string;
  try {
    token = await qfsToken(url, wallet);
  } catch {
    return connectionTo(url);
  }
  const http = new URL(url);
  http.searchParams.set("token", token);
  const ws = new URL(url);
  ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
  if (ws.port) ws.port = String(Number(ws.port) + 1);
  ws.searchParams.set("token", token);
  return new Connection(http.toString(), {
    commitment: "confirmed",
    wsEndpoint: ws.toString(),
  });
}

/// Send a transaction and wait for it by polling, not by subscribing.
///
/// A Query Filtering Service proxies JSON-RPC but does not necessarily proxy the
/// websocket methods `confirmTransaction` relies on; when it does not, the failure
/// surfaces as `Unknown action 'undefined'` from deep inside the client, long after
/// the transaction itself succeeded. Polling `getSignatureStatuses` sidesteps that
/// and reports the on-chain error when there is a real one.
export async function sendAndPoll(
  connection: Connection,
  tx: anchor.web3.Transaction,
  signers: Keypair[],
  { tries = 30, delayMs = 500 } = {},
): Promise<string> {
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  for (let i = 0; i < tries; i++) {
    await sleep(delayMs);
    const { value } = await connection.getSignatureStatuses([sig]);
    const st = value[0];
    if (!st) continue;
    if (st.err) throw new Error(`${sig} failed: ${JSON.stringify(st.err)}`);
    if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return sig;
  }
  throw new Error(`${sig} not confirmed after ${(tries * delayMs) / 1000}s`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
