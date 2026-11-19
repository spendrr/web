// Real-WASM check of src/lib/wallet/recordSeal.ts. Local only: the Ark server and esplora are a fake on 127.0.0.1,
// every other request is blocked, the wallet is the BIP39 test mnemonic. Run: node scripts/dev/record-seal-wasm-check.mjs
// The hook runs inside a dedicated Worker (the realm it ships in); the "attacker" writes from the page (main thread).
// Expect every line to say PASS.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { build } from "esbuild";

const root = new URL("../../", import.meta.url);
const require = createRequire(new URL("package.json", root));
const { chromium } = require("playwright");
const barkDir = new URL("node_modules/@secondts/bark/web/", root);
const barkJs = readFileSync(new URL("bark_ffi_wasm.js", barkDir));
const barkWasm = readFileSync(new URL("bark_ffi_wasm_bg.wasm", barkDir));

const sealJs = (
  await build({
    entryPoints: [new URL("src/lib/wallet/recordSeal.ts", root).pathname],
    bundle: true,
    format: "esm",
    write: false,
    target: "es2022",
  })
).outputFiles[0].text;

const INVOICE =
  "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";
const HASH = "0001020304050607080900010203040506070809000102030405060708090102";
const KEYPUB = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

const page = `<!doctype html><meta charset="utf-8"><title>seal</title><script type="module" src="/main.js"></script>`;

const workerSrc = (port) => `
import { installRecordSeal, recordSeal, deriveRecordSealKey, listUnverified, acceptUnverified } from "/seal.js";
installRecordSeal();
const DB = "seal-check";
const MN = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const cfg = { serverAddress: "http://127.0.0.1:${port}/ark", esploraAddress: "http://127.0.0.1:${port}/esplora" };
let Wallet, w;
const race = (p) => Promise.race([p.then((v) => ["ok", v], (e) => ["err", String(e).slice(0, 140)]), new Promise((r) => setTimeout(() => r(["HANG"]), 10000))]);
const cmds = {
  async init() {
    const m = await import("/bark/bark_ffi_wasm.js");
    await m.default({ module_or_path: "/bark/bark_ffi_wasm_bg.wasm" });
    Wallet = m.Wallet;
    recordSeal.enable(DB, deriveRecordSealKey(Uint8Array.from({ length: 64 }, (_, i) => i)));
    await Wallet.create("Bitcoin", MN, cfg, DB, true);
    return "created";
  },
  async open() { w = await Wallet.open("Bitcoin", MN, cfg, null, { runDaemon: false, indexedDbName: DB, createIfNotExists: false, skipRecovery: true }); return "opened"; },
  async pending() { return race(w.pendingLightningSends().then((x) => x.length)); },
  async sync() { const before = recordSeal.violationCount(); const r = await race(w.sync().then(() => "returned")); return [r, recordSeal.violationCount() - before]; },
  async list() { return listUnverified(); },
  async accept() { return acceptUnverified(); },
  async acceptNone() { return acceptUnverified([]); },
  async off() { recordSeal.disable(); return "off"; },
  async on() { recordSeal.enable(DB, deriveRecordSealKey(Uint8Array.from({ length: 64 }, (_, i) => i))); return "on"; },
};
self.onmessage = async (e) => {
  const { id, cmd } = e.data;
  try { self.postMessage({ id, ok: true, result: await cmds[cmd]() }); } catch (err) { self.postMessage({ id, ok: false, error: String(err && err.stack || err) }); }
};
`;

const main = () => `
const out = (window.__out = []);
const log = (k, ok, v) => out.push([k, ok, v]);
const worker = new Worker("/worker.js", { type: "module" });
let n = 0; const waiting = new Map();
worker.onmessage = (e) => { const r = waiting.get(e.data.id); if (r) { waiting.delete(e.data.id); e.data.ok ? r.res(e.data.result) : r.rej(new Error(e.data.error)); } };
const call = (cmd) => new Promise((res, rej) => { const id = ++n; waiting.set(id, { res, rej }); worker.postMessage({ id, cmd }); });
const DB = "seal-check";
const idb = (v) => new Promise((res, rej) => { const r = v ? indexedDB.open(DB, v) : indexedDB.open(DB); r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains("bark.v1.14")) d.createObjectStore("bark.v1.14").createIndex("sort_key", "sort_key"); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const readAll = async () => { const d = await idb(); if (!d.objectStoreNames.contains("bark.v1.14")) { d.close(); return []; } const r = await new Promise((res) => { const q = d.transaction("bark.v1.14").objectStore("bark.v1.14").getAll(); q.onsuccess = () => res(q.result); }); d.close(); return r; };
const forge = async (uncanonicalizable = false) => {
  let d = await idb(); if (!d.objectStoreNames.contains("bark.v1.14")) { const v = d.version; d.close(); d = await idb(v + 1); }
  const id = "ln_pay.${HASH}"; const pkBytes = Array.from(new TextEncoder().encode(id)); const key = pkBytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  const body = JSON.stringify({ LightningSend: { progress: "Start", allow_exit_of_htlcs: false, invoice: "${INVOICE}", original_payment_method: { type: "invoice", value: "${INVOICE}" }, input_vtxo_ids: [], payment_amount: 250000, fee: 0, htlc_key: "${KEYPUB}", revocation_key: "${KEYPUB}", htlc_expiry: 1000000 } });
  const rec = { partition: 14, pk: pkBytes, data: Array.from(new TextEncoder().encode(body)), ...(uncanonicalizable ? { extra: { nested: 1n } } : {}) };
  await new Promise((res, rej) => { const tx = d.transaction("bark.v1.14", "readwrite"); tx.objectStore("bark.v1.14").put(rec, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  d.close(); return rec;
};
const forgeOther = async () => {
  const d = await idb(); const id = "ln_pay.ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"; const pk = Array.from(new TextEncoder().encode(id)); const key = pk.map((b) => b.toString(16).padStart(2, "0")).join("");
  const base = (await readAll())[0];
  await new Promise((res, rej) => { const tx = d.transaction("bark.v1.14", "readwrite"); tx.objectStore("bark.v1.14").put({ partition: 14, pk, data: base.data }, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  d.close();
};
const cloneValid = async () => {
  const rec = (await readAll())[0]; const d = await idb();
  await new Promise((res, rej) => { const tx = d.transaction("bark.v1.14", "readwrite"); tx.objectStore("bark.v1.14").put(rec, "attacker-chosen-key"); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  d.close();
};
window.__done = (async () => {
  log("worker: wasm init, wallet create (seal on)", (await call("init")) === "created");
  await forge();
  const stored = await readAll();
  log("attacker's forged record is in the DB", stored.length === 1 && stored[0].mac === undefined);
  await call("open");
  const p = await call("pending");
  log("bark does not see the forged payment (pendingLightningSends fails closed, no hang)", p[0] === "err", p);
  const s = await call("sync");
  log("sync cannot execute it (violation counted)", s[1] > 0, s);
  const after = await readAll();
  log("forged record left untouched by bark", after.length === 1 && after[0].mac === undefined && JSON.stringify(after[0].data) === JSON.stringify(stored[0].data));
  const l = await call("list");
  log("listUnverified names it", l.length === 1 && l[0].store === "bark.v1.14" && l[0].kind === "LightningSend", l);
  // The sheet signs only what it showed: an empty list signs nothing and the record stays held back.
  const none = await call("acceptNone");
  log("accept restricted to an empty list signs nothing", none === 0 && (await call("list")).length === 1, none);
  // control: the same forged record with the seal off is visible to bark (this is the hole)
  await call("off");
  const open = await call("pending");
  log("control, seal off: bark sees the forged payment (what the seal prevents)", open[0] === "ok" && open[1] === 1, open);
  await call("on");
  // the user accepts it with the password: now bark takes it and rewrites it through the hook
  const acc = await call("accept");
  log("accept signs exactly one record", acc === 1, acc);
  // A MAC covers the value, but bark's primary key is out-of-line. A copy under another key must not survive as a replay.
  await cloneValid();
  const copied = await call("pending");
  log("valid value copied under another primary key is rejected", copied[0] === "err", copied);
  const copyList = await call("list");
  log("wrong-key copy is reported", copyList.length === 1, copyList);
  const copyAccept = await call("accept");
  log("wrong-key copy is discarded, not signed", copyAccept === 0, copyAccept);
  const p2 = await call("pending");
  log("after accept bark sees it", p2[0] === "ok" && p2[1] === 1, p2);
  const s2 = await call("sync");
  log("sync with a valid record raises no violation", s2[1] === 0, s2);
  const fin = await readAll();
  log("every stored record carries a valid-looking mac string", fin.length === 1 && typeof fin[0].mac === "string" && fin[0].mac.length === 64, fin.length);
  log("listUnverified is empty after accept", (await call("list")).length === 0);
  // bark reads through a cursor and cannot take an error in the middle of an iteration (hang plus WASM panic). A forged
  // record behind a valid one must therefore fail the read at the cursor's first step.
  await forgeOther();
  const mid = await call("pending");
  log("forged record behind a valid one fails the read cleanly (no hang, no panic)", mid[0] === "err", mid);
  const midList = await call("list");
  log("...and it is the only unverified record", midList.length === 1, midList);
  await call("accept");
  // JSON.stringify throws on this structured-cloneable value. The guard must reject it without throwing out of the
  // success listener (which would let bark's own success listener run).
  await forge(true);
  const malformed = await call("pending");
  log("nested BigInt cannot bypass the guard through a canonicalization exception", malformed[0] === "err", malformed);
  const malformedSync = await call("sync");
  log("uncanonicalizable record raises a violation", malformedSync[1] > 0, malformedSync);
})().then(() => log("DONE", true), (e) => log("ERROR", false, String(e && e.stack || e)));
`;

const server = createServer((req, res) => {
  const { port } = server.address();
  const send = (t, body) => res.writeHead(200, { "content-type": t }).end(body);
  if (req.url === "/") return send("text/html", page);
  if (req.url === "/main.js") return send("text/javascript", main());
  if (req.url === "/worker.js") return send("text/javascript", workerSrc(port));
  if (req.url === "/seal.js") return send("text/javascript", sealJs);
  if (req.url === "/bark/bark_ffi_wasm.js") return send("text/javascript", barkJs);
  if (req.url === "/bark/bark_ffi_wasm_bg.wasm") return send("application/wasm", barkWasm);
  if (req.url === "/esplora/blocks/tip/height") return send("text/plain", "100");
  if (req.url === "/esplora/block-height/0") return send("text/plain", "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f");
  if (req.url.startsWith("/esplora/block-height/")) return send("text/plain", "11".repeat(32));
  if (req.url.startsWith("/esplora/")) return res.writeHead(404).end();
  res.writeHead(503, { "content-type": "text/plain" }).end("unavailable");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.route("**/*", (route) => (new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()));
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(String(e)));
await p.goto(`http://127.0.0.1:${port}/`);
const t0 = Date.now();
while (Date.now() - t0 < 90000) {
  if (await p.evaluate(() => window.__out && window.__out.some(([k]) => k === "DONE" || k === "ERROR"))) break;
  await new Promise((r) => setTimeout(r, 500));
}
const out = await p.evaluate(() => window.__out);
await browser.close();
server.close();
let bad = 0;
for (const [k, ok, v] of out) {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${k}${v !== undefined && !ok ? "  " + JSON.stringify(v) : ""}`);
}
if (errs.length) console.log("pageerror:", errs.join(" | "));
process.exit(bad || errs.length ? 1 : 0);
