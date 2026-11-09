// Where the spend limits live: IndexedDB, AES-GCM under a key derived from the wallet seed (HKDF, its own info
// string), the wallet id as associated data. Worker only, like the chat key: the seed never leaves that realm.
//
// What this is and is not. The main thread shares the origin and can write this database, but cannot forge a
// record that authenticates without the seed, so a damaged or foreign record reads as "unreadable" and the
// keeper falls back to the strictest setting (password for every send). It can delete the record, which resets
// the limits to the defaults: that is why these limits are a brake and not a boundary (see spendLimits.ts).
// The info string must never change in place: a new one orphans every stored record. New derivation = new
// versioned string plus a migration.
import { decodeRecord, encodeRecord, type LimitsRecord } from "./spendLimits";
import type { LimitsLoad, LimitsStore } from "./limitsKeeper";

const LIMITS_HKDF_INFO = "spendrr-limits-key-v1";
const DB_NAME = "spendrr-limits-v1";
const STORE = "records";

// `seed` is the BIP39 seed; the caller owns (and zeroes) it.
export async function deriveLimitsKey(seed: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", seed as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(LIMITS_HKDF_INFO) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("limits db open failed"));
    req.onblocked = () => reject(new Error("limits db blocked"));
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("limits read failed"));
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("limits write failed"));
    tx.onabort = () => reject(tx.error ?? new Error("limits write aborted"));
  });
}

interface StoredBlob {
  iv: Uint8Array;
  ct: ArrayBuffer;
}

function isStoredBlob(v: unknown): v is StoredBlob {
  if (typeof v !== "object" || v === null) return false;
  const b = v as Record<string, unknown>;
  return b.iv instanceof Uint8Array && b.iv.length === 12 && b.ct instanceof ArrayBuffer;
}

export function createIdbLimitsStore(walletId: string, key: CryptoKey): LimitsStore {
  const aad = new TextEncoder().encode(`spendrr-limits-v1:${walletId}`);
  return {
    async load(): Promise<LimitsLoad> {
      const db = await openDb();
      try {
        const raw = await idbGet(db, walletId);
        if (raw === undefined) return { kind: "none" };
        if (!isStoredBlob(raw)) return { kind: "unreadable" };
        let plain: Uint8Array;
        try {
          plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.iv as BufferSource, additionalData: aad }, key, raw.ct));
        } catch {
          return { kind: "unreadable" };
        }
        const record = decodeRecord(new TextDecoder().decode(plain));
        plain.fill(0);
        return record ? { kind: "ok", record } : { kind: "unreadable" };
      } finally {
        db.close();
      }
    },
    async save(record: LimitsRecord): Promise<void> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plain = new TextEncoder().encode(encodeRecord(record));
      let ct: ArrayBuffer;
      try {
        ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, plain);
      } finally {
        plain.fill(0);
      }
      const db = await openDb();
      try {
        await idbPut(db, walletId, { iv, ct } satisfies StoredBlob);
      } finally {
        db.close();
      }
    },
  };
}
