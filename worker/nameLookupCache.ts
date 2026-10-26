// Edge cache in front of the NameRegistry Durable Object's read-only /lookup.
//
// One global Durable Object answers every name lookup, and on the Workers Free
// plan Durable Object requests are capped at 100,000 a DAY for the whole account,
// push alarms and name writes included. Lookups come from three places: the
// send form resolving @name, /@name profile pages (every link preview a chat
// app fetches), and repeats of both. Without a cache each one is a DO request,
// and one client at the old 120/min limit could make ~170,000 of them a day:
// enough to switch the quota off for everything else.
//
// A hit costs no DO request. A miss goes through a stricter limiter (index.ts)
// and identical concurrent misses in one isolate share one call.
//
// Staleness: entries live NAME_LOOKUP_CACHE_TTL_SECONDS. The only thing a
// stale entry can do is show a name's previous state for that long (an old
// address of the same owner, or a name that was just claimed or released). It
// never authorises anything: every write goes through the Durable Object, which
// decides on its own state. The colo that handled a write drops its own entry
// (invalidateNameLookup) so the writer sees the result at once.

export const NAME_LOOKUP_CACHE_TTL_SECONDS = 10;

export interface NameLookupResult {
  status: string;
  name?: string;
  address?: string;
  lnAddress?: boolean;
  chatPubkey?: string;
}

export interface LookupCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
}

function cacheKey(handle: string): Request {
  return new Request(`https://names-cache.internal/lookup/${encodeURIComponent(handle)}`);
}

type Outcome = { limited: true } | { limited: false; fresh: NameLookupResult | null; hit: boolean };

// Registered synchronously (before the first await) so that concurrent misses
// for one name join it instead of each starting their own.
const inFlight = new Map<string, Promise<Outcome>>();

export type CachedLookup =
  | { kind: "result"; result: NameLookupResult; hit: boolean }
  | { kind: "unavailable" } // the registry did not answer; nothing was cached
  | { kind: "limited" }; // a miss the caller's limiter refused

// `handle` must already be normalised (checkHandle's `handle`): it is the key.
// `answerLocally` runs on a cache miss and may answer without the registry
// (not cached: it is as cheap as the cache). `allowMiss` runs only when it did
// not, before any Durable Object call, and once for all the callers that join
// the same in-flight lookup.
export async function cachedNameLookup(
  cache: LookupCache,
  handle: string,
  fetchFresh: () => Promise<NameLookupResult | null>,
  allowMiss: () => Promise<boolean>,
  answerLocally: () => Promise<NameLookupResult | null> = async () => null,
  joinable: boolean = true,
): Promise<CachedLookup> {
  const key = cacheKey(handle);
  const joined = joinable ? inFlight.get(handle) : undefined;
  let pending: Promise<Outcome>;
  if (joined) {
    pending = joined;
  } else {
    pending = (async (): Promise<Outcome> => {
      try {
        const cached = await cache.match(key);
        if (cached) return { limited: false, fresh: (await cached.json()) as NameLookupResult, hit: true };
      } catch {
        // A broken cache read is a miss.
      }
      const local = await answerLocally();
      if (local) return { limited: false, fresh: local, hit: true };
      if (!(await allowMiss())) return { limited: true };
      const fresh = await fetchFresh();
      if (fresh) {
        try {
          await cache.put(
            key,
            new Response(JSON.stringify(fresh), {
              headers: {
                "content-type": "application/json",
                "cache-control": `public, max-age=${NAME_LOOKUP_CACHE_TTL_SECONDS}`,
              },
            }),
          );
        } catch {
          // Not cached: the next request asks again.
        }
      }
      return { limited: false, fresh, hit: false };
    })();
    if (joinable) {
      inFlight.set(handle, pending);
      const done = () => {
        if (inFlight.get(handle) === pending) inFlight.delete(handle);
      };
      pending.then(done, done);
    }
  }
  const outcome = await pending;
  if (outcome.limited) {
    // The verdict belongs to whoever started the lookup. A caller that only
    // joined it must not be refused for someone else's spent budget (an
    // attacker over their limit could otherwise keep a refused lookup of a
    // chosen name in flight and turn away everyone asking for it): it asks again
    // on its own budget, without joining.
    if (joined) return cachedNameLookup(cache, handle, fetchFresh, allowMiss, answerLocally, false);
    return { kind: "limited" };
  }
  if (!outcome.fresh) return { kind: "unavailable" };
  return { kind: "result", result: outcome.fresh, hit: outcome.hit };
}

export async function invalidateNameLookup(cache: LookupCache, handle: string): Promise<void> {
  try {
    await cache.delete(cacheKey(handle));
  } catch {
    // Expires by itself within the TTL.
  }
}
