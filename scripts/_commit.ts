import { authedConnectionTo, bookPda, erEndpointFor, loadKeypair, programFor, sendAndPoll } from "./common";
(async () => {
  const w = loadKeypair(); const c = await authedConnectionTo(await erEndpointFor(bookPda), w); const er = programFor(c, w);
  for (const m of ["commitBook", "undelegateBook"]) {
    const tx = await (er.methods as any)[m]().accounts({ payer: w.publicKey, book: bookPda }).transaction();
    try { console.log(m, await sendAndPoll(c, tx, [w])); } catch (e: any) { console.log(m, "FAILED", e.message.slice(90)); const t = await c.getTransaction(e.message.split(" ")[0], { maxSupportedTransactionVersion: 0 }); console.log((t?.meta?.logMessages ?? []).filter((l: string) => /ERR|illegal|error|limit/i.test(l)).join("\n")); }
  }
})();
