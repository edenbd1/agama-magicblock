// Walk the private-position flow as far as devnet allows today.
//
//   1. init_position       base layer, opens the ledger and pre-funds permission rent
//   2. delegate_position   base layer, hands it to the TEE validator
//   3. init_permission     TEE rollup, gates it
//   4. sync_position       TEE rollup, marks it
//
// Steps 3 and 4 need a MagicBlock-issued token for the devnet TEE endpoint; without
// one it answers `401 Missing token query param` on sendTransaction. Reads are open,
// so the delegation in step 2 is still verifiable from here.
import { Connection, SystemProgram } from "@solana/web3.js";
import {
  BASE_RPC,
  IS_LOCAL,
  LOCALNET_VALIDATOR,
  TEE_VALIDATOR,
  delegationStatus,
  loadKeypair,
  positionPda,
  programFor,
  sleep,
  vaultPda,
} from "./common";

// Locally there is one validator and its query-filtering service stands in for the
// enclave; on devnet the positions go to the real TEE one.
const PRIVACY_VALIDATOR = IS_LOCAL ? LOCALNET_VALIDATOR : TEE_VALIDATOR;

async function main() {
  const wallet = loadKeypair();
  const me = wallet.publicKey;
  const conn = new Connection(BASE_RPC, "confirmed");
  const p = programFor(conn, wallet);
  const position = positionPda(me);

  console.log("owner    ", me.toBase58());
  console.log("position ", position.toBase58());

  if (await conn.getAccountInfo(position)) {
    console.log("\n[1/4] ledger already open");
  } else {
    const sig = await p.methods
      .initPosition()
      .accounts({
        owner: me,
        vault: vaultPda,
        position,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("\n[1/4] init_position    ", sig);
  }

  const before = await delegationStatus(position);
  if (before?.isDelegated) {
    console.log("[2/4] already delegated to", before?.fqdn);
  } else {
    const sig = await p.methods
      .delegatePosition()
      .accounts({ owner: me, position, validator: PRIVACY_VALIDATOR })
      .rpc();
    console.log("[2/4] delegate_position", sig);
    await sleep(3000);
  }

  const status = await delegationStatus(position);
  console.log("\nrouter:", JSON.stringify(status));
  console.log(
    status?.delegationRecord?.authority === PRIVACY_VALIDATOR.toBase58()
      ? "\nthe ledger is inside the TEE validator. Gating and syncing it (steps 3 and 4)\n" +
          "need a devnet TEE write token; the instructions are deployed and waiting."
      : "\nunexpected validator, check the delegation record above.",
  );
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
