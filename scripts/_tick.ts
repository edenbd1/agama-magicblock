import { authedConnectionTo, bookPda, delegationStatus, erEndpointFor, loadKeypair, programFor, sendAndPoll } from "./common";
(async () => {
  console.log("router:", JSON.stringify(await delegationStatus(bookPda)).slice(0, 200));
  const w = loadKeypair(); const url = await erEndpointFor(bookPda); const c = await authedConnectionTo(url, w); const er = programFor(c, w);
  const tx = await er.methods.tick().accounts({ payer: w.publicKey, book: bookPda }).transaction();
  try { console.log("tick", await sendAndPoll(c, tx, [w])); } catch (e: any) { console.log("FAILED", e.message); const t = await c.getTransaction(e.message.split(" ")[0], { maxSupportedTransactionVersion: 0 }); console.log((t?.meta?.logMessages ?? []).join("\n")); }
  const b: any = await er.account.poolBook.fetch(bookPda); console.log("ticks", b.ticks.toString());
})();
