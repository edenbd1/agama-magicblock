// Black-box probe of a Query Filtering Service: which methods need a token, and
// what it says when one is missing. Useful when a private rollup starts refusing
// transactions and the error does not say why.
import { qfsToken, loadKeypair } from "./common";

const URL_ = process.env.QFS_URL ?? "http://127.0.0.1:6699";

async function call(url: string, body: any) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
  });
  return `${r.status} ${(await r.text()).slice(0, 180)}`;
}

async function main() {
  const wallet = loadKeypair();
  console.log("endpoint", URL_);
  const token = await qfsToken(URL_, wallet);
  console.log("token   ", token.slice(0, 24) + "…", `(${token.length} chars)`);

  const authed = `${URL_}?token=${token}`;
  for (const [label, body] of [
    ["getVersion", { method: "getVersion" }],
    ["getSlot", { method: "getSlot" }],
    ["sendTransaction (garbage payload)", { method: "sendTransaction", params: ["AQAB"] }],
  ] as const) {
    console.log(`\n${label}`);
    console.log("  no token :", await call(URL_, body));
    console.log("  token    :", await call(authed, body));
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
