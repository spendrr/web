// A compact set of the names the NameRegistry knows anything about, kept at the
// edge so that a lookup of any OTHER name is answered without a Durable Object
// request.
//
// Why: one global Durable Object answers every name lookup, and Workers Free
// caps Durable Object requests at 100,000 a DAY for the whole account (push
// alarms, bump, the Lightning ledger included). nameLookupCache.ts already makes
// a repeated lookup of one name free, but a caller inventing names pays a
// request per new name; the per-source limiter bounds that per source (60 a
// minute is still ~86,000 a day) and a source can rotate its IPv6 /64. With the
// snapshot an invented name never reaches the object: it is not in the set.
//
// What is in it: every name whose lookup is anything but "free" or a plain
// reserved-list name, i.e. a record (taken, aliases included), an admin block and
// a running quarantine. For a name that is NOT in it the registry could only
// answer `reserved` (the static list in handle.ts) or `free`, and index.ts
// answers exactly that. A name that IS in it goes on through the per-name cache
// and the registry as before, so nothing here decides who owns what.
//
// Only 32-bit hashes of the names travel (sorted, 4 bytes each, base64): a lookup
// is a binary search, 100,000 names are ~530 KB, and a collision only sends an
// unknown name to the registry (the answer is still the registry's). The wire
// form never leaves the Worker and the object.
//
// Staleness, and why it is safe: a name registered, blocked or quarantined after
// the copy in use was taken reads as "free" (or "reserved") for up to
// NAME_SNAPSHOT_TTL_SECONDS at other colos, and in the isolates that have not
// heard about a write. It cannot make anything succeed wrongly: registering and
// every other write is decided by the object alone, and "free" for a name that
// has just been taken pays nobody. The colo that handled the write drops its copy
// (invalidateNameSnapshot). When the snapshot cannot be had, callers fall back to
// exactly the behaviour before it existed.
import type { LookupCache } from "./nameLookupCache";

export const NAME_SNAPSHOT_TTL_SECONDS = 60;
// After a failed fetch nothing asks again for this long; callers use the
// per-name path meanwhile.
const FAILURE_MEMO_MS = 10_000;

export interface NameSnapshotWire {
  v: 1;
  at: number;
  count: number;
  hashes: string;
}

// FNV-1a over the name's UTF-16 code units (a handle is ASCII).
export function nameHash(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function encodeNameSnapshot(names: Iterable<string>, at: number): NameSnapshotWire {
  const hashes = [...new Set([...names].map(nameHash))].sort((a, b) => a - b);
  const bytes = new Uint8Array(hashes.length * 4);
  const view = new DataView(bytes.buffer);
  hashes.forEach((h, i) => view.setUint32(i * 4, h, true));
  let binary = "";
  // Chunked: a spread of a whole large array overflows the call stack.
  for (let i = 0; i < bytes.length; i += 0x2000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return { v: 1, at, count: hashes.length, hashes: btoa(binary) };
}

export class NameSnapshot {
  private readonly view: DataView;
  readonly count: number;

  constructor(bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.count = bytes.byteLength / 4;
  }

  has(name: string): boolean {
    const target = nameHash(name);
    let lo = 0;
    let hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const value = this.view.getUint32(mid * 4, true);
      if (value === target) return true;
      if (value < target) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }
}

export function decodeNameSnapshot(wire: unknown): NameSnapshot | null {
  if (typeof wire !== "object" || wire === null) return null;
  const w = wire as Partial<NameSnapshotWire>;
  if (w.v !== 1 || typeof w.hashes !== "string" || typeof w.count !== "number") return null;
  let binary: string;
  try {
    binary = atob(w.hashes);
  } catch {
    return null;
  }
  if (binary.length % 4 !== 0 || binary.length / 4 !== w.count) return null;
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new NameSnapshot(bytes);
}

const cacheKey = () => new Request("https://names-cache.internal/snapshot");

let memo: { snapshot: NameSnapshot; until: number } | null = null;
let inFlight: Promise<NameSnapshot | null> | null = null;
let failedUntil = 0;

export function resetNameSnapshotMemo(): void {
  memo = null;
  inFlight = null;
  failedUntil = 0;
}

// The snapshot to use now, or null when there is none (then the caller does what
// it did before). Order: this isolate's copy, the colo's edge cache, one fetch
// from the registry shared by every caller that arrives meanwhile.
export async function currentNameSnapshot(
  cache: LookupCache,
  fetchFresh: () => Promise<unknown>,
): Promise<NameSnapshot | null> {
  const now = Date.now();
  if (memo && memo.until > now) return memo.snapshot;
  if (now < failedUntil) return null;
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<NameSnapshot | null> => {
    try {
      const cached = await cache.match(cacheKey());
      if (cached) {
        const snapshot = decodeNameSnapshot(await cached.json());
        if (snapshot) {
          memo = { snapshot, until: Date.now() + NAME_SNAPSHOT_TTL_SECONDS * 1000 };
          return snapshot;
        }
      }
    } catch {
      // A broken cache read is a miss.
    }
    const wire = await fetchFresh().catch(() => null);
    const snapshot = decodeNameSnapshot(wire);
    if (!snapshot) {
      failedUntil = Date.now() + FAILURE_MEMO_MS;
      return null;
    }
    memo = { snapshot, until: Date.now() + NAME_SNAPSHOT_TTL_SECONDS * 1000 };
    try {
      await cache.put(
        cacheKey(),
        new Response(JSON.stringify(wire), {
          headers: { "content-type": "application/json", "cache-control": `public, max-age=${NAME_SNAPSHOT_TTL_SECONDS}` },
        }),
      );
    } catch {
      // Not shared with the colo's other isolates: each fetches its own.
    }
    return snapshot;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

// After this colo handled a write: the next lookup fetches a fresh copy (the
// object rebuilds it because the write marked it dirty).
export async function invalidateNameSnapshot(cache: LookupCache): Promise<void> {
  memo = null;
  failedUntil = 0;
  try {
    await cache.delete(cacheKey());
  } catch {
    // Expires by itself within the TTL.
  }
}
