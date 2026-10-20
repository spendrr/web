// Edge cache with stale-if-error and a short failure memory, for the read-only
// proxies in front of third parties (CoinGecko prices, mempool fee estimates
// and the tip block).
//
// What they lacked: a fresh entry was cached, but a FAILURE was not. During a
// CoinGecko outage or once its monthly credit budget was spent (it answers 429
// for the rest of the month), every request after the entry expired went
// upstream again, each one a wasted call that could not succeed, and every
// caller got an error even though the last good value was minutes old.
//
//   fresh   ttlSeconds        served without touching the upstream
//   stale   staleTtlSeconds   a second copy of the last good answer, served only
//                             when the upstream fails
//   failure failureTtlSeconds the fact that the upstream just failed, so a burst
//                             of requests makes one attempt, not one each
//
// Identical concurrent misses in one isolate share one upstream call.

export interface ProxiedJson {
  status: number;
  body: string;
}

export interface UpstreamCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface CachedUpstreamOptions {
  cache: UpstreamCache;
  key: Request;
  ttlSeconds: number;
  staleTtlSeconds: number;
  failureTtlSeconds: number;
  // Performs the upstream call. A non-2xx status is a failure.
  fetcher: () => Promise<ProxiedJson>;
  // Runs once, for a genuine miss only (never a hit), before the upstream call.
  allowMiss?: () => Promise<boolean>;
  inFlight: Map<string, Promise<CachedResult>>;
}

// `refused`: this is our own limiter's verdict on whoever started the lookup, not
// an upstream answer, so a caller that merely joined it must not inherit it.
export type CachedResult = ProxiedJson & { stale?: boolean; refused?: boolean };

const RATE_LIMITED: CachedResult = { status: 429, body: JSON.stringify({ error: "Rate limit exceeded." }), refused: true };

function variant(key: Request, suffix: string): Request {
  return new Request(`${key.url}${key.url.includes("?") ? "&" : "?"}__${suffix}=1`);
}

function stored(body: string, maxAgeSeconds: number): Response {
  return new Response(body, {
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${maxAgeSeconds}` },
  });
}

async function readSafely(cache: UpstreamCache, key: Request): Promise<Response | undefined> {
  try {
    return await cache.match(key);
  } catch {
    return undefined;
  }
}

async function putSafely(cache: UpstreamCache, key: Request, response: Response): Promise<void> {
  try {
    await cache.put(key, response);
  } catch {
    // Not cached: the next request asks again.
  }
}

export async function cachedUpstream(opts: CachedUpstreamOptions, joinable: boolean = true): Promise<CachedResult> {
  const { cache, key } = opts;
  const fresh = await readSafely(cache, key);
  if (fresh) return { status: fresh.status, body: await fresh.text() };

  const flightKey = key.url;
  const joined = joinable ? opts.inFlight.get(flightKey) : undefined;
  if (joined) {
    const shared = await joined;
    // Not refused for someone else's spent budget: ask again on our own.
    return shared.refused ? cachedUpstream(opts, false) : shared;
  }

  const staleKey = variant(key, "stale");
  const failKey = variant(key, "fail");

  const run = (async (): Promise<CachedResult> => {
    const serveStaleOr = async (failure: ProxiedJson): Promise<CachedResult> => {
      if (opts.staleTtlSeconds > 0) {
        const stale = await readSafely(cache, staleKey);
        if (stale) return { status: stale.status, body: await stale.text(), stale: true };
      }
      return failure;
    };

    // A failure remembered a moment ago: no new attempt, and no charge to the
    // caller's limiter either.
    const remembered = await readSafely(cache, failKey);
    if (remembered) {
      let failure: ProxiedJson = { status: 502, body: JSON.stringify({ error: "Upstream unavailable." }) };
      try {
        const parsed = (await remembered.json()) as Partial<ProxiedJson>;
        if (typeof parsed.status === "number" && typeof parsed.body === "string") failure = parsed as ProxiedJson;
      } catch {
        // keep the generic failure
      }
      return serveStaleOr(failure);
    }

    if (opts.allowMiss && !(await opts.allowMiss())) return RATE_LIMITED;

    let result: ProxiedJson;
    try {
      result = await opts.fetcher();
    } catch {
      result = { status: 502, body: JSON.stringify({ error: "Upstream unreachable." }) };
    }

    if (result.status >= 200 && result.status < 300) {
      await putSafely(cache, key, stored(result.body, opts.ttlSeconds));
      if (opts.staleTtlSeconds > 0) await putSafely(cache, staleKey, stored(result.body, opts.staleTtlSeconds));
      return result;
    }

    if (opts.failureTtlSeconds > 0) {
      await putSafely(cache, failKey, stored(JSON.stringify(result), opts.failureTtlSeconds));
    }
    return serveStaleOr(result);
  })();

  if (joinable) {
    opts.inFlight.set(flightKey, run);
    const done = () => {
      if (opts.inFlight.get(flightKey) === run) opts.inFlight.delete(flightKey);
    };
    run.then(done, done);
  }
  return run;
}
