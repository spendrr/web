import { APP_NETWORK } from "../network";

// Ark addresses the SDK (validateArkoorAddress) has accepted. That call is a
// pure check of the string, but it waits in the wallet worker's FIFO queue
// behind sync()/maintenance(), so a handle's first resolution of a session
// could sit on "checking" for seconds. Whether a given string is a valid
// address for this server does not change, so an acceptance is remembered
// across sessions, per network. Only acceptances are stored, never rejections,
// and the SDK still validates every address at send time: a stale entry can
// only skip the early check, not make a payment go through.
const KEY = `btc-wallet-valid-ark-addrs-v1:${APP_NETWORK}`;
const MAX_ENTRIES = 300;
const TTL_MS = 30 * 24 * 3600 * 1000;

type Entries = Record<string, number>;

const memory = new Map<string, number>();
let loaded = false;

function load(storage: Storage, now: number): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    for (const [address, at] of Object.entries(parsed)) {
      if (typeof at === "number" && now - at < TTL_MS) memory.set(address, at);
    }
  } catch {
    // storage unavailable or corrupt: behave as an empty cache
  }
}

export function isKnownValidArkAddress(address: string, storage: Storage = localStorage, now = Date.now()): boolean {
  load(storage, now);
  const at = memory.get(address);
  if (at === undefined) return false;
  if (now - at >= TTL_MS) {
    memory.delete(address);
    return false;
  }
  return true;
}

export function rememberValidArkAddress(address: string, storage: Storage = localStorage, now = Date.now()): void {
  load(storage, now);
  // Re-inserting moves it to the end, so trimming from the front drops the
  // least recently accepted ones first.
  memory.delete(address);
  memory.set(address, now);
  while (memory.size > MAX_ENTRIES) memory.delete(memory.keys().next().value as string);
  try {
    storage.setItem(KEY, JSON.stringify(Object.fromEntries(memory) satisfies Entries));
  } catch {
    // quota or private mode: the in-memory cache still serves this session
  }
}

/** Test seam: forget the in-memory copy so the next call reloads from storage. */
export function resetValidArkAddressesForTest(): void {
  memory.clear();
  loaded = false;
}
