// Schema-agnostic dump/restore of the wallet's raw IndexedDB state, for the
// encrypted cloud backup feature (see ARCHITECTURE.md's backup section).
//
// Deliberately generic — cursor-walks every object store's every record
// rather than hand-modeling the SDK's internal schema — so this survives
// @secondts/bark upgrades that change its internal store/index layout
// without this file needing to track them. Plain browser IndexedDB, not
// WASM: see bark.ts's deleteWalletDb() for the existing precedent that these
// two databases are safely openable from the main thread.
//
// Same DB name literals as bark.ts's deleteWalletDb() (which duplicates
// walletWorkerImpl.ts's DB_NAME/ONCHAIN_DB_NAME constants, since those only
// exist inside the worker bundle) — keep both in sync if either ever changes.
export const ARK_DB_NAME = "btc-wallet-mainnet";
export const ONCHAIN_DB_NAME = "btc-wallet-mainnet-onchain";

import { toB64, fromB64 } from "../vault/crypto";

// --- Structured-clone-safe value tagging -----------------------------------
// IndexedDB values can hold types JSON can't represent directly (ArrayBuffer,
// typed arrays, DataView, Date, Map, Set — all things wasm-bindgen-backed
// stores commonly use for binary VTXO/transaction data). Tag them explicitly
// on the way out, untag on the way in. Anything not listed here falls through
// to plain JSON-compatible handling.

type Tagged =
  | { __t: "ab"; d: string }
  | { __t: "ta"; ctor: string; d: string }
  | { __t: "dv"; d: string }
  | { __t: "date"; iso: string }
  | { __t: "map"; entries: [unknown, unknown][] }
  | { __t: "set"; values: unknown[] }
  | { __t: "bigint"; d: string };

const TYPED_ARRAY_CTORS: Record<string, new (buf: ArrayBuffer) => ArrayBufferView> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
};

// Exported only for the JSON-round-trip regression test (tests/backupStore.test.ts)
// — the bigint case above is exactly the kind of bug that test exists to
// catch (a value that tags/untags fine in memory but breaks specifically at
// the JSON.stringify step in between, which a pure in-memory round trip
// wouldn't have caught).
export function tagValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof ArrayBuffer) {
    return { __t: "ab", d: toB64(value) } satisfies Tagged;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    const sliced = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
    if (value instanceof DataView) return { __t: "dv", d: toB64(sliced) } satisfies Tagged;
    return { __t: "ta", ctor: value.constructor.name, d: toB64(sliced) } satisfies Tagged;
  }
  if (value instanceof Date) return { __t: "date", iso: value.toISOString() } satisfies Tagged;
  if (value instanceof Map) {
    return { __t: "map", entries: Array.from(value.entries()).map(([k, v]) => [tagValue(k), tagValue(v)]) } satisfies Tagged;
  }
  if (value instanceof Set) {
    return { __t: "set", values: Array.from(value.values()).map(tagValue) } satisfies Tagged;
  }
  if (Array.isArray(value)) return value.map(tagValue);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = tagValue(v);
    return out;
  }
  // bigint is a real value IndexedDB (structured clone) allows directly —
  // observed in practice from the wallet's own stored records (likely u64
  // amounts/heights crossing the wasm-bindgen boundary) — and JSON.stringify
  // throws outright on an untagged one ("Do not know how to serialize a
  // BigInt"), silently killing every backup upload with nothing to show for
  // it but a failed attempt. Must be tagged like every other non-JSON type.
  if (typeof value === "bigint") return { __t: "bigint", d: value.toString() } satisfies Tagged;
  return value; // string, number, boolean
}

export function untagValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "object" && "__t" in (value as Record<string, unknown>)) {
    const tagged = value as Tagged;
    switch (tagged.__t) {
      case "ab":
        return fromB64(tagged.d).buffer;
      case "dv":
        return new DataView(fromB64(tagged.d).buffer);
      case "ta": {
        const Ctor = TYPED_ARRAY_CTORS[tagged.ctor];
        if (!Ctor) throw new Error(`Unknown typed array constructor in backup: ${tagged.ctor}`);
        return new Ctor(fromB64(tagged.d).buffer as ArrayBuffer);
      }
      case "date":
        return new Date(tagged.iso);
      case "map":
        return new Map(tagged.entries.map(([k, v]) => [untagValue(k), untagValue(v)]));
      case "set":
        return new Set(tagged.values.map(untagValue));
      case "bigint":
        return BigInt(tagged.d);
    }
  }
  if (Array.isArray(value)) return value.map(untagValue);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = untagValue(v);
    return out;
  }
  return value;
}

// --- Dump --------------------------------------------------------------

interface SerializedIndex {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}

interface SerializedStore {
  keyPath: string | string[] | null;
  indexes: SerializedIndex[];
  records: { key: unknown; value: unknown }[];
}

export interface SerializedDb {
  name: string;
  version: number;
  stores: Record<string, SerializedStore>;
}

function openExisting(dbName: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    // No version argument: opens at whatever version already exists without
    // forcing an upgrade. If the DB doesn't exist yet, this call itself
    // *creates* an empty v1 DB as a side effect (IndexedDB's own behavior)
    // — callers that only want to dump existing data should check
    // objectStoreNames.length and treat 0 as "nothing to dump" instead of
    // failing.
    const req = indexedDB.open(dbName);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error(`Failed to open ${dbName}`));
    req.onblocked = () => reject(new Error(`Open ${dbName} blocked by another connection`));
  });
}

export async function dumpDatabase(dbName: string): Promise<SerializedDb | null> {
  const db = await openExisting(dbName);
  if (!db) return null;
  try {
    const storeNames = Array.from(db.objectStoreNames);
    if (storeNames.length === 0) return null; // Nothing to dump (DB never populated).

    // One transaction across every store, not one per store — IndexedDB
    // gives a readonly transaction snapshot isolation, so this is what makes
    // the dump internally consistent. A separate transaction per store used
    // to let a concurrent writer (the SDK's own sync()/maintenance(), which
    // can run at any time — including mid-dump, since uploads aren't
    // exclusive with normal wallet activity) be interleaved between them:
    // one store could see a VTXO as already spent while another store,
    // dumped moments later, still had the pre-spend state — a backup that
    // never existed as a real point-in-time snapshot on this device.
    const tx = db.transaction(storeNames, "readonly");
    const storeDumps = await Promise.all(
      storeNames.map(
        (storeName) =>
          new Promise<SerializedStore>((resolve, reject) => {
            const store = tx.objectStore(storeName);
            // Indexes matter, not just keyPath/records: the SDK's own reads
            // (e.g. whatever backs wallet.history()'s ordering) query via a
            // named secondary index, not just primary-key order — confirmed
            // live, a restore that only recreated bare stores produced a
            // real "failed to query sorted records: ... DoesNotExist" error
            // the moment the SDK tried to open an index restore never
            // recreated.
            const indexes: SerializedIndex[] = Array.from(store.indexNames).map((indexName) => {
              const index = store.index(indexName);
              return {
                name: index.name,
                keyPath: index.keyPath as string | string[],
                unique: index.unique,
                multiEntry: index.multiEntry,
              };
            });
            const records: { key: unknown; value: unknown }[] = [];
            const cursorReq = store.openCursor();
            cursorReq.onerror = () => reject(cursorReq.error ?? new Error(`Cursor failed on ${storeName}`));
            cursorReq.onsuccess = () => {
              const cursor = cursorReq.result;
              if (!cursor) {
                resolve({ keyPath: store.keyPath as string | string[] | null, indexes, records });
                return;
              }
              records.push({ key: tagValue(cursor.key), value: tagValue(cursor.value) });
              cursor.continue();
            };
          }),
      ),
    );
    const stores: Record<string, SerializedStore> = {};
    storeNames.forEach((name, i) => {
      stores[name] = storeDumps[i];
    });
    return { name: dbName, version: db.version, stores };
  } finally {
    db.close();
  }
}

// Cheap existence check used by App.tsx to decide whether an *unlock* (not
// just import/recovery) should also attempt a server restore before its
// normal post-open backup upload — see that call site for the full incident
// this guards against. Uses count() per store rather than dumpDatabase's
// full cursor walk: this runs on every unlock, including the overwhelmingly
// common case where local data is present and large, so it must stay O(1)
// per store rather than re-reading the whole wallet history just to answer
// a yes/no question.
//
// Deliberately does NOT reuse openExisting() for a name it hasn't first
// confirmed exists via indexedDB.databases(). This function's only caller
// runs it *before* the SDK has ever opened either DB this session (same
// precondition as restoreDatabase() below) — openExisting()'s own
// versionless indexedDB.open() silently creates an empty v1 database as a
// side effect when the name doesn't exist yet (see its own comment). The
// SDK's real first-ever open requests an explicit version compiled into the
// WASM binary (confirmed against @secondts/bark's glue: `idb.open(name,
// version)`); if that version happened to be 1, a stray v1 shell already
// sitting there from this check would make IndexedDB see "already at the
// requested version" and skip onupgradeneeded entirely — leaving the SDK
// with a permanently storeless database. Checking via databases() first
// (pure enumeration, creates nothing) means openExisting() only ever runs
// against a name already confirmed to exist.
async function dbHasAnyRecords(dbName: string): Promise<boolean> {
  const db = await openExisting(dbName);
  if (!db) return false;
  try {
    const storeNames = Array.from(db.objectStoreNames);
    if (storeNames.length === 0) return false;
    const tx = db.transaction(storeNames, "readonly");
    const counts = await Promise.all(
      storeNames.map(
        (name) =>
          new Promise<number>((resolve, reject) => {
            const req = tx.objectStore(name).count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error ?? new Error(`count failed on ${name}`));
          }),
      ),
    );
    return counts.some((c) => c > 0);
  } finally {
    db.close();
  }
}

export async function hasAnyLocalWalletData(): Promise<boolean> {
  const existing = await indexedDB.databases();
  const existingNames = new Set(existing.map((d) => d.name));
  const namesToCheck = [ARK_DB_NAME, ONCHAIN_DB_NAME].filter((name) => existingNames.has(name));
  if (namesToCheck.length === 0) return false;
  const results = await Promise.all(namesToCheck.map(dbHasAnyRecords));
  return results.some(Boolean);
}

// Read-only diagnostic for the "is this the onchain address-bloat incident
// again?" question (see ARCHITECTURE.md / the 2026-09-06 incident note): reports
// each store's record count without walking every record like dumpDatabase()
// does. Safe to call while the wallet is open — a plain versionless open plus
// count() never requests a version bump, so it can't collide with the SDK's
// own live connection the way a restore's version-bumped open could (see
// restoreDatabase()'s precondition comment above; that concern doesn't apply
// here). Only called on demand from Settings, never on a hot path.
export async function getDbStoreCounts(dbName: string): Promise<Record<string, number> | null> {
  const existing = await indexedDB.databases();
  if (!existing.some((d) => d.name === dbName)) return null;
  const db = await openExisting(dbName);
  if (!db) return null;
  try {
    const storeNames = Array.from(db.objectStoreNames);
    if (storeNames.length === 0) return {};
    const tx = db.transaction(storeNames, "readonly");
    const counts = await Promise.all(
      storeNames.map(
        (name) =>
          new Promise<number>((resolve, reject) => {
            const req = tx.objectStore(name).count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error ?? new Error(`count failed on ${name}`));
          }),
      ),
    );
    const result: Record<string, number> = {};
    storeNames.forEach((name, i) => {
      result[name] = counts[i];
    });
    return result;
  } finally {
    db.close();
  }
}

// --- Restore -------------------------------------------------------------

// Creates dbName from scratch — at the dump's own recorded version, with
// every store (and its recorded keyPath) the dump has — then writes every
// record, all inside the DB's *first ever* open. Must only be called before
// anything else has ever touched dbName this session (see App.tsx: the
// whole restore happens before the SDK's own first openWallet() call, not
// after it, not sandwiched between a close and a reopen).
//
// This replaced an earlier close-the-live-wallet-then-restore-then-reopen
// design that hit two real, only-caught-by-a-live-recovery-test bugs:
// (1) restoreDatabase() only ever wrote into stores the fresh open already
// had, silently dropping any store the SDK creates lazily on first real use
// (history/movement tracking, in practice) instead of upfront; (2) even
// after fixing that to create missing stores via a version-bump, the
// version-bump could get stuck on IndexedDB's `blocked` event — closeWallet()
// resolving on the main thread doesn't guarantee the WASM side has actually
// released its own connection to the same DB yet, and a dangling blocked
// open request left the DB in an inconsistent state once the second
// openWallet() proceeded anyway ("failed to query sorted records: Cannot
// change something that does not exists"). Doing the *entire* restore
// before the DB has ever been opened this session removes the race
// entirely: nothing else can be holding a connection to a database name
// this session has never opened yet.
//
// Indexes are recreated too, not just keyPath — confirmed necessary live: a
// version without this produced a real "failed to query sorted records: ...
// DoesNotExist" the moment the SDK opened a named index restore hadn't
// recreated (almost certainly what backs wallet.history()'s ordering).
// The object stores a database currently has. Only ever called for a name
// indexedDB.databases() has already confirmed exists — that precondition is
// what makes the versionless open safe here, and it is not safe in general
// (see hasAnyLocalWalletData()'s comment: on a name that doesn't exist yet
// the same call creates an empty v1 shell as a side effect).
async function listStoreNames(dbName: string): Promise<Set<string>> {
  const db = await openExisting(dbName);
  if (!db) return new Set();
  try {
    return new Set(Array.from(db.objectStoreNames));
  } finally {
    db.close();
  }
}

// Which version to open a restore target at.
//
// Opening at the version a database already sits at fires no
// onupgradeneeded — and that handler is the only place a missing object
// store ever gets created. So when the existing version is already >= the
// dump's, a store the dump has but the database lacks would never be
// created, and restoreDatabase's write (which can only target stores that
// exist) would drop that store's records on the floor.
//
// That is reachable, not theoretical: the SDK creates some of its stores
// lazily on first real use, so a never-used database sitting at a *newer*
// schema version than this backup legitimately has fewer stores than the
// dump — and "no records in any store" is exactly the condition App.tsx
// triggers an unlock-time restore on. Silently dropping those stores would
// be the worst shape of failure available here: restoreSucceeded would
// still be true, the failure latch would be cleared, and the one-shot
// upload right after would commit the partial state back over the single
// server-side blob, irreversibly.
//
// So: bump one past the existing version whenever a dump store is missing,
// which makes the upgrade handler run and fill it in. `presentStores` is a
// thunk because answering it costs another database open — not worth paying
// on the common path where dump.version already forces an upgrade anyway.
export async function chooseRestoreVersion(
  existingVersion: number,
  dumpVersion: number,
  presentStores: () => Promise<Set<string>>,
  dumpStoreNames: readonly string[],
): Promise<number> {
  if (dumpVersion > existingVersion) return dumpVersion; // Upgrade fires on its own.
  const present = await presentStores();
  if (dumpStoreNames.some((name) => !present.has(name))) return existingVersion + 1;
  return existingVersion;
}

export async function restoreDatabase(dbName: string, dump: SerializedDb): Promise<void> {
  const dumpStoreNames = Object.keys(dump.stores);
  if (dumpStoreNames.length === 0) return;

  // Never request a version *lower* than one that already exists — plain
  // indexedDB.open(dbName, v) throws a VersionError outright if v is below
  // the DB's current version, and that's now reachable in practice: App.tsx
  // can trigger a restore on a plain unlock (not just import) whenever the
  // local DB has zero records in every store — which includes a genuinely
  // never-used wallet whose DB nonetheless already exists at whatever
  // version the SDK's current schema is, which may be newer than whatever
  // version this backup was taken at. Checked via indexedDB.databases()
  // (pure enumeration, creates nothing) rather than the versionless
  // openExisting() used elsewhere in this file — see
  // hasAnyLocalWalletData()'s comment for why a bare open() is unsafe to use
  // as a probe before the SDK has ever touched a DB name this session.
  const existingDbs = await indexedDB.databases();
  const existingVersion = existingDbs.find((d) => d.name === dbName)?.version;
  //
  // The second half of the rule — bumping *past* an existing version that is
  // already high enough — is chooseRestoreVersion's job; see its comment for
  // the silent-data-loss case it exists to prevent. The store list it needs
  // is only read when that case is actually in play, since reading it means
  // another open.
  let targetVersion = dump.version;
  if (existingVersion !== undefined) {
    targetVersion = await chooseRestoreVersion(existingVersion, dump.version, () => listStoreNames(dbName), dumpStoreNames);
  }

  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName, targetVersion);
    req.onupgradeneeded = () => {
      const upgradeDb = req.result;
      const tx = req.transaction!;
      for (const name of dumpStoreNames) {
        const { keyPath, indexes } = dump.stores[name];
        const store = upgradeDb.objectStoreNames.contains(name)
          ? tx.objectStore(name)
          : upgradeDb.createObjectStore(name, keyPath !== null ? { keyPath } : undefined);
        for (const idx of indexes) {
          if (store.indexNames.contains(idx.name)) continue;
          store.createIndex(idx.name, idx.keyPath, { unique: idx.unique, multiEntry: idx.multiEntry });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error(`Failed to create ${dbName} for restore`));
    req.onblocked = () => reject(new Error(`Restore of ${dbName} blocked by another connection`));
  });

  try {
    // Every store the dump has must exist by now: the open above either
    // created the database outright, or ran an upgrade that filled in
    // whatever was missing (see the targetVersion bump). A gap here means
    // this restore would silently lose records, so fail loudly instead —
    // App.tsx latches that as a restore failure, which keeps uploads
    // switched off rather than committing partial local state over the last
    // good server blob. This used to be a quiet
    // `.filter(name => db.objectStoreNames.contains(name))`, which turned
    // exactly that data loss into a successful-looking restore.
    const missing = dumpStoreNames.filter((name) => !db.objectStoreNames.contains(name));
    if (missing.length > 0) {
      throw new Error(`Restore of ${dbName} incomplete: object store(s) missing after upgrade: ${missing.join(", ")}`);
    }
    const storeNames = dumpStoreNames;

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeNames, "readwrite");
      tx.onerror = () => reject(tx.error ?? new Error(`Restore transaction failed on ${dbName}`));
      tx.oncomplete = () => resolve();
      for (const storeName of storeNames) {
        const store = tx.objectStore(storeName);
        // Clear first: defensive, in case this DB name somehow already had
        // content (it shouldn't — this function is only ever called before
        // the SDK has opened it this session) — restore is meant to
        // reproduce the backup's state exactly, not merge with anything.
        store.clear();
        const { records } = dump.stores[storeName];
        const inline = store.keyPath !== null;
        for (const { key, value } of records) {
          const v = untagValue(value);
          if (inline) store.put(v);
          else store.put(v, untagValue(key) as IDBValidKey);
        }
      }
    });
  } finally {
    db.close();
  }
}
