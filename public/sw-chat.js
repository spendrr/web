// Chat notifications for the Service Worker (sw.js imports this). A chat push
// carries a slot and a blob the sender encrypted with that contact's preview
// key (docs/chat-push-design.md). The key, the contact's name and the user's
// preview level sit in IndexedDB "spendrr-push", written by the open app
// (src/lib/chat/pushSlots.ts). Nothing here touches the network, the wallet or
// the chat key. The blob layout mirrors src/lib/chat/pushFormat.ts.
/* eslint-disable no-restricted-globals */
(function () {
  const DB_NAME = "spendrr-push";
  const AAD = "spendrr-push-v1";
  const MAX_AGE_S = 24 * 60 * 60;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("slots")) db.createObjectStore("slots");
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function run(db, store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  function b64urlDecode(s) {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function openBlob(key, blob) {
    try {
      const bytes = b64urlDecode(blob);
      const plain = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(AAD) },
          key,
          bytes.slice(12),
        ),
      );
      let end = plain.length;
      while (end > 0 && plain[end - 1] === 0) end--;
      const body = JSON.parse(new TextDecoder().decode(plain.subarray(0, end)));
      return body && body.v === 1 && typeof body.n === "number" && typeof body.k === "string" ? body : null;
    } catch {
      return null;
    }
  }

  function sats(n) {
    return Number(n).toLocaleString("cs-CZ").replace(/\s/g, " ");
  }

  function str(v, max) {
    return typeof v === "string" ? v.slice(0, max) : "";
  }

  // Title and text. `level` is the user's own choice on this device, applied
  // again here whatever the sender put in the blob.
  function describe(body, name, level, count) {
    const showName = level !== "none" && typeof name === "string" && name.length > 0;
    const title = (showName ? "@" + name : "Spendrr") + (count > 1 ? " (" + count + ")" : "");
    if (level === "none") return { title, body: "Nová zpráva" };
    const full = level === "text";
    const amount = full && typeof body.s === "number" && body.s > 0 ? sats(body.s) + " sats" : "";
    const note = full ? str(body.o, 80) : "";
    const tail = (amount ? " " + amount : "") + (note ? " · " + note : "");
    switch (body.k) {
      case "payment":
        return { title, body: "Platba" + tail };
      case "request":
        return { title, body: "Žádost" + tail };
      case "schedule":
        return { title, body: "Opakovaná platba" + tail };
      case "reply":
        return { title, body: "Odpověď na žádost" };
      default:
        return { title, body: (full && str(body.x, 200)) || "Nová zpráva" };
    }
  }

  const FALLBACK = { title: "Spendrr", body: "Nová zpráva", tag: "spendrr-chat", data: {} };

  // What to show for one chat push, or null for a replay (nothing to show).
  async function chatNotification(data, nowMs) {
    if (!data || typeof data.s !== "string" || typeof data.b !== "string") return FALLBACK;
    let db;
    try {
      db = await openDb();
    } catch {
      return FALLBACK;
    }
    try {
      const rec = await run(db, "slots", "readonly", (s) => s.get(data.s));
      if (!rec || !rec.key) return FALLBACK;
      const body = await openBlob(rec.key, data.b);
      if (!body) return FALLBACK;
      if (body.n <= (rec.n || 0)) return null;
      const level = (await run(db, "meta", "readonly", (s) => s.get("level"))) || "text";
      const count = (rec.count || 0) + Math.max(1, Math.min(99, Number(body.c) || 1));
      await run(db, "slots", "readwrite", (s) => s.put({ ...rec, n: body.n, count }, data.s));
      const stale = typeof body.t !== "number" || nowMs / 1000 - body.t > MAX_AGE_S;
      const text = stale ? { title: FALLBACK.title, body: FALLBACK.body } : describe(body, rec.name, level, count);
      return {
        ...text,
        // A payment from the chat replaces the generic payment push and the
        // other way round (sw.js), one per conversation otherwise.
        tag: body.k === "payment" ? "spendrr-payment" : "spendrr-chat-" + data.s,
        data: { chatSlot: data.s, chat: true, at: nowMs },
      };
    } catch {
      return FALLBACK;
    } finally {
      db.close();
    }
  }

  async function unreadTotal() {
    let db;
    try {
      db = await openDb();
      const all = await run(db, "slots", "readonly", (s) => s.getAll());
      return (all || []).reduce((n, r) => n + (r && r.count ? r.count : 0), 0);
    } catch {
      return 0;
    } finally {
      if (db) db.close();
    }
  }

  async function rememberOpen(slot) {
    let db;
    try {
      db = await openDb();
      await run(db, "meta", "readwrite", (s) => s.put({ slot, at: Date.now() }, "pendingOpen"));
    } catch {
      // The app just opens on its home screen.
    } finally {
      if (db) db.close();
    }
  }

  self.spendrrChatPush = { chatNotification, describe, openBlob, unreadTotal, rememberOpen };
})();
