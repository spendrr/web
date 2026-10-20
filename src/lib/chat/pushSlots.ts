// The page's side of IndexedDB "spendrr-push", which the Service Worker reads
// (public/sw-chat.js) to open chat notifications while the app is closed and
// locked. That is the point, and also the cost: these entries are not sealed
// by the wallet password. Per slot: the preview key (a non-extractable
// CryptoKey), the contact's @name unless the user chose not to see names, the
// last counter shown and the unread count. Nothing else.
import type { PreviewLevel } from "./pushFormat";
import { importPreviewKey } from "./pushFormat";

const DB_NAME = "spendrr-push";

type SlotRecord = { key: CryptoKey; name: string | null; n: number; count: number };

function openDb(): Promise<IDBDatabase> {
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

async function run<T>(store: "slots" | "meta", mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve((req ? req.result : undefined) as T);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function putSlot(slot: string, rawKey: Uint8Array, name: string | null): Promise<void> {
  const key = await importPreviewKey(rawKey, "decrypt");
  const prev = await run<SlotRecord | undefined>("slots", "readonly", (s) => s.get(slot));
  const rec: SlotRecord = { key, name, n: prev?.n ?? 0, count: prev?.count ?? 0 };
  await run("slots", "readwrite", (s) => s.put(rec, slot));
}

export async function setSlotName(slot: string, name: string | null): Promise<void> {
  const prev = await run<SlotRecord | undefined>("slots", "readonly", (s) => s.get(slot));
  if (!prev || prev.name === name) return;
  await run("slots", "readwrite", (s) => s.put({ ...prev, name }, slot));
}

export async function hasSlot(slot: string): Promise<boolean> {
  return (await run<SlotRecord | undefined>("slots", "readonly", (s) => s.get(slot))) !== undefined;
}

export async function deleteSlot(slot: string): Promise<void> {
  await run("slots", "readwrite", (s) => s.delete(slot));
  await closeNotifications(slot);
}

export async function setPreviewLevel(level: PreviewLevel): Promise<void> {
  await run("meta", "readwrite", (s) => s.put(level, "level"));
}

// The conversation a tapped notification asked for, once, if it is recent.
const PENDING_OPEN_MAX_MS = 10 * 60 * 1000;

export async function takePendingOpen(): Promise<string | null> {
  try {
    const v = await run<{ slot?: unknown; at?: unknown } | undefined>("meta", "readonly", (s) => s.get("pendingOpen"));
    if (!v) return null;
    await run("meta", "readwrite", (s) => s.delete("pendingOpen"));
    if (typeof v.slot !== "string" || typeof v.at !== "number" || Date.now() - v.at > PENDING_OPEN_MAX_MS) return null;
    return v.slot;
  } catch {
    return null;
  }
}

async function closeNotifications(slot: string): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration("/sw.js");
    if (!reg) return;
    for (const tag of [`spendrr-chat-${slot}`, "spendrr-payment"]) {
      for (const n of await reg.getNotifications({ tag })) {
        if (tag !== "spendrr-payment" || (n.data as { chatSlot?: unknown } | null)?.chatSlot === slot) n.close();
      }
    }
  } catch {
    // Nothing to close, or no Service Worker.
  }
}

async function updateBadge(): Promise<void> {
  try {
    const all = await run<SlotRecord[]>("slots", "readonly", (s) => s.getAll());
    const total = all.reduce((n, r) => n + (r?.count ?? 0), 0);
    if (!("setAppBadge" in navigator)) return;
    if (total > 0) await navigator.setAppBadge(total);
    else await navigator.clearAppBadge();
  } catch {
    // Badges are optional.
  }
}

// The conversation is on screen: its notifications go and the badge drops.
export async function markSlotSeen(slot: string): Promise<void> {
  try {
    const prev = await run<SlotRecord | undefined>("slots", "readonly", (s) => s.get(slot));
    if (prev && prev.count > 0) await run("slots", "readwrite", (s) => s.put({ ...prev, count: 0 }, slot));
  } catch {
    // The count just stays until the next time.
  }
  await closeNotifications(slot);
  await updateBadge();
}

// Wallet reset: nothing of any identity's notifications stays behind.
export async function clearPushSlots(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}
