import { Connection, PublicKey } from "@solana/web3.js";
import { BASE_RPC, bookPda } from "./common";
(async () => {
  const base = new Connection(BASE_RPC, "confirmed"); const eu = new Connection("https://devnet-eu.magicblock.app", "confirmed");
  const rec = PublicKey.findProgramAddressSync([Buffer.from("delegation"), bookPda.toBuffer()], new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"))[0];
  const [b, e, r] = await Promise.all([base.getAccountInfo(bookPda), eu.getAccountInfo(bookPda), base.getAccountInfo(rec)]);
  console.log("base owner", b?.owner.toBase58(), "lamports", b?.lamports);
  console.log("eu   owner", e?.owner.toBase58(), "lamports", e?.lamports, "same data as base:", !!(b && e && Buffer.compare(b.data, e.data) === 0));
  console.log("delegation record", r ? `exists, ${r.data.length} bytes, validator ${new PublicKey(r.data.subarray(8, 40)).toBase58()}` : "absent");
  console.log("eu slot", await eu.getSlot(), "eu identity", (await (eu as any)._rpcRequest("getIdentity", [])).result?.identity);
})();
