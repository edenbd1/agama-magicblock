// The app builds MagicBlock instructions by hand (lib/magicblock/espl.ts) to
// keep the SDK out of the browser bundle. This checks them against the SDK:
// same program, same accounts in the same order with the same signer and
// writable flags, same data outside the encrypted parts.
//
//   APP=../app-beta npx tsx scripts/check-app-espl.ts
import path from "path";
import { Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as sdk from "@magicblock-labs/ephemeral-rollups-sdk";
import { TEE_VALIDATOR, usdcMint } from "./common";
import { sponsoredShieldIxs } from "./private";

const appDir = path.resolve(process.env.APP ?? path.join(__dirname, "../../app-beta"));
const app = require(path.join(appDir, "lib/magicblock/espl.ts"));

let failures = 0;
function same(label: string, a: any, b: any, dataRanges?: [number, number][]) {
  const ka = a.keys.map((k: any) => `${k.pubkey.toBase58()}:${+k.isSigner}${+k.isWritable}`);
  const kb = b.keys.map((k: any) => `${k.pubkey.toBase58()}:${+k.isSigner}${+k.isWritable}`);
  const da = Buffer.from(a.data), db = Buffer.from(b.data);
  const pick = (d: Buffer) => (dataRanges ? Buffer.concat(dataRanges.map(([s, e]) => d.subarray(s, e))) : d);
  const ok = a.programId.toBase58() === b.programId.toBase58() && JSON.stringify(ka) === JSON.stringify(kb) && da.length === db.length && pick(da).equals(pick(db));
  if (!ok) {
    failures++;
    console.log(`FAIL ${label}`);
    ka.forEach((k: string, i: number) => k !== kb[i] && console.log(`   key ${i}: app ${k}  sdk ${kb[i]}`));
    if (da.length !== db.length) console.log(`   data length app ${da.length} sdk ${db.length}`);
  } else console.log(`ok   ${label}`);
}

const w = Keypair.generate().publicKey, d = Keypair.generate().publicKey, sp = Keypair.generate().publicKey;
const sid = 1234567;
const [eW] = sdk.deriveEphemeralAta(w, usdcMint);
const [sE] = sdk.deriveShuttleEphemeralAta(w, usdcMint, sid);
const [sA] = sdk.deriveShuttleAta(sE, usdcMint);
const sW = sdk.deriveShuttleWalletAta(usdcMint, sE);

same("init eATA", app.initEataIx(w, w), sdk.initEphemeralAtaIx(eW, w, usdcMint, w));
same("delegate eATA", app.delegateEataIx(w, w), sdk.delegateEphemeralAtaIx(w, eW, TEE_VALIDATOR));
same("encrypted deposit",
  app.encryptedDepositIx(w, d, 77_000_000n, { shuttleId: sid, minDelayMs: 1000n, maxDelayMs: 9000n, split: 3 }),
  (sdk as any).depositAndDelegateShuttleEphemeralAtaWithMergeAndPrivateTransferIx(w, sE, sA, w, getAssociatedTokenAddressSync(usdcMint, w), d, sW, usdcMint, sid, 77_000_000n, true, 1000n, 9000n, 3, TEE_VALIDATOR, undefined),
  // discriminator, shuttle id, amount, exact-out; then the validator and the
  // suffix length. The two ciphertexts use fresh ephemeral keys by design.
  [[0, 14], [94, 128]]);
const appShield = app.sponsoredShieldIxs(d, sp, 5_000_000n);
const sdkShield = sponsoredShieldIxs(d, sp, 5_000_000n);
appShield.forEach((ix: any, i: number) => same(`sponsored shield ${i}`, ix, sdkShield[i]));

// Round trip the sealing: a box opened with the recipient's X25519 secret.
const nacl = require("tweetnacl");
const { ed25519 } = require(path.join(appDir, "node_modules/@noble/curves/ed25519.js"));
const kp = Keypair.generate();
const sealed: Uint8Array = app.encryptForValidatorTo ? app.encryptForValidatorTo(kp.publicKey, Buffer.from("hello")) : null;
if (sealed) {
  const secret = ed25519.utils.toMontgomerySecret(kp.secretKey.subarray(0, 32));
  const { blake2b } = require(path.join(appDir, "node_modules/@noble/hashes/blake2.js"));
  const nonce = blake2b(new Uint8Array([...sealed.subarray(0, 32), ...ed25519.utils.toMontgomery(kp.publicKey.toBytes())]), { dkLen: 24 });
  const open = nacl.box.open(sealed.subarray(32), nonce, sealed.subarray(0, 32), secret);
  if (open && Buffer.from(open).toString() === "hello") console.log("ok   sealed box opens with the recipient key");
  else { failures++; console.log("FAIL sealed box does not open"); }
}
process.exit(failures ? 1 : 0);
