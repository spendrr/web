// Paste into the browser console on spendrr.app (or localhost in dev) to see
// what makes the cloud backup big. READ-ONLY: opens the wallet's IndexedDB
// databases without a version (never upgrades anything), walks every record
// and prints counts and sizes per object store. Nothing is written, sent or
// stored, and no key or value is printed, only numbers.
//
// The size is measured the way the backup does it (src/lib/backup/backupStore.ts's
// tagValue: binary values become base64 inside JSON), and each store is also
// gzipped, which is what the backup does before encrypting, so the last column
// is the real predicted saving for THIS wallet.
//
//   1. open the app, unlock (the databases exist either way)
//   2. DevTools console, paste this whole file, press Enter
//   3. read the table; sizes are in kB
(async () => {
  const DBS = ["btc-wallet-mainnet", "btc-wallet-mainnet-onchain", "btc-wallet-gifts", "btc-wallet-vouchers"];

  const b64 = (u8) => {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  // same shape as backupStore.ts's tagged values, close enough for sizing
  const replacer = (_k, v) => {
    if (typeof v === "bigint") return { __t: "bigint", d: v.toString() };
    return v;
  };
  const tag = (v) => {
    if (v === null || v === undefined) return v;
    if (v instanceof ArrayBuffer) return { __t: "ab", d: b64(new Uint8Array(v)) };
    if (ArrayBuffer.isView(v)) {
      const u8 = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      return { __t: "ta", ctor: v.constructor.name, d: b64(u8) };
    }
    if (v instanceof Date) return { __t: "date", iso: v.toISOString() };
    if (v instanceof Map) return { __t: "map", entries: [...v.entries()].map(([a, b]) => [tag(a), tag(b)]) };
    if (v instanceof Set) return { __t: "set", values: [...v.values()].map(tag) };
    if (Array.isArray(v)) return v.map(tag);
    if (typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tag(x)]));
    return v;
  };
  const gz = async (text) => {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    return (await new Response(stream).arrayBuffer()).byteLength;
  };
  const open = (name) =>
    new Promise((resolve) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  const readAll = (db, store) =>
    new Promise((resolve, reject) => {
      const out = [];
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out);
        out.push({ key: tag(c.key), value: tag(c.value) });
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });

  const rows = [];
  let totalRaw = 0;
  let totalGz = 0;
  for (const name of DBS) {
    const existing = indexedDB.databases ? (await indexedDB.databases()).some((d) => d.name === name) : true;
    if (!existing) continue;
    const db = await open(name);
    if (!db) continue;
    for (const store of Array.from(db.objectStoreNames)) {
      const records = await readAll(db, store);
      let biggest = 0;
      for (const r of records) biggest = Math.max(biggest, JSON.stringify(r, replacer).length);
      const text = JSON.stringify(records, replacer);
      const packed = await gz(text);
      totalRaw += text.length;
      totalGz += packed;
      rows.push({
        store: `${name.replace("btc-wallet-", "")}/${store}`,
        records: records.length,
        "json kB": Math.round(text.length / 1024),
        "gzip kB": Math.round(packed / 1024),
        "gzip %": text.length ? Math.round((packed / text.length) * 100) : 0,
        "biggest record kB": Math.round(biggest / 1024),
      });
    }
    db.close();
  }
  rows.sort((a, b) => b["json kB"] - a["json kB"]);
  console.table(rows);
  console.log(
    `TOTAL json ${(totalRaw / 1048576).toFixed(2)} MB -> gzip ${(totalGz / 1048576).toFixed(2)} MB ` +
      `(${totalRaw ? Math.round((totalGz / totalRaw) * 100) : 0} %). Backup upload limit: 20 MB of base64 ciphertext.`,
  );
})();
