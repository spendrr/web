// Authenticated bark records. bark keeps its pending actions (payment checkpoints, round state) in the page
// origin's IndexedDB with no MAC, so any code on the main thread could write one and the next sync() would carry it
// out. The SDK has no hook for its storage, but it reaches IndexedDB only through the worker's own
// `indexedDB` global, so the worker wraps that: every record written to a sealed store gets a MAC under a key
// derived from the seed, and a record read from one without a valid MAC never reaches bark (the read fails with an
// error event, bark fails the call). The main thread shares the origin, so it can still write or delete the records, but cannot make
// one that verifies.
//
// What this is not: freshness (an old valid record can be put back at its canonical key; it pays what it paid before),
// protection from deletion (a denial, not a theft), or a boundary for a passwordless wallet (its seed is on the main
// thread). A valid value copied under a different primary key is rejected: bark deletes only the canonical key when an
// action finishes, so accepting such a copy would turn every finished action into a persistent replay.
//
// Rules:
// - Install before the SDK module is evaluated (wallet.worker.ts), like the network guards.
// - Verification is a success listener added when the read request is made, so it runs before any handler bark sets
//   or adds. It must not throw from the `result` getter instead: that panics the WASM (checked, `unreachable`).
// - Only DB `dbName` and only SEALED_STORES. Other stores and databases pass through untouched.
// - A record without a valid MAC is never trusted silently: it stays until the user accepts it with the password
//   (acceptUnverified), which is also how records from before this existed, and from an old backup, get signed.
// - The HKDF info string must never change in place: a new one orphans every sealed record. New derivation = new
//   versioned string plus a migration.
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// bark 0.7.1 / SDK 0.25.0: store `bark.v1.<partition>`, 5 = round state, 14 = wallet action checkpoints. A test pins
// the names; an SDK bump re-checks them (docs: bump checklist).
export const SEALED_STORES: readonly string[] = ["bark.v1.5", "bark.v1.14"];
export const RECORD_UNVERIFIED = "BARK_RECORDS_UNVERIFIED";

const SEAL_HKDF_INFO = "spendrr-bark-record-seal-v1";
const MAC_DOMAIN = "spendrr-bark-record-mac-v1";
const enc = new TextEncoder();

// `seed` is the BIP39 seed; the caller owns (and zeroes) it. Synchronous on purpose: the IndexedDB hooks cannot await.
export function deriveRecordSealKey(seed: Uint8Array): Uint8Array {
  return hkdf(sha256, seed, new Uint8Array(0), enc.encode(SEAL_HKDF_INFO), 32);
}

function bytesOf(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v) && v.every((x) => Number.isInteger(x) && x >= 0 && x < 256)) return Uint8Array.from(v as number[]);
  return null;
}

// What the MAC covers: domain, database, store and every field except `mac`, sorted by name. Byte fields (an array
// of numbers or a typed array, however bark or the structured clone returns them) hash the same.
function canonical(dbName: string, store: string, rec: Record<string, unknown>): Uint8Array {
  const parts = [MAC_DOMAIN, dbName, store];
  for (const k of Object.keys(rec).filter((x) => x !== "mac").sort()) {
    const v = rec[k];
    const b = bytesOf(v);
    if (b !== null) parts.push(`${k}=b:${bytesToHex(b)}`);
    else if (typeof v === "bigint") parts.push(`${k}=n:${v.toString()}`);
    else parts.push(`${k}=j:${JSON.stringify(v) ?? "undefined"}`);
  }
  // Every part carries its own byte length, so no field value can contain a separator that shifts a boundary
  // (a name ending in "\0" next to a value starting with one would otherwise read the same as two other fields).
  return enc.encode(parts.map((p) => `${enc.encode(p).length}:${p}`).join(""));
}

export function recordMac(key: Uint8Array, dbName: string, store: string, rec: Record<string, unknown>): string {
  return bytesToHex(hmac(sha256, key, canonical(dbName, store, rec)));
}

// bark's stores have no keyPath: the primary key is the lowercase hex encoding of the record's `pk`. The key itself is
// not in `value`, so every read has to fetch it as well as the value. Otherwise copying a valid value to another key
// passes the MAC and leaves a stale action behind after bark removes the canonical row.
function hasCanonicalPrimaryKey(rec: Record<string, unknown>, primaryKey: IDBValidKey | undefined): boolean {
  const pk = bytesOf(rec.pk);
  return pk !== null && typeof primaryKey === "string" && primaryKey === bytesToHex(pk);
}

export function recordIsValid(
  key: Uint8Array,
  dbName: string,
  store: string,
  rec: unknown,
  primaryKey: IDBValidKey | undefined,
): boolean {
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return false;
  const r = rec as Record<string, unknown>;
  if (typeof r.mac !== "string" || !hasCanonicalPrimaryKey(r, primaryKey)) return false;
  let want: string;
  try {
    want = recordMac(key, dbName, store, r);
  } catch {
    // Structured clone preserves nested BigInts and cycles, neither of which JSON.stringify accepts. An exception in
    // an IndexedDB success listener is merely reported and does NOT stop bark's own listener, so verification must
    // fail closed here instead of throwing and letting the forged value through.
    return false;
  }
  if (want.length !== r.mac.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ r.mac.charCodeAt(i);
  return diff === 0;
}

export interface UnverifiedRecord {
  store: string;
  id: string;
  kind: string | null;
}

// The only record kinds the sheet names. `kind` comes from the record itself, which is exactly what a forged record
// controls, so anything else is shown as no kind at all instead of attacker-chosen text in a security dialog.
export const KNOWN_RECORD_KINDS: readonly string[] = ["LightningSend", "LightningReceive"];
const MAX_ID_CHARS = 80;

export function describeRecord(store: string, rec: unknown): UnverifiedRecord {
  const r = (rec ?? {}) as Record<string, unknown>;
  const pk = bytesOf(r.pk);
  const data = bytesOf(r.data);
  let kind: string | null = null;
  if (data) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(data)) as unknown;
      if (parsed && typeof parsed === "object") {
        const first = Object.keys(parsed as object)[0];
        kind = first !== undefined && KNOWN_RECORD_KINDS.includes(first) ? first : null;
      }
    } catch {
      kind = null;
    }
  }
  // Printable ASCII only and bounded: the id is shown, and it is what accept() matches on, so listing and accepting agree.
  const id = pk ? new TextDecoder().decode(pk.subarray(0, MAX_ID_CHARS * 4)).slice(0, MAX_ID_CHARS).replace(/[^\x20-\x7e]/g, "?") : "?";
  return { store, id, kind };
}

// ---------------------------------------------------------------------------------------------------------------
// The hook

interface SealState {
  enabled: boolean;
  dbName: string;
  key: Uint8Array | null;
  violations: UnverifiedRecord[];
  // Counts every refused read, never reset: the worker reports it with each answer so the UI asks only on a change.
  total: number;
}

// More than this many distinct held-back records are never listed at once (a flood of forged rows must not grow memory).
export const MAX_LISTED_VIOLATIONS = 50;
const state: SealState = { enabled: false, dbName: "", key: null, violations: [], total: 0 };

function noteViolation(v: UnverifiedRecord): void {
  state.total++;
  if (state.violations.length >= MAX_LISTED_VIOLATIONS) return;
  if (state.violations.some((x) => x.store === v.store && x.id === v.id)) return;
  state.violations.push(v);
}
let installed = false;

interface Native {
  put: IDBObjectStore["put"];
  add: IDBObjectStore["add"];
  delete: IDBObjectStore["delete"];
  update: IDBCursor["update"];
  getAll: IDBObjectStore["getAll"];
  getAllKeys: IDBObjectStore["getAllKeys"];
}
let native: Native | null = null;

export const recordSeal = {
  // Called by the worker when a session opens with the seal on. `key` null (derivation failed) fails closed: every
  // sealed read and write throws until the next open.
  enable(dbName: string, key: Uint8Array | null): void {
    state.dbName = dbName;
    state.key = key ? key.slice() : null;
    state.violations = [];
    state.total = 0;
    state.enabled = true;
  },
  disable(): void {
    state.enabled = false;
    state.key?.fill(0);
    state.key = null;
  },
  isEnabled: () => state.enabled,
  violationCount: () => state.total,
  violations: () => state.violations.slice(),
};

function storeOfSource(source: unknown): IDBObjectStore | null {
  if (typeof IDBObjectStore !== "undefined" && source instanceof IDBObjectStore) return source;
  if (typeof IDBIndex !== "undefined" && source instanceof IDBIndex) return source.objectStore;
  return null;
}

function isSealed(store: IDBObjectStore | null): store is IDBObjectStore {
  if (!state.enabled || store === null) return false;
  if (!SEALED_STORES.includes(store.name)) return false;
  try {
    return store.transaction.db.name === state.dbName;
  } catch {
    return false;
  }
}

function signRecord(store: string, value: unknown, primaryKey: IDBValidKey | undefined): Record<string, unknown> {
  if (state.key === null) throw new DOMException("record seal key missing", "InvalidStateError");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DOMException("sealed store takes object records only", "DataError");
  }
  const rec = { ...(value as Record<string, unknown>) };
  if (!hasCanonicalPrimaryKey(rec, primaryKey)) {
    throw new DOMException("sealed record primary key does not match pk", "DataError");
  }
  delete rec.mac;
  return { ...rec, mac: recordMac(state.key, state.dbName, store, rec) };
}

export function installRecordSeal(): void {
  if (installed || typeof IDBObjectStore === "undefined") return;
  installed = true;
  const OS = IDBObjectStore.prototype;
  const IX = IDBIndex.prototype;
  const nativeUpdate = IDBCursor.prototype.update;
  native = { put: OS.put, add: OS.add, delete: OS.delete, update: nativeUpdate, getAll: OS.getAll, getAllKeys: OS.getAllKeys };

  // Which requests carry stored records: those made by get / getAll / openCursor on a sealed store or an index of it.
  // Each gets a success listener registered at creation, so it runs before any handler bark sets or adds. A record
  // that fails its MAC never reaches bark's success handler: the event is stopped and the request fails with an
  // error event instead (bark reports a failed read). Throwing from the `result` getter would panic the WASM.
  const resultGet = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "result")!.get!;
  const valueGet = Object.getOwnPropertyDescriptor(IDBCursorWithValue.prototype, "value")!.get!;
  const primaryKeyGet = Object.getOwnPropertyDescriptor(IDBCursor.prototype, "primaryKey")!.get!;
  // A cursor hands bark one record per success event, and bark's WASM cannot take an error event in the middle of an
  // iteration: the read hangs and the module panics (`unreachable`), measured with a valid record followed by a forged
  // one. So the first success of a guarded cursor also checks every record in its range (`scan`, queued ahead of the
  // cursor in the same transaction, so nothing can change in between). A forged record anywhere then fails the read
  // at its first step, which is the same clean error a lone forged record produces.
  interface Scan {
    keys: IDBRequest<IDBValidKey[]>;
    recs: IDBRequest<unknown[]>;
  }
  const guard = (storeName: string, keysReq: IDBRequest<IDBValidKey[]> | null, scan: Scan | null) => {
    let scanned = false;
    return function (this: IDBRequest, ev: Event) {
      const r = resultGet.call(this) as unknown;
      let keys: IDBValidKey[] | undefined;
      try {
        // getAllKeys was queued before get/getAll in the same readonly transaction, so its result is ready now. Never
        // let an unexpected getter failure escape the listener: browser event dispatch would continue into bark.
        keys = keysReq === null ? undefined : (resultGet.call(keysReq) as IDBValidKey[]);
      } catch {
        keys = undefined;
      }
      let ok = true;
      let bad: unknown = null;
      const test = (rec: unknown, primaryKey: IDBValidKey | undefined) => {
        try {
          if (state.key !== null && recordIsValid(state.key, state.dbName, storeName, rec, primaryKey)) return;
        } catch {
          // Fail closed below. No exception from untrusted structured-clone data may escape this listener.
        }
        if (ok) bad = rec;
        ok = false;
      };
      if (r === null || r === undefined) return;
      if (r instanceof IDBCursorWithValue && scan !== null && !scanned) {
        scanned = true;
        try {
          const recs = resultGet.call(scan.recs) as unknown[];
          const ks = resultGet.call(scan.keys) as IDBValidKey[];
          recs.forEach((rec, i) => test(rec, ks[i]));
        } catch {
          test(null, undefined); // the range could not be read back: fail closed
        }
      }
      if (r instanceof IDBCursorWithValue) test(valueGet.call(r), primaryKeyGet.call(r));
      else if (r instanceof IDBCursor) return;
      else if (Array.isArray(r)) r.forEach((rec, i) => test(rec, keys?.[i]));
      else test(r, keys?.[0]);
      if (ok) return;
      // Stop bark first, then describe the attacker-controlled value. Even a diagnostic failure must not resume success.
      ev.stopImmediatePropagation();
      try {
        noteViolation(describeRecord(storeName, bad));
      } catch {
        noteViolation({ store: storeName, id: "?", kind: null });
      }
      Object.defineProperty(this, "error", {
        configurable: true,
        value: new DOMException("record authentication failed", "DataError"),
      });
      this.dispatchEvent(new Event("error"));
    };
  };
  for (const proto of [OS, IX] as const) {
    const nativeGetAllKeys = (proto as unknown as Record<string, (...a: unknown[]) => IDBRequest<IDBValidKey[]>>).getAllKeys;
    const nativeGetAllRecs = (proto as unknown as Record<string, (...a: unknown[]) => IDBRequest<unknown[]>>).getAll;
    for (const name of ["get", "getAll", "openCursor"] as const) {
      const orig = (proto as unknown as Record<string, (...a: unknown[]) => IDBRequest>)[name];
      if (typeof orig !== "function") continue;
      Object.defineProperty(proto, name, {
        configurable: true,
        writable: true,
        value: function (this: IDBObjectStore | IDBIndex, ...args: unknown[]) {
          const store = storeOfSource(this);
          const sealed = isSealed(store);
          let keysReq: IDBRequest<IDBValidKey[]> | null = null;
          // Values alone do not contain their out-of-line primary key. Fetch matching keys first (one key for get).
          // Both requests are readonly and ordered in the same transaction. Missing getAllKeys support fails closed.
          if (sealed && name !== "openCursor" && typeof nativeGetAllKeys === "function") {
            keysReq = nativeGetAllKeys.apply(this, name === "get" ? [args[0], 1] : args);
          }
          let scan: Scan | null = null;
          if (sealed && name === "openCursor" && typeof nativeGetAllKeys === "function" && typeof nativeGetAllRecs === "function") {
            scan = { keys: nativeGetAllKeys.apply(this, [args[0]]), recs: nativeGetAllRecs.apply(this, [args[0]]) };
          }
          const req = orig.apply(this, args);
          if (sealed) req.addEventListener("success", guard(store.name, keysReq, scan));
          return req;
        },
      });
    }
  }

  for (const name of ["put", "add"] as const) {
    const orig = native[name] as (this: IDBObjectStore, v: unknown, k?: IDBValidKey) => IDBRequest;
    Object.defineProperty(OS, name, {
      configurable: true,
      writable: true,
      value: function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        return orig.call(this, isSealed(this) ? signRecord(this.name, value, key) : value, key);
      },
    });
  }
  Object.defineProperty(IDBCursor.prototype, "update", {
    configurable: true,
    writable: true,
    value: function (this: IDBCursor, value: unknown) {
      const store = storeOfSource(this.source);
      return nativeUpdate.call(this, isSealed(store) ? signRecord(store.name, value, this.primaryKey) : value);
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Records that exist but do not verify (from before the seal, an old backup, or someone else)

function openRaw(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject2) => {
    const req = indexedDB.open(dbName);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject2(req.error ?? new Error("bark db open failed"));
    req.onblocked = () => reject2(new Error("bark db blocked"));
  });
}

function nativeRequest<T>(req: IDBRequest<T>): Promise<T> {
  // Read through the native getter: these requests were made by the native methods, so they are not watched.
  return new Promise((resolve, reject2) => {
    req.addEventListener("success", () => resolve(req.result));
    req.addEventListener("error", () => reject2(req.error ?? new Error("bark db read failed")));
  });
}

interface Entry {
  store: string;
  key: IDBValidKey;
  rec: Record<string, unknown>;
}

async function unverifiedEntries(db: IDBDatabase, key: Uint8Array): Promise<Entry[]> {
  if (native === null) throw new Error("record seal not installed");
  const out: Entry[] = [];
  for (const name of SEALED_STORES) {
    if (!db.objectStoreNames.contains(name)) continue;
    const store = db.transaction(name, "readonly").objectStore(name);
    // Both requests before the first await: the transaction must still be active when they are made.
    const [keys, recs] = (await Promise.all([
      nativeRequest(native.getAllKeys.call(store)),
      nativeRequest(native.getAll.call(store)),
    ])) as [IDBValidKey[], unknown[]];
    recs.forEach((rec, i) => {
      if (!recordIsValid(key, state.dbName, name, rec, keys[i])) {
        out.push({ store: name, key: keys[i], rec: (rec ?? {}) as Record<string, unknown> });
      }
    });
  }
  return out;
}

export async function listUnverified(): Promise<UnverifiedRecord[]> {
  if (!state.enabled || state.key === null) return [];
  const db = await openRaw(state.dbName);
  try {
    // A forged flood must not become a huge answer or sheet: the first MAX_LISTED_VIOLATIONS, the rest get their own sheet
    // once these are dealt with.
    return (await unverifiedEntries(db, state.key)).slice(0, MAX_LISTED_VIOLATIONS).map((e) => describeRecord(e.store, e.rec));
  } finally {
    db.close();
  }
}

// The user has seen them and given the password: sign canonical records. A value under a non-canonical key can never be
// a legitimate bark row, so discard that copy instead of blessing a replay that bark could not later delete. Returns how
// many were signed.
export async function acceptUnverified(only?: readonly { store: string; id: string }[]): Promise<number> {
  if (!state.enabled || state.key === null || native === null) return 0;
  const db = await openRaw(state.dbName);
  try {
    // Only what the sheet showed: a record that appeared after it was drawn stays held back and gets its own sheet.
    const entries = (await unverifiedEntries(db, state.key)).filter((e) => {
      if (only === undefined) return true;
      const d = describeRecord(e.store, e.rec);
      return only.some((o) => o.store === d.store && o.id === d.id);
    });
    let accepted = 0;
    for (const e of entries) {
      const canonicalKey = hasCanonicalPrimaryKey(e.rec, e.key);
      const rec = { ...e.rec };
      delete rec.mac;
      const signed = canonicalKey ? { ...rec, mac: recordMac(state.key, state.dbName, e.store, rec) } : null;
      const tx = db.transaction(e.store, "readwrite");
      const done = new Promise<void>((resolve, reject2) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject2(tx.error ?? new Error("bark db write failed"));
        tx.onabort = () => reject2(tx.error ?? new Error("bark db write aborted"));
      });
      if (signed === null) native.delete.call(tx.objectStore(e.store), e.key);
      else native.put.call(tx.objectStore(e.store), signed, e.key);
      await done;
      if (signed !== null) accepted++;
    }
    state.violations = only === undefined ? [] : state.violations.filter((v) => !only.some((o) => o.store === v.store && o.id === v.id));
    return accepted;
  } finally {
    db.close();
  }
}
