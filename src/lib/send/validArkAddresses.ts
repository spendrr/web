import { APP_NETWORK } from "../network";
import { parseCanonicalArkAddress } from "./arkAddressShape";

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

// Which Ark server this wallet talks to, learned only from the SDK itself: the
// ark_id of an address it accepted, or of the wallet's own address. Another
// address of the same shape and ark_id is for the same server and network,
// which is all validateArkoorAddress checks beyond the shape that
// parseCanonicalArkAddress already insists on. Anything else still waits for
// the SDK.
const SERVER_KEY = `btc-wallet-ark-server-id-v1:${APP_NETWORK}`;
let serverId: string | null | undefined;

function loadServerId(storage: Storage): string | null {
  if (serverId !== undefined) return serverId;
  try {
    serverId = storage.getItem(SERVER_KEY);
  } catch {
    serverId = null;
  }
  return serverId;
}

/** Learn the server from an address the SDK produced or accepted. */
export function learnArkServerFrom(address: string, storage: Storage = localStorage): void {
  const parsed = parseCanonicalArkAddress(address);
  if (!parsed) return;
  const id = `${parsed.testnet ? "tark" : "ark"}:${parsed.arkId}`;
  if (loadServerId(storage) === id) return;
  serverId = id;
  try {
    storage.setItem(SERVER_KEY, id);
  } catch {
    // the in-memory copy still serves this session
  }
}

function isKnownServerAddress(address: string, storage: Storage): boolean {
  const known = loadServerId(storage);
  if (!known) return false;
  const parsed = parseCanonicalArkAddress(address);
  return parsed !== null && `${parsed.testnet ? "tark" : "ark"}:${parsed.arkId}` === known;
}

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
  if (at === undefined) return isKnownServerAddress(address, storage);
  if (now - at >= TTL_MS) {
    memory.delete(address);
    return false;
  }
  return true;
}

export function rememberValidArkAddress(address: string, storage: Storage = localStorage, now = Date.now()): void {
  load(storage, now);
  learnArkServerFrom(address, storage);
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
  serverId = undefined;
}
