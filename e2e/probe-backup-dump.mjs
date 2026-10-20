// Diagnostic, not a test: what changes in the wallet's IndexedDB between opens?
// The cloud backup skips an upload only when the dump's hash is unchanged, so any
// record that moves on every sync makes every open upload (4 Worker requests).
// Prints, per database and store, which records were added, removed or changed
// between consecutive snapshots.
//   sh e2e/run.sh e2e/probe-backup-dump.mjs
import { launch, newWallet, fundAndBoard, waitForText, lockWallet, mine, triggerRound, PASSWORD } from "./lib.mjs";

const browser = await launch();
const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

// Page side: every record of every store as "key => value" strings (typed
// arrays as hex, so a changed blob shows as a changed record).
async function snapshot(page) {
  return page.evaluate(async () => {
    const enc = (v) => {
      if (v === null || v === undefined) return v;
      if (v instanceof ArrayBuffer) return "ab:" + Array.from(new Uint8Array(v)).map((b) => b.toString(16).padStart(2, "0")).join("");
      if (ArrayBuffer.isView(v)) return "ta:" + Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)).map((b) => b.toString(16).padStart(2, "0")).join("");
      if (v instanceof Date) return "date:" + v.toISOString();
      if (typeof v === "bigint") return "big:" + v.toString();
      if (Array.isArray(v)) return v.map(enc);
      if (typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]));
      return v;
    };
    const out = {};
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const names = Array.from(db.objectStoreNames);
      if (!names.length) {
        db.close();
        continue;
      }
      const tx = db.transaction(names, "readonly");
      for (const s of names) {
        const store = tx.objectStore(s);
        const recs = {};
        await new Promise((res, rej) => {
          const c = store.openCursor();
          c.onsuccess = () => {
            const cur = c.result;
            if (!cur) return res();
            recs[JSON.stringify(enc(cur.key))] = JSON.stringify(enc(cur.value));
            cur.continue();
          };
          c.onerror = () => rej(c.error);
        });
        out[`${name}/${s}`] = recs;
      }
      db.close();
    }
    return out;
  });
}

function diff(a, b, label) {
  console.log(`\n=== ${label} ===`);
  let any = false;
  for (const store of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[store] ?? {};
    const y = b[store] ?? {};
    const added = Object.keys(y).filter((k) => !(k in x));
    const removed = Object.keys(x).filter((k) => !(k in y));
    const changed = Object.keys(y).filter((k) => k in x && x[k] !== y[k]);
    if (!added.length && !removed.length && !changed.length) continue;
    any = true;
    console.log(`${store}: +${added.length} -${removed.length} ~${changed.length} (of ${Object.keys(y).length})`);
    for (const k of changed.slice(0, 2)) {
      const dec = (v) => {
        try {
          const o = JSON.parse(v);
          return Array.isArray(o?.data) ? Buffer.from(o.data).toString("utf8") : v;
        } catch {
          return v;
        }
      };
      const p = dec(x[k]);
      const q = dec(y[k]);
      let i = 0;
      while (i < p.length && p[i] === q[i]) i++;
      console.log(`   ~ ${k.slice(0, 80)} (len ${p.length} -> ${q.length}, first diff at ${i})\n       ${p.slice(Math.max(0, i - 80), i + 120)}\n    -> ${q.slice(Math.max(0, i - 80), i + 120)}`);
    }
    for (const k of added.slice(0, 2)) console.log(`   + ${k.slice(0, 80)} = ${y[k].slice(0, 160)}`);
  }
  if (!any) console.log("identical");
}

async function unlock(page) {
  await page.locator("input[type=password]").first().fill(PASSWORD);
  await page.getByRole("button", { name: /^Odemknout$/ }).click();
}

try {
  const a = await newWallet(browser, "A");
  await fundAndBoard(a.page, 200_000);
  await waitForText(a.page, /Spendrr 199 888 sats/);
  await a.page.waitForTimeout(8_000);
  const s0 = await snapshot(a.page);
  step("snapshot 0 after board");

  await a.page.waitForTimeout(30_000);
  const s1 = await snapshot(a.page);
  diff(s0, s1, "30 s idle, wallet open");

  await lockWallet(a.page);
  await a.page.locator("input[type=password]").first().waitFor({ timeout: 15_000 });
  await unlock(a.page);
  await waitForText(a.page, /Spendrr 199 888 sats/, 60_000);
  await a.page.waitForTimeout(8_000);
  const s2 = await snapshot(a.page);
  diff(s1, s2, "lock + unlock, nothing happened in between");

  await a.page.reload();
  await a.page.locator("input[type=password]").first().waitFor({ timeout: 30_000 });
  await unlock(a.page);
  await waitForText(a.page, /Spendrr 199 888 sats/, 60_000);
  await a.page.waitForTimeout(8_000);
  const s3 = await snapshot(a.page);
  diff(s2, s3, "reload + unlock");
  await lockWallet(a.page);
  await a.page.locator("input[type=password]").first().waitFor({ timeout: 15_000 });
  await mine(3);
  await triggerRound();
  await unlock(a.page);
  await waitForText(a.page, /Spendrr 199 888 sats/, 60_000);
  await a.page.waitForTimeout(10_000);
  const s4 = await snapshot(a.page);
  diff(s3, s4, "3 blocks and an Ark round while locked, then unlock");

  const stripped = (snap) => {
    const r = Object.entries(snap).find(([k]) => k.includes("onchain/bark"));
    const o = JSON.parse(Object.values(r[1])[0]);
    const c = JSON.parse(Buffer.from(o.data).toString("utf8"));
    delete c.local_chain;
    return JSON.stringify(c);
  };
  console.log("\nonchain record equal without local_chain (s3 vs s4):", stripped(s3) === stripped(s4));

  const rec = Object.entries(s3).find(([k]) => k.includes("onchain/"));
  if (rec) {
    const only = Object.values(rec[1])[0];
    const o = JSON.parse(only);
    const text = Buffer.from(o.data).toString("utf8");
    console.log("\nONCHAIN RECORD", text.replace(/"[0-9a-f]{40,}"/g, '"<hex>"').slice(0, 1800));
  }
  console.log("\nDONE");
} catch (e) {
  console.error("FAIL", e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
