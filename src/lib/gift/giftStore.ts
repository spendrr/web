// Local persistence for "send bitcoin as a link" — all of it owned by this
// app (unlike the bark-owned wallet DBs), so the schema is ours to version.
//
//  - localStorage: the claim-idempotency set, and the "this wallet arrived
//    via a gift link, still needs a seed backup" flag that drives the one
//    banner on the dashboard. Visibility of the 🎁 sender entry point itself
//    is gated on the v2 beta toggle (src/lib/ui/designVersion.ts), not stored
//    here — it used to be a `?gift=1` pilot flag, promoted to the beta
//    toggle once the pilot was done.
//  - IndexedDB `btc-wallet-gifts`: the sender's outgoing gifts. The one-time
//    mnemonic in each record is encrypted with the cloud-backup AES-GCM key
//    (derived from the *real* wallet's seed, kept in a ref by App.tsx after
//    open) — never stored in the clear.
import { fromB64, toB64 } from "../vault/vaultCrypto";
import type { GiftScanEntry } from "./giftScan";

const CLAIMS_KEY = "btc-wallet-gift-claims";
const NEEDS_BACKUP_KEY = "btc-wallet-gift-needs-backup";
// Exported so backup.ts can bundle this database alongside the two bark-owned
// ones. It has to be in the cloud backup: it holds the only copy of each
// outgoing gift's reclaim seed, and the gift funds themselves live on the Ark
// server, not locally. Restoring a wallet without it would bring back the
// balance and history but leave every unclaimed gift permanently unreachable
// — the same shape of loss as the STOP_GAP case this whole backup feature
// exists to prevent.
export const GIFTS_DB_NAME = "btc-wallet-gifts";
const GIFTS_DB = GIFTS_DB_NAME;
const GIFTS_STORE = "gifts";
const CLAIMS_CAP = 200;

// --- Claim idempotency --------------------------------------------------

function readClaims(): string[] {
  try {
    const raw = localStorage.getItem(CLAIMS_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function hasClaimedGift(id: string): boolean {
  return readClaims().includes(id);
}

export function markGiftClaimed(id: string): void {
  try {
    const next = [...readClaims().filter((x) => x !== id), id].slice(-CLAIMS_CAP);
    localStorage.setItem(CLAIMS_KEY, JSON.stringify(next));
  } catch {
    // Non-fatal: worst case a re-opened link re-runs the claim, which the
    // server rejects as a double-spend anyway.
  }
}

// --- "Needs seed backup" banner flag (fresh gift recipient only) --------

export function markNeedsSeedBackup(): void {
  try {
    localStorage.setItem(NEEDS_BACKUP_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function needsSeedBackup(): boolean {
  try {
    return localStorage.getItem(NEEDS_BACKUP_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearNeedsSeedBackup(): void {
  try {
    localStorage.removeItem(NEEDS_BACKUP_KEY);
  } catch {
    /* ignore */
  }
}

// --- Last known claim status (display only) ---------------------------
// What the Settings list last found when it looked into each waiting gift,
// so a row can show its answer immediately instead of making the user wait
// out a fresh check every time. That wait is the whole budget for a claimed
// gift, because a claimed gift's mailbox pull never finishes and the timeout
// *is* the answer (see bark.ts's GIFT_SLOW_MESSAGE).
//
// Deliberately NOT a field on the OutgoingGift record. The record is the
// reclaim state machine's, written by whole-object puts from whatever copy
// the writer happened to read; a display path writing it too could race a
// reclaim and put back a stale state. Nothing that decides what happens to
// the money reads this key.

const PEEK_CACHE_KEY = "btc-wallet-gift-peek";

// "claimed": the pull completed and the gift wallet was empty (definite).
// "likely-claimed": the pull never finished, which is how a claimed gift
// presents but also how a bad connection does (bark.ts GIFT_SLOW_MESSAGE).
export type GiftPeekHint = "claimed" | "likely-claimed" | "unclaimed";
export interface GiftPeekEntry {
  hint: GiftPeekHint;
  // When the look finished, ms. 0 for entries written before this existed.
  at: number;
}

const PEEK_HINTS: ReadonlySet<string> = new Set(["claimed", "likely-claimed", "unclaimed"]);

export function readGiftPeekCache(): Record<string, GiftPeekEntry> {
  try {
    const raw = localStorage.getItem(PEEK_CACHE_KEY);
    const obj = raw ? (JSON.parse(raw) as unknown) : {};
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    const out: Record<string, GiftPeekEntry> = {};
    for (const [id, v] of Object.entries(obj)) {
      // Legacy format: the bare hint string. Its "claimed" also covered a pull
      // that only timed out, so it cannot be taken as definite.
      if (typeof v === "string" && PEEK_HINTS.has(v)) {
        out[id] = { hint: v === "claimed" ? "likely-claimed" : (v as GiftPeekHint), at: 0 };
      }
      else if (v && typeof v === "object") {
        const { hint, at } = v as { hint?: unknown; at?: unknown };
        if (typeof hint === "string" && PEEK_HINTS.has(hint)) {
          out[id] = { hint: hint as GiftPeekHint, at: typeof at === "number" && Number.isFinite(at) ? at : 0 };
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

// Keeps only the ids passed in (the gifts still not finished), so the key can't
// grow with every gift ever sent. `updates` are merged in after pruning.
export function writeGiftPeekCache(keepIds: string[], updates: Record<string, GiftPeekEntry> = {}): void {
  try {
    const current = readGiftPeekCache();
    const next: Record<string, GiftPeekEntry> = {};
    for (const id of keepIds) {
      const v = updates[id] ?? current[id];
      if (v) next[id] = v;
    }
    localStorage.setItem(PEEK_CACHE_KEY, JSON.stringify(next));
  } catch {
    // Display convenience only: a failed write just means the next open
    // checks from scratch.
  }
}

// --- Last scan result (display only, beta list) -----------------------
// Same rules as the peek cache above (never read by anything that decides what
// happens to the money), under its own key so the old list's guesses are not
// mistaken for scan results.

const SCAN_CACHE_KEY = "btc-wallet-gift-scan";
const SCAN_HINTS: ReadonlySet<string> = new Set(["waiting", "opened", "claimed"]);

export function readGiftScanCache(): Record<string, GiftScanEntry> {
  try {
    const raw = localStorage.getItem(SCAN_CACHE_KEY);
    const obj = raw ? (JSON.parse(raw) as unknown) : {};
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    const out: Record<string, GiftScanEntry> = {};
    for (const [id, v] of Object.entries(obj)) {
      const { hint, at } = (v ?? {}) as { hint?: unknown; at?: unknown };
      if (typeof hint === "string" && SCAN_HINTS.has(hint) && typeof at === "number" && Number.isFinite(at)) {
        out[id] = { hint: hint as GiftScanEntry["hint"], at };
      }
    }
    return out;
  } catch {
    return {};
  }
}

// Keeps only `keepIds` (gifts a look still matters for); `updates` are merged in after pruning.
export function writeGiftScanCache(keepIds: string[], updates: Record<string, GiftScanEntry> = {}): void {
  try {
    const current = readGiftScanCache();
    const next: Record<string, GiftScanEntry> = {};
    for (const id of keepIds) {
      const v = updates[id] ?? current[id];
      if (v) next[id] = v;
    }
    localStorage.setItem(SCAN_CACHE_KEY, JSON.stringify(next));
  } catch {
    // Display convenience only.
  }
}

// Remove the plaintext password cached by older gift-recipient flows. New
// password-protected gift wallets require a user-chosen, confirmed password
// before creation and never persist a recovery copy.
const PENDING_PW_KEY = "btc-wallet-gift-pending-pw";

export function clearPendingGiftPassword(): void {
  try {
    localStorage.removeItem(PENDING_PW_KEY);
  } catch {
    /* ignore */
  }
}

// --- Outgoing gifts (IndexedDB) ---------------------------------------

export type GiftState = "creating" | "unclaimed" | "claimed" | "reclaimed";

export interface CipherBlob {
  ivB64: string;
  cipherB64: string;
}

export interface OutgoingGift {
  id: string;
  createdAt: number;
  expiresAt: number;
  amountSats: number;
  message?: string;
  state: GiftState;
  mnemonicCipher: CipherBlob;
  claimedAt?: number;
  // Reclaim attempts whose mailbox pull timed out, counted at most once per
  // day (see giftReclaim.ts). A timeout is how an already-claimed gift
  // actually presents — the pull never finishes — but it is also what a bad
  // connection looks like, so one is never enough to write the gift off.
  // Optional: every record written before this existed simply has none.
  failedChecks?: number;
  lastCheckFailedAt?: number;
}

function openGiftsDbAt(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version === undefined ? indexedDB.open(GIFTS_DB) : indexedDB.open(GIFTS_DB, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(GIFTS_STORE)) {
        db.createObjectStore(GIFTS_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("gifts DB open failed"));
    req.onblocked = () => reject(new Error("gifts DB open blocked by another connection"));
  });
}

// Opens the gifts DB, creating the object store if it isn't there — including
// the case where the database already exists at some version but holds no
// store at all.
//
// That state is reachable precisely because this DB is now part of the cloud
// backup: backupStore.ts's dump probe is a *versionless* indexedDB.open(),
// which creates an empty version-1 database as a side effect when none exists
// (its own openExisting() comment spells this out). The previous
// open(GIFTS_DB, 1) then matched that version exactly, so onupgradeneeded
// never fired, the store was never created, and every putGift() from then on
// would throw NotFoundError — gift sending broken for good on any wallet that
// had backed up before it ever sent a gift.
//
// Opening versionless first also means this can never throw VersionError: a
// database already healed to a higher version is simply opened as it is.
async function openGiftsDb(): Promise<IDBDatabase> {
  const db = await openGiftsDbAt();
  if (db.objectStoreNames.contains(GIFTS_STORE)) return db;
  const next = db.version + 1;
  db.close();
  return openGiftsDbAt(next);
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openGiftsDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(GIFTS_STORE, mode);
      const req = fn(t.objectStore(GIFTS_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("gifts DB tx failed"));
    });
  } finally {
    db.close();
  }
}

export async function putGift(rec: OutgoingGift): Promise<void> {
  await tx("readwrite", (s) => s.put(rec));
}

export async function getGift(id: string): Promise<OutgoingGift | undefined> {
  return (await tx("readonly", (s) => s.get(id))) as OutgoingGift | undefined;
}

export async function listGifts(): Promise<OutgoingGift[]> {
  const all = (await tx("readonly", (s) => s.getAll())) as OutgoingGift[];
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteGift(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
}

// --- Gift-mnemonic encryption (cloud-backup AES-GCM key) --------------

export async function encryptGiftMnemonic(key: CryptoKey, mnemonic: string): Promise<CipherBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(mnemonic);
  try {
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, bytes as BufferSource);
    return { ivB64: toB64(iv.buffer as ArrayBuffer), cipherB64: toB64(cipher) };
  } finally {
    bytes.fill(0);
  }
}

export async function decryptGiftMnemonic(key: CryptoKey, blob: CipherBlob): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(blob.ivB64) as BufferSource },
    key,
    fromB64(blob.cipherB64) as BufferSource,
  );
  const bytes = new Uint8Array(plain);
  try {
    return new TextDecoder().decode(bytes);
  } finally {
    bytes.fill(0);
  }
}
