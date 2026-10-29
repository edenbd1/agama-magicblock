// The keeper's private duties, run from the same loop as the book.
//
//   commit     every SHIELDED_COMMIT_EVERY ticks, publish the private aggregate to
//              Solana. That cadence is the batch: every private deposit and
//              redemption since the last commit reaches the public as one number.
//              Same 10-commit sponsorship as the book, so the same recycling.
//   pay exits  every EXITS_EVERY ticks, read the gated exit book and pay each
//              open ticket from the custody through MagicBlock's private queue,
//              closing it in the same transaction (`settle_exit` checks the
//              payment is really there).
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { PERMISSION_PROGRAM_ID, EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  BASE_RPC,
  PROGRAM_ID,
  TEE_RPC,
  TEE_VALIDATOR,
  authedConnectionTo,
  exitsPda,
  loadCustodyKeypair,
  loadKeypair,
  programFor,
  sendAndPoll,
  shieldedPda,
  sleep,
  vaultPda,
} from "./common";
import { payExitIxs } from "./private";
import { COMMIT_LIMIT } from "./recycle";

export const SHIELDED_COMMIT_EVERY = Number(process.env.SHIELDED_COMMIT_EVERY ?? 600);
export const EXITS_EVERY = Number(process.env.EXITS_EVERY ?? 5);
// A ticket is paid only once it has been open this long. On top of the queue's
// own random delay, it puts distance between the moment a redemption is asked
// for inside the enclave and the moment money moves on Solana.
export const EXIT_GRACE_S = Number(process.env.EXIT_GRACE_S ?? 20);
const LIMIT = '"Custom":2684354560';
const usdc = (v: any) => (Number(v.toString()) / 1e6).toFixed(6);

export class PrivateKeeper {
  private wallet = loadKeypair();
  private custody = loadCustodyKeypair();
  private commits = 0;
  private tee!: Connection;
  private teeCustody!: Connection;
  private er: any;

  async connect() {
    this.tee = await authedConnectionTo(TEE_RPC, this.wallet);
    this.teeCustody = await authedConnectionTo(TEE_RPC, this.custody);
    this.er = programFor(this.tee, this.wallet);
  }

  async step(n: number) {
    if (n % EXITS_EVERY === 0) await this.payExits();
    if (n % SHIELDED_COMMIT_EVERY === 0) await this.commit(n);
  }

  private seen = new Map<number, number>();

  private async payExits() {
    const book: any = await this.er.account.exitBook.fetch(exitsPda);
    const open = book.slots.filter((e: any) => e.groupId !== 0);
    const now = Date.now();
    for (const id of [...this.seen.keys()]) if (!open.some((e: any) => e.groupId === id)) this.seen.delete(id);
    for (const exit of open) {
      if (!this.seen.has(exit.groupId)) this.seen.set(exit.groupId, now);
      if (now - this.seen.get(exit.groupId)! < EXIT_GRACE_S * 1000) continue;
      const ixs = await payExitIxs(this.er, { exit, custodyOwner: this.custody.publicKey, authority: this.wallet.publicKey });
      const sig = await sendAndPoll(this.teeCustody, new Transaction().add(...ixs), [this.custody, this.wallet]);
      console.log(`exit    paid ${usdc(exit.assets)} USDC, ticket ${exit.groupId}  ${sig}`);
    }
  }

  private async commit(n: number) {
    if (this.commits >= COMMIT_LIMIT) return this.recycle();
    const tx = await this.er.methods.commitShielded().accounts({ payer: this.wallet.publicKey, vault: vaultPda, shielded: shieldedPda }).transaction();
    try {
      console.log(`shielded commit @ tick ${n}  ${await sendAndPoll(this.tee, tx, [this.wallet])}`);
      this.commits++;
    } catch (e: any) {
      if (!String(e?.message).includes(LIMIT)) throw e;
      console.log(`shielded commit @ tick ${n}  limit reached, recycling`);
      await this.recycle();
    }
  }

  /// Undelegate (which commits), wait for Solana, delegate again, re-gate.
  async recycle() {
    const log = (...a: any[]) => console.log("recycle shielded", ...a);
    const tx = await this.er.methods.undelegateShielded().accounts({ payer: this.wallet.publicKey, vault: vaultPda, shielded: shieldedPda }).transaction();
    log("undelegate", await sendAndPoll(this.tee, tx, [this.wallet]));
    const baseConn = new Connection(BASE_RPC, "confirmed");
    for (let i = 0; !(await baseConn.getAccountInfo(shieldedPda))?.owner.equals(PROGRAM_ID); i++) {
      if (i >= 60) throw new Error("shielded did not return to Solana within 120s");
      await sleep(2000);
    }
    const base = programFor(baseConn, this.wallet);
    const del = await base.methods.delegateShielded().accounts({ payer: this.wallet.publicKey, vault: vaultPda, shielded: shieldedPda, validator: TEE_VALIDATOR }).transaction();
    log("delegate", await sendAndPoll(baseConn, del, [this.wallet]));
    for (let i = 0; !(await this.tee.getAccountInfo(shieldedPda)); i++) {
      if (i >= 30) throw new Error("the enclave did not take shielded back within 60s");
      await sleep(2000);
    }
    const permissionOf = (a: PublicKey) =>
      PublicKey.findProgramAddressSync([Buffer.from("permission:"), a.toBuffer()], PERMISSION_PROGRAM_ID)[0];
    const gate = await this.er.methods.initShieldedPermission().accounts({
      authority: this.wallet.publicKey, vault: vaultPda, shielded: shieldedPda, permission: permissionOf(shieldedPda),
      exits: exitsPda, exitsPermission: permissionOf(exitsPda),
      permissionProgram: PERMISSION_PROGRAM_ID, ephemeralVault: EPHEMERAL_VAULT_ID, magicProgram: MAGIC_PROGRAM_ID,
    }).transaction();
    log("gate", await sendAndPoll(this.tee, gate, [this.wallet]));
    this.commits = 0;
  }
}

/// Read the private aggregate as Solana last saw it.
export async function committedShielded(base: any): Promise<{ totalIn: any; totalOut: any; shares: any } | null> {
  const info = await base.provider.connection.getAccountInfo(shieldedPda);
  return info ? base.coder.accounts.decode("shielded", info.data) : null;
}
