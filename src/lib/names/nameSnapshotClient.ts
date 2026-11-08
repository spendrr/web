// The app's copy of the name snapshot: the Worker publishes the hashes of every
// registered name to data.spendrr.app/names.bin (publishNameSnapshot in
// worker/index.ts). A typed name whose hash is not in it is not registered, so
// the app can say "nobody has this name" without asking the Worker, which
// matters because a person typing sends a lookup per pause.
//
// Only a "not registered" answer is ever taken from here. A name that IS in the
// set, a copy that cannot be had, or one that is too old goes to the Worker as
// before, and the registry decides every write whatever this says, so a stale
// copy can at worst show a name registered a minute ago as free for that minute.
import { unwrapNameFile, type NameSnapshot } from "./nameHashSet";
import { PUBLIC_NAMES_URL } from "../publicData";

// A copy this young is used as it is; older ones are refreshed first.
const FRESH_MS = 60_000;
// An old copy still answers while a refresh fails, up to this age; after that
// the Worker is asked again.
const STALE_OK_MS = 10 * 60_000;
// After a failed fetch (404 before the first publish, offline, refused) nothing
// asks again for this long.
const RETRY_MS = 2 * 60_000;
// A fetch that hangs must not hold a lookup: past this the lookup goes to the
// Worker and the fetch carries on for the next one.
const FETCH_TIMEOUT_MS = 5_000;
const WAIT_MS = 1_500;
// 100,000 names are 400 kB; anything far beyond is not the file.
const MAX_BYTES = 8 * 1024 * 1024;

let memo: { snapshot: NameSnapshot; at: number } | null = null;
let inFlight: Promise<void> | null = null;
let failedUntil = 0;

export function resetNameSnapshotClient(): void {
  memo = null;
  inFlight = null;
  failedUntil = 0;
}

async function refresh(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // no-cache: revalidated against the CDN (free, no Worker), so an old copy in
    // the browser's own cache can never hold the data back.
    const res = await fetch(PUBLIC_NAMES_URL, { credentials: "omit", cache: "no-cache", signal: controller.signal });
    const bytes = res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    const snapshot = bytes && bytes.byteLength <= MAX_BYTES ? unwrapNameFile(bytes) : null;
    if (snapshot) {
      memo = { snapshot, at: Date.now() };
      return;
    }
  } catch {
    // falls through
  } finally {
    clearTimeout(timer);
  }
  failedUntil = Date.now() + RETRY_MS;
}

// The snapshot to answer "not registered" from, or null (ask the Worker). A copy
// that is old but not too old answers at once while a fresh one is fetched in
// the background; only when there is no copy at all does a lookup wait for the
// fetch, and then for at most WAIT_MS.
export async function currentClientNameSnapshot(): Promise<NameSnapshot | null> {
  const now = Date.now();
  if (memo && now - memo.at < FRESH_MS) return memo.snapshot;
  if (now >= failedUntil && !inFlight) {
    inFlight = refresh().finally(() => {
      inFlight = null;
    });
  }
  if (memo && now - memo.at < STALE_OK_MS) return memo.snapshot;
  if (inFlight) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([inFlight, new Promise<void>((resolve) => (timer = setTimeout(resolve, WAIT_MS)))]);
    clearTimeout(timer);
    if (memo && Date.now() - memo.at < STALE_OK_MS) return memo.snapshot;
  }
  return null;
}
