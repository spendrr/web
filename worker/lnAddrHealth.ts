// Whether <name>@spendrr.app can take payments right now, for the receive
// screen: while either kill switch in LnLedger is on (the admin's, or the
// automatic one after the node has been down NODE_DOWN_AUTO_KILL_MS) the
// callback refuses every new invoice, and the app should show Ark instead of
// an address that fails once the payer has typed an amount.
//
// Free plan budget: the answer must cost no Durable Object request, since
// every open of the receive screen asks. So the ledger's state is mirrored
// into one KV key, written only when it changes (a few writes a day against
// the 1000 cap) by the minute cron and the admin kill route, both of which
// already talk to the ledger. The public GET reads that key behind the edge
// cache, so a colo reads KV at most once per HEALTH_CACHE_SECONDS whatever the
// traffic. Lives in PUSH_SUBSCRIPTIONS, which already holds small operational
// state (shard cursor, daily counters) and is never listed.

export const LNADDR_REFUSING_KEY = "lnaddr:refusing";
export const HEALTH_CACHE_SECONDS = 30;

export interface FlagKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface HealthCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

// Mirrors the ledger's state into KV, writing only on a change. Reading first
// costs one KV read a minute and keeps it self-healing: a write that failed
// is simply retried on the next tick.
export async function syncLnAddrRefusing(kv: FlagKv, refusing: unknown): Promise<"set" | "cleared" | "unchanged" | "skipped"> {
  if (typeof refusing !== "boolean") return "skipped";
  const stored = (await kv.get(LNADDR_REFUSING_KEY)) === "1";
  if (stored === refusing) return "unchanged";
  if (refusing) {
    await kv.put(LNADDR_REFUSING_KEY, "1");
    return "set";
  }
  await kv.delete(LNADDR_REFUSING_KEY);
  return "cleared";
}

const CACHE_KEY = "https://lnaddr-health.internal/v1";

// GET /api/lnaddr/health: {"ok": boolean}. Not configured (no BARKD_URL) is
// not ok: no address can be paid then. A KV failure answers ok and is not
// cached: the switch is the exception, and a broken mirror must not take the
// address off every receive screen.
export async function lnAddrHealthResponse(cache: HealthCache, kv: FlagKv, configured: boolean): Promise<Response> {
  const key = new Request(CACHE_KEY);
  const hit = await cache.match(key);
  if (hit) return hit;

  let ok: boolean;
  let cacheable = true;
  if (!configured) {
    ok = false;
  } else {
    try {
      ok = (await kv.get(LNADDR_REFUSING_KEY)) !== "1";
    } catch {
      ok = true;
      cacheable = false;
    }
  }
  const response = new Response(JSON.stringify({ ok }), {
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${HEALTH_CACHE_SECONDS}`,
    },
  });
  if (cacheable) await cache.put(key, response.clone());
  return response;
}
