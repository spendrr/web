// Shared CoinGecko edge-caching primitives — split out of index.ts so both
// the price proxy (handlePriceProxy there) and the mailbox-check logic
// (mailboxShared.ts's fetchCurrentBtcPriceUsd) can use the exact same cache
// entries/in-flight machinery without index.ts needing to export plain
// values. index.ts also re-exports the MailboxWatcher Durable Object class
// (see mailboxWatcher.ts) — the Workers runtime requires every OTHER export
// of that same entry module to be the default handler itself, so no other
// runtime value (a const, a function) can be exported from index.ts without
// crashing at startup ("Incorrect type for map entry '<name>': the provided
// value is not of type 'function or ExportedHandler'"). Moving anything a
// second file needs into its own module — never re-exported through
// index.ts — is the only way around that.

import type { Env } from "./index";
import { upstreamSignal } from "./upstream";
import {
  appendRing,
  buildHistory,
  CURRENCIES,
  isPoints,
  isRing,
  ringColumn,
  SERIES,
  seriesNameFor,
  type Currency,
  type Point,
  type RingPoint,
  type SeriesName,
} from "./priceSeries";

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
// CoinGecko's own bot filter 403s any request without a descriptive
// User-Agent ("Please add a descriptive User-Agent..."), independent of the
// Demo API key — found live while testing the price-cache change, not
// something the API key header alone gets around.
export const COINGECKO_USER_AGENT = "Spendrr/1.0 (+https://spendrr.app; Bitcoin wallet price display)";

// CoinGecko's Demo plan is a *monthly credit* budget (10k/month observed on
// this app's own dashboard), not the 100/min rate limit alone — a TTL chosen
// against the per-minute number instead of the monthly one still burns
// through the real budget. The client already polls its own /api/price/simple
// at most once a minute with its own 60s cache (Dashboard.tsx's rates
// interval, price.ts's CACHE_MS) — no edge TTL shorter than that buys any
// real freshness a user could ever perceive, so both TTLs here are picked
// against the monthly credit budget, not against how "live" the number
// should feel. /simple is in effect under continuous demand (every mailbox
// watcher asks each minute), so its calls/month are just 30 days / TTL:
// 360s -> ~7,200 (was 600s -> ~4,320; 300s -> ~8,640 would leave too little
// for /history; 60s -> ~43,200 is 4x the budget). Shortened to 6 minutes on
// 2026-09-21 so the v2 price sheet's live refresh has something to show,
// still leaving ~2,800 for /history's on-demand currency/range keys.
export const PRICE_CACHE_TTL_SECONDS = 360;
// History is cached per range, and how old a chart may be scales with what one
// pixel of it means: the 1 day chart has ~5 minute points, the 7 day one hourly
// points, and 30 days and up move by the hour or the day. Each (currency, range)
// key costs up to 30 days / TTL CoinGecko credits per active colo, so the long
// ranges (which barely change in ten minutes) were the wasteful part: at a flat
// 10 minutes every key was up to 4,320 a month per colo, now 4,320 / 1,440 / 720.
export function historyCacheTtlSeconds(days: string): number {
  if (days === "1") return 600;
  if (days === "7") return 1800;
  return 3600;
}

export type { ProxiedJson } from "./upstreamCache";
import { cachedUpstream, type CachedResult, type ProxiedJson } from "./upstreamCache";

// Coalesces concurrent requests for the same cache key within one Worker
// isolate into a single upstream fetch (see upstreamCache.ts). Without this, a
// burst of requests arriving in the gap between a cache entry expiring and the
// first refetch completing would each independently see a cache miss and hit
// CoinGecko — a "cache stampede" that would briefly defeat the whole point of
// caching. Only coalesces within one isolate/colo, not globally, but combined
// with the edge cache's own TTL that keeps worst-case upstream volume small
// regardless of how many users are asking at once.
const priceRequestsInFlight = new Map<string, Promise<CachedResult>>();

// How long the last good answer may still be served when CoinGecko fails (an
// outage, or a 429 once the monthly credit budget is spent). A price shown a few
// hours old, with its own last_updated_at, beats an error for a display-only
// number.
export const PRICE_STALE_TTL_SECONDS = 6 * 60 * 60;
export const PRICE_HISTORY_STALE_TTL_SECONDS = 24 * 60 * 60;
// How long a failed attempt is remembered, so a burst of requests makes one
// upstream call instead of one each.
export const PRICE_FAILURE_TTL_SECONDS = 60;

// browserMaxAge: how long the requesting browser may keep it, when that should
// differ from the edge TTL. 0 means not at all (no-store).
export function priceJsonResponse(result: ProxiedJson, ttlSeconds: number, browserMaxAge = ttlSeconds): Response {
  return new Response(result.body, {
    status: result.status,
    headers: {
      "content-type": "application/json",
      // Public + max-age lets both the edge cache below and the requesting
      // browser reuse this exact response — harmless double caching, since
      // the client (price.ts) already runs its own JS-level cache on
      // roughly the same TTL. Never cached on a non-2xx: a CoinGecko outage
      // or transient error must not get pinned for the full TTL and served
      // to everyone as if it were a real, current answer.
      "cache-control":
        result.status >= 200 && result.status < 300 && browserMaxAge > 0 ? `public, max-age=${browserMaxAge}` : "no-store",
    },
  });
}

// Canonical, host-independent cache keys — not the actual incoming request
// URL — for two reasons: (1) a future custom-domain migration (see the
// scaling plan's domain section) must not silently split one cache entry
// into two just because the request arrived on a different host, and (2) a
// mailbox's own Durable Object (see mailboxWatcher.ts) has no incoming
// request/host of its own at all, and needs to address the exact same
// /simple entry a client request would, so it can reuse it instead of
// hitting CoinGecko separately.
export function priceCacheKey(pathAndQuery: string): Request {
  return new Request(`https://price-cache.internal${pathAndQuery}`);
}

// last_updated_at: when CoinGecko itself last refreshed the price, so the
// client can say how old the number really is, cache layers included.
export const SIMPLE_PRICE_TARGET = `${COINGECKO_BASE}/simple/price?ids=bitcoin&vs_currencies=czk,eur,usd&include_last_updated_at=true`;
export const SIMPLE_PRICE_CACHE_KEY = priceCacheKey("/simple");

// Shared by handlePriceProxy's /simple branch (index.ts) and
// fetchCurrentBtcPriceUsd (mailboxShared.ts) — both want the exact same
// CoinGecko data, so they share the exact same cache entry and in-flight
// fetch instead of each maintaining an independent one that would double the
// real upstream call volume for identical data.
//
// The rate limit is charged only for a genuine miss: a caller hitting this
// route while the cache is warm never pays it, so the per-IP cap is purely
// about bounding how often one caller can force a real upstream refresh right
// after a cache entry expires (the cache TTL already bounds overall traffic
// independent of caller count). A server-initiated caller (no rate limit
// passed) has no caller to attribute one to and is already bounded to once per
// ttlSeconds by this same machinery.
export async function fetchJsonCached(
  env: Env,
  cacheKey: Request,
  target: string,
  ttlSeconds: number,
  rateLimit?: { limiter: RateLimiter; key: string },
  staleTtlSeconds: number = PRICE_STALE_TTL_SECONDS,
): Promise<CachedResult> {
  return cachedUpstream({
    cache: caches.default,
    key: cacheKey,
    ttlSeconds,
    staleTtlSeconds,
    failureTtlSeconds: PRICE_FAILURE_TTL_SECONDS,
    inFlight: priceRequestsInFlight,
    allowMiss: rateLimit ? async () => (await rateLimit.limiter.limit({ key: rateLimit.key })).success : undefined,
    fetcher: async (): Promise<ProxiedJson> => {
      const res = await fetch(target, {
        headers: {
          "User-Agent": COINGECKO_USER_AGENT,
          ...(env.COINGECKO_API_KEY ? { "x-cg-demo-api-key": env.COINGECKO_API_KEY } : {}),
        },
        signal: upstreamSignal(),
      });
      return { status: res.status, body: await res.text() };
    },
  });
}

// --- One copy of the price for every colo -----------------------------------
//
// The edge cache above (caches.default) is per data centre: each colo with
// demand asked CoinGecko itself, so the monthly credit bill grew with the number
// of active colos (about 7,200 credits for ONE continuously demanded colo at a
// 6 minute TTL, against a 10,000 budget), not with the number of users. Here the
// per-minute cron keeps ONE copy in R2, refreshed every PRICE_CACHE_TTL_SECONDS
// whatever the traffic, and every colo reads that copy. Cost is fixed at about
// 7,200 credits a month. It lives in R2, not KV, on purpose: Workers Free allows
// 1,000 KV writes and 100,000 KV reads a day for the whole account, and the
// price data alone would have taken ~300 writes (30%) and, read per request,
// could have overrun the reads. R2 has no daily cap on either (1M writes and
// 10M reads a month included); it is the bucket the backups already use, under
// the `price/` prefix, which no backup key (64 hex characters) can collide with.
//
// Request path: colo cache (60 s) -> shared copy -> the old on-demand path
// (fetchJsonCached) only when there is no usable KV copy (first minutes after a
// deploy, cron down, KV failing), so nothing regresses to "no price".
const PRICE_KV_KEY = "price/simple";
// A KV copy older than this is not trusted as "current" and the on-demand path
// takes over. Two refresh intervals: one missed cron tick is not an outage.
const PRICE_KV_FRESH_MS = 2 * PRICE_CACHE_TTL_SECONDS * 1000;
// Refresh a little early so a tick that lands a few seconds short of the
// interval does not skip a whole extra minute.
const PRICE_KV_REFRESH_AFTER_MS = (PRICE_CACHE_TTL_SECONDS - 30) * 1000;
// Colo-level copy of the stored value: bounds bucket reads to about one a minute per colo.
const PRICE_EDGE_TTL_SECONDS = 60;
// After a failed cron refresh, wait before the next attempt: once a minute
// against a CoinGecko that is answering 429 would only burn credits.
const PRICE_CRON_FAILURE_KEY = new Request("https://price-cache.internal/cron-failure");
const PRICE_CRON_FAILURE_TTL_SECONDS = 5 * 60;
// Its own memory for the history refresh: a history call that fails (a bad body,
// a timeout) must never hold the price refresh off, which matters more.
const HISTORY_CRON_FAILURE_KEY = new Request("https://price-cache.internal/history-cron-failure");

interface StoredPrice {
  at: number;
  body: string;
  // The app's own price log for the last day, one point per refresh (see
  // priceSeries.ts): the tail every history chart is stitched to.
  ring?: RingPoint[];
}

// Same shape the client (price.ts) requires; anything else is not worth serving.
function isUsablePriceBody(body: string): boolean {
  try {
    const b = (JSON.parse(body) as { bitcoin?: Record<string, unknown> }).bitcoin;
    return ["czk", "eur", "usd"].every((c) => typeof b?.[c] === "number" && Number.isFinite(b[c]) && (b[c] as number) > 0);
  } catch {
    return false;
  }
}

async function readObjectText(env: Env, key: string): Promise<string | null> {
  try {
    const object = await env.WALLET_BACKUPS?.get(key);
    return object ? await object.text() : null;
  } catch {
    return null;
  }
}

// A read served from this colo's cache for `ttlSeconds`, so the number of bucket
// reads follows the colo count and the clock, not the traffic.
async function readObjectCached(env: Env, key: string, ttlSeconds: number): Promise<string | null> {
  const cacheKey = new Request(`https://price-cache.internal/object/${key}`);
  try {
    const hit = await caches.default.match(cacheKey);
    if (hit) return await hit.text();
  } catch {
    // a broken cache read is a miss
  }
  const text = await readObjectText(env, key);
  if (text !== null) {
    try {
      await caches.default.put(cacheKey, new Response(text, { headers: { "cache-control": `public, max-age=${ttlSeconds}` } }));
    } catch {
      // not remembered here
    }
  }
  return text;
}

// Never through the object cache above: every caller is already behind a 60 s
// colo cache of its own answer, and a second layer would only add to the age of
// the price.
async function readStoredPrice(env: Env): Promise<StoredPrice | null> {
  try {
    const raw = await readObjectText(env, PRICE_KV_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPrice>;
    if (typeof parsed.at !== "number" || typeof parsed.body !== "string") return null;
    if (!isUsablePriceBody(parsed.body)) return null;
    const ring = isRing((parsed as { ring?: unknown }).ring) ? ((parsed as { ring: RingPoint[] }).ring) : undefined;
    return { at: parsed.at, body: parsed.body, ring };
  } catch {
    return null;
  }
}

// The same body /api/price/simple serves, world-readable in its own bucket
// (PRICE_PUBLIC, behind data.spendrr.app) so an open app reads the price
// without a Worker request (src/lib/price.ts, PUBLIC_PRICE_URL). Its own
// bucket because a public bucket's domain serves everything in it. Optional:
// without the binding the app keeps using /api/price/simple. A failed write
// only leaves the public copy older; the app stops trusting it past 15 min.
export const PUBLIC_PRICE_KEY = "price.json";
const PUBLIC_PRICE_MAX_AGE_SECONDS = 60;

async function publishPublicPrice(env: Env, body: string): Promise<void> {
  if (!env.PRICE_PUBLIC) return;
  try {
    await env.PRICE_PUBLIC.put(PUBLIC_PRICE_KEY, body, {
      httpMetadata: { contentType: "application/json", cacheControl: `public, max-age=${PUBLIC_PRICE_MAX_AGE_SECONDS}` },
    });
  } catch (e) {
    console.error("public price write failed", e instanceof Error ? e.message : e);
  }
}

// Cron half. Never throws; a failed attempt leaves the old copy in place.
export async function refreshSimplePriceIfStale(env: Env): Promise<void> {
  try {
    if (!env.WALLET_BACKUPS) return;
    const stored = await readStoredPrice(env);
    if (stored && Date.now() - stored.at < PRICE_KV_REFRESH_AFTER_MS) return;
    const cache = caches.default;
    if (await cache.match(PRICE_CRON_FAILURE_KEY)) return;

    let body: string | null = null;
    try {
      const res = await fetch(SIMPLE_PRICE_TARGET, {
        headers: {
          "User-Agent": COINGECKO_USER_AGENT,
          ...(env.COINGECKO_API_KEY ? { "x-cg-demo-api-key": env.COINGECKO_API_KEY } : {}),
        },
        signal: upstreamSignal(),
      });
      const text = await res.text();
      if (res.ok && isUsablePriceBody(text)) body = text;
    } catch {
      // handled below
    }
    if (body === null) {
      console.error("price refresh failed, keeping the previous copy");
      await cache
        .put(
          PRICE_CRON_FAILURE_KEY,
          new Response("1", { headers: { "cache-control": `public, max-age=${PRICE_CRON_FAILURE_TTL_SECONDS}` } }),
        )
        .catch(() => undefined);
      return;
    }
    // The same write also carries the price log.
    const now = Date.now();
    const b = (JSON.parse(body) as { bitcoin: Record<Currency, number> }).bitcoin;
    const ring = appendRing(stored?.ring ?? [], [now, b.czk, b.eur, b.usd], now);
    await env.WALLET_BACKUPS.put(PRICE_KV_KEY, JSON.stringify({ at: now, body, ring } satisfies StoredPrice), {
      customMetadata: { at: String(now) },
    });
    await publishPublicPrice(env, body);
  } catch (e) {
    console.error("price refresh error", e instanceof Error ? e.message : e);
  }
}

// Request half, for /api/price/simple and the mailbox watchers' price lookup.
export async function fetchSimplePriceCached(
  env: Env,
  rateLimit?: { limiter: RateLimiter; key: string },
): Promise<CachedResult> {
  const cache = caches.default;
  try {
    const hit = await cache.match(SIMPLE_PRICE_CACHE_KEY);
    if (hit) return { status: hit.status, body: await hit.text() };
  } catch {
    // a broken cache read is a miss
  }

  const stored = await readStoredPrice(env);
  if (stored && Date.now() - stored.at < PRICE_KV_FRESH_MS) {
    try {
      await cache.put(
        SIMPLE_PRICE_CACHE_KEY,
        new Response(stored.body, {
          headers: { "content-type": "application/json", "cache-control": `public, max-age=${PRICE_EDGE_TTL_SECONDS}` },
        }),
      );
    } catch {
      // not remembered here: the next request reads KV again
    }
    return { status: 200, body: stored.body };
  }

  // No current shared copy: ask CoinGecko from here, as before. If that fails
  // too, an older shared copy still beats an error for a display-only number.
  const result = await fetchJsonCached(env, SIMPLE_PRICE_CACHE_KEY, SIMPLE_PRICE_TARGET, PRICE_CACHE_TTL_SECONDS, rateLimit);
  if (result.status >= 200 && result.status < 300) return result;
  if (stored && Date.now() - stored.at < PRICE_STALE_TTL_SECONDS * 1000) return { status: 200, body: stored.body, stale: true };
  return result;
}

// --- Shared history: fetched series + the price log as its tail --------------
//
// Fixed CoinGecko cost whatever the traffic and the number of colos (see
// priceSeries.ts): the cron refreshes each of the 9 series (3 currencies x 3)
// when it is older than its ttl, at most ONE per tick. The requests only read.
const histKey = (currency: Currency, name: SeriesName) => `price/hist/${currency}/${name}`;

interface StoredSeries {
  at: number;
  prices: Point[];
}

async function readSeries(env: Env, currency: Currency, name: SeriesName): Promise<StoredSeries | null> {
  try {
    // A series is hours old by design and its tail comes from the price log, so
    // a colo may keep its copy for ten minutes.
    const raw = await readObjectCached(env, histKey(currency, name), 600);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSeries>;
    return typeof parsed.at === "number" && isPoints(parsed.prices) && parsed.prices.length >= 20
      ? { at: parsed.at, prices: parsed.prices }
      : null;
  } catch {
    return null;
  }
}

// When a stored series was written, without downloading it: the cron asks this
// for every series on every tick.
async function seriesWrittenAt(env: Env, currency: Currency, name: SeriesName): Promise<number | null> {
  try {
    const head = await env.WALLET_BACKUPS?.head(histKey(currency, name));
    const at = Number(head?.customMetadata?.at);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

// Cron half. Refreshes the first series that is due, if any. Its failure memory
// is separate from the /simple refresh's (see HISTORY_CRON_FAILURE_KEY).
export async function refreshHistoryIfStale(env: Env): Promise<void> {
  try {
    if (!env.WALLET_BACKUPS) return;
    const cache = caches.default;
    for (const name of Object.keys(SERIES) as SeriesName[]) {
      for (const currency of CURRENCIES) {
        const cfg = SERIES[name];
        const writtenAt = await seriesWrittenAt(env, currency, name);
        if (writtenAt !== null && Date.now() - writtenAt < cfg.ttlMs - 30_000) continue;
        if (await cache.match(HISTORY_CRON_FAILURE_KEY)) return;

        let prices: Point[] | null = null;
        try {
          const url =
            `${COINGECKO_BASE}/coins/bitcoin/market_chart?vs_currency=${currency}&days=${cfg.days}` +
            (cfg.interval ? `&interval=${cfg.interval}` : "");
          const res = await fetch(url, {
            headers: {
              "User-Agent": COINGECKO_USER_AGENT,
              ...(env.COINGECKO_API_KEY ? { "x-cg-demo-api-key": env.COINGECKO_API_KEY } : {}),
            },
            signal: upstreamSignal(),
          });
          const data = res.ok ? ((await res.json()) as { prices?: unknown }) : null;
          if (data && isPoints(data.prices) && data.prices.length >= 20) prices = data.prices;
        } catch {
          // handled below
        }
        if (prices === null) {
          console.error("price history refresh failed", currency, name);
          await cache
            .put(
              HISTORY_CRON_FAILURE_KEY,
              new Response("1", { headers: { "cache-control": `public, max-age=${PRICE_CRON_FAILURE_TTL_SECONDS}` } }),
            )
            .catch(() => undefined);
          return;
        }
        const at = Date.now();
        await env.WALLET_BACKUPS.put(histKey(currency, name), JSON.stringify({ at, prices } satisfies StoredSeries), {
          customMetadata: { at: String(at) },
        });
        return; // one fetch per tick keeps the cron's subrequest budget
      }
    }
  } catch (e) {
    console.error("price history refresh error", e instanceof Error ? e.message : e);
  }
}

// Request half. The JSON body `{prices}` for one currency and range, or null
// when there is no usable shared series (the caller then asks CoinGecko as
// before). `allowStale`: accept a series of any age, for when that also fails.
export async function sharedHistoryBody(
  env: Env,
  currency: Currency,
  days: number,
  allowStale = false,
): Promise<string | null> {
  const name = seriesNameFor(days);
  if (name === null) return null;
  const cache = caches.default;
  const finalKey = priceCacheKey(`/history-shared?vs_currency=${currency}&days=${days}`);
  if (!allowStale) {
    try {
      const hit = await cache.match(finalKey);
      if (hit) return await hit.text();
    } catch {
      // a broken cache read is a miss
    }
  }
  const series = await readSeries(env, currency, name);
  if (!series) return null;
  if (!allowStale && Date.now() - series.at > SERIES[name].ttlMs * 2) return null;
  const stored = await readStoredPrice(env);
  const tail = stored?.ring ? ringColumn(stored.ring, currency) : [];
  const body = JSON.stringify({ prices: buildHistory(series.prices, days, tail, Date.now()) });
  if (!allowStale) {
    try {
      await cache.put(
        finalKey,
        new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=60" } }),
      );
    } catch {
      // not remembered: the next request rebuilds it
    }
  }
  return body;
}
