// Trust on first use for @handles, on the paying side.
//
// A handle points at whatever address its owner last registered, and anyone
// holding a live mailbox authorization for that owner can change it. So the
// first time this wallet pays a handle it remembers the address, and a later
// payment to the same handle that resolves somewhere else is flagged before any
// money moves. Pinned only after a payment actually goes out, never on a mere
// lookup, so typing a name and thinking better of it commits nothing.
//
// A changed address is often innocent (the owner rotated it on purpose), so
// this warns rather than refuses.

const KEY = "btc-wallet-name-pins";
const MAX_PINS = 500;

type Pins = Record<string, string>;

export type PinCheck = "new" | "same" | "changed";

// The history list asks nameForPayment() once per row, and each ask used to
// re-read and re-parse the whole stored object (up to MAX_PINS entries) and
// lower-case every pinned address again. The parse is remembered per storage
// object for as long as the stored text is identical (getItem is the only
// thing still called per read, so a write from anywhere, another tab included,
// is seen at once). Callers never get to mutate the cached object: pinName
// works on a copy.
type PinCache = { raw: string | null; pins: Pins; lowered: [string, string][] };
const pinCaches = new WeakMap<Storage, PinCache>();

function readCached(storage: Storage): PinCache {
  let raw: string | null = null;
  try {
    raw = storage.getItem(KEY);
  } catch {
    raw = null;
  }
  const hit = pinCaches.get(storage);
  if (hit && hit.raw === raw) return hit;
  const pins = parsePins(raw);
  const fresh: PinCache = {
    raw,
    pins,
    lowered: Object.entries(pins).map(([name, address]) => [name, address.toLowerCase()]),
  };
  pinCaches.set(storage, fresh);
  return fresh;
}

function parsePins(raw: string | null): Pins {
  try {
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Pins = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function read(storage: Storage): Pins {
  return readCached(storage).pins;
}

/** The address this wallet last paid this handle at, or null. A hint for showing who it is; never what a payment uses. */
export function pinnedAddressFor(name: string, storage: Storage = localStorage): string | null {
  return read(storage)[name] ?? null;
}

export function checkNamePin(name: string, address: string, storage: Storage = localStorage): PinCheck {
  const pinned = read(storage)[name];
  if (pinned === undefined) return "new";
  return pinned === address ? "same" : "changed";
}

/**
 * Handles this wallet has paid before whose name starts with `prefix`, most
 * recently paid first. Local only (no lookup), which is what lets the send
 * field suggest them while the first letters are still being typed.
 */
export function pinnedNamesStartingWith(
  prefix: string,
  limit = 3,
  storage: Storage = localStorage,
): { name: string; address: string }[] {
  const p = prefix.toLowerCase();
  return Object.entries(read(storage))
    .reverse()
    .filter(([name]) => name.startsWith(p) && name !== p)
    .slice(0, limit)
    .map(([name, address]) => ({ name, address }));
}

/**
 * One suggestion per wallet. Two pinned names can point at the same address (a
 * renamed or deleted handle keeps its old pin), and the exact name being typed
 * may already have resolved to that address: neither should be listed again.
 * Keeps the first (most recent) of each address.
 */
export function distinctSuggestions(
  suggestions: { name: string; address: string }[],
  resolvedAddress: string | null,
): { name: string; address: string }[] {
  const seen = new Set<string>(resolvedAddress === null ? [] : [resolvedAddress]);
  return suggestions.filter((s) => {
    if (seen.has(s.address)) return false;
    seen.add(s.address);
    return true;
  });
}

/** Handles this wallet has paid, most recently paid first. Local only. */
export function recentPinnedNames(limit = 5, storage: Storage = localStorage): { name: string; address: string }[] {
  return Object.entries(read(storage))
    .reverse()
    .slice(0, limit)
    .map(([name, address]) => ({ name, address }));
}

export function pinName(name: string, address: string, storage: Storage = localStorage): void {
  try {
    const pins = { ...read(storage) };
    // Re-inserting moves the name to the end, so trimming from the front drops
    // the least recently paid ones first.
    delete pins[name];
    pins[name] = address;
    const keys = Object.keys(pins);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PINS))) delete pins[k];
    storage.setItem(KEY, JSON.stringify(pins));
  } catch {
    // storage blocked: the next payment just reads as a first one
  }
}

/**
 * The handle this wallet has paid at one of `addresses`, if any. The SDK can
 * hand a destination back as a bare address or wrapped (a JSON string), so the
 * pinned address is looked for inside the text rather than compared whole.
 */
export function nameForAny(addresses: readonly string[], storage: Storage = localStorage): string | null {
  const entries = readCached(storage).lowered;
  let found: string | null = null;
  for (const raw of addresses) {
    const text = raw.toLowerCase();
    // Later entries are the more recently paid, so the last match wins.
    for (const [name, pinned] of entries) if (pinned.length > 0 && text.includes(pinned)) found = name;
    if (found) return found;
  }
  return found;
}

export function nameForAddress(address: string, storage: Storage = localStorage): string | null {
  return nameForAny([address], storage);
}

// A second, format-independent way to attach a name to a history row: a short
// log of "paid @name, this many sats, at this time". The SDK's own record of
// where a payment went is matched by address above, but nothing pins down its
// exact shape, so a row is also matched by amount and time.
const LOG_KEY = "btc-wallet-name-payments";
const LOG_MAX = 200;
const LOG_MATCH_MS = 10 * 60 * 1000;

type PaymentLog = { name: string; sats: number; at: number }[];

// Same treatment as the pins: one parse per distinct stored text, not one per
// history row. logNamedPayment copies before it appends.
const logCaches = new WeakMap<Storage, { raw: string | null; log: PaymentLog }>();

function readLog(storage: Storage): PaymentLog {
  let raw: string | null = null;
  try {
    raw = storage.getItem(LOG_KEY);
  } catch {
    raw = null;
  }
  const hit = logCaches.get(storage);
  if (hit && hit.raw === raw) return hit.log;
  let log: PaymentLog = [];
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (Array.isArray(parsed)) {
      log = parsed.filter(
        (e): e is PaymentLog[number] =>
          typeof e?.name === "string" && Number.isFinite(e?.sats) && Number.isFinite(e?.at),
      );
    }
  } catch {
    log = [];
  }
  logCaches.set(storage, { raw, log });
  return log;
}

export function logNamedPayment(name: string, sats: number, at: number = Date.now(), storage: Storage = localStorage): void {
  try {
    const log = [...readLog(storage)];
    log.push({ name, sats, at });
    storage.setItem(LOG_KEY, JSON.stringify(log.slice(-LOG_MAX)));
  } catch {
    // storage blocked: the row just shows no name
  }
}

// A destination the log must not overrule: when the payment's own record names
// where it went and that isn't a pinned handle, it went somewhere else, even if
// a handle payment of the same amount happened minutes apart.
const KNOWN_DESTINATION = /\b(t?ark1|ln(bc|tb|bcrt|url)|bc1|tb1|bcrt1)[0-9a-z]|[^\s"@]+@[^\s"@]+\.[a-z]/i;

/**
 * The name of a sent payment, by its address first and by amount and time
 * only when the record's destination is unreadable.
 */
export function nameForPayment(
  m: { sentToAddresses: readonly string[]; effectiveBalanceSats: number; createdAt: string | number | Date },
  storage: Storage = localStorage,
): string | null {
  const byAddress = nameForAny(m.sentToAddresses, storage);
  if (byAddress) return byAddress;
  if (m.sentToAddresses.some((a) => KNOWN_DESTINATION.test(a))) return null;
  const sats = Math.abs(m.effectiveBalanceSats);
  const at = new Date(m.createdAt).getTime();
  let best: { name: string; gap: number } | null = null;
  for (const e of readLog(storage)) {
    // A fee can make the movement a little larger than the amount sent.
    if (sats < e.sats || sats > e.sats + Math.max(50, Math.ceil(e.sats * 0.02))) continue;
    const gap = Math.abs(at - e.at);
    if (gap <= LOG_MATCH_MS && (best === null || gap < best.gap)) best = { name: e.name, gap };
  }
  return best?.name ?? null;
}
