// Live BTC/fiat rates for the balance display. Best-effort only — a failed or
// slow fetch never blocks anything, the fiat line just doesn't show.

import type { FiatCurrency } from "./currency";

const CACHE_MS = 60_000;
// The Worker hands out one shared copy of the price, rewritten by its cron at
// least 330 s apart (worker/priceCache.ts, PRICE_KV_REFRESH_AFTER_MS), so a
// poll every minute mostly gets the same number back. Polling every minute,
// this client sees a new copy at most 60 s (its poll) + 60 s (the colo cache)
// after it was written, so the next one cannot show up sooner than
// 330 - 120 = 210 s after this client saw the last one change. Asking again
// only then, and every minute after, shows a new price exactly as early as
// polling every minute would. Only after a change seen by an unbroken minute
// cadence: after a gap (hidden tab, first load) where in the cycle we are is
// unknown, so it stays one minute.
const QUIET_AFTER_CHANGE_MS = 210_000;
const UNBROKEN_POLL_MS = CACHE_MS + 15_000;
// Expiry is measured from when the request went out and ends a little early:
// callers poll on a 60 s interval, and a cache that outlived the next tick by
// a few ms (the response time) would silently stretch every cadence to 120 s.
const EXPIRY_SLACK_MS = 5_000;

// Both routes are handled by worker/index.ts, which proxies to CoinGecko
// with the API key attached server-side and rate-limits per source IP —
// the wallet's shared Demo key never ships in the client bundle, so no
// single user can read it out and hammer CoinGecko directly. In local
// `vite dev` (no Worker layer) these 404 and the fiat display/easter eggs
// just stay best-effort-empty, same as any other fetch failure.
const SIMPLE_PRICE_URL = "/api/price/simple";
const HISTORY_URL = "/api/price/history";

// A courtesy client-side spacing on top of the edge rate limit — keeps
// rapid UI interaction (e.g. clicking through several chart ranges) from
// firing a burst of requests, so the (still finite) per-IP quota lasts
// longer for normal use rather than being spent on redundant near-instant
// clicks.
const MIN_REQUEST_GAP_MS = 1500;
let lastRequestAt = 0;
let requestQueue: Promise<void> = Promise.resolve();

function throttledFetch(url: string): Promise<Response> {
  const scheduled = requestQueue.then(async () => {
    const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return fetch(url);
  });
  requestQueue = scheduled.then(
    () => undefined,
    () => undefined,
  );
  return scheduled;
}

type Rates = Record<FiatCurrency, number>;

// The same body as SIMPLE_PRICE_URL, written by the Worker's cron to a public
// R2 bucket and served by the CDN (worker/priceCache.ts, publishPublicPrice):
// reading it costs no Worker request, and the price is an open app's most
// frequent one. Trusted only while CoinGecko's own timestamp in it is recent.
// Anything else (not set up, unreachable, refused by CORS, stale) falls back
// to the Worker, which is then used alone for PUBLIC_RETRY_MS. The one
// cross-origin URL public/fetch-guard.js lets through: keep the two equal.
export const PUBLIC_PRICE_URL = "https://data.spendrr.app/price.json";
// The cron rewrites it about every 6 minutes; past this it has stopped.
const PUBLIC_MAX_AGE_MS = 15 * 60_000;
const PUBLIC_RETRY_MS = 30 * 60_000;
// A copy that hangs must not hold the price (and every caller waiting on
// inFlight) for as long as the browser lets a request run.
const PUBLIC_TIMEOUT_MS = 5_000;
let publicSkipUntil = 0;

type ParsedPrice = { rates: Rates; updatedAt: number | null };

function parsePrice(data: unknown): ParsedPrice | null {
  const b = (data as { bitcoin?: { czk?: unknown; eur?: unknown; usd?: unknown; last_updated_at?: unknown } } | null)
    ?.bitcoin;
  if (!b || typeof b.czk !== "number" || typeof b.eur !== "number" || typeof b.usd !== "number") return null;
  const t = b.last_updated_at;
  return {
    rates: { czk: b.czk, eur: b.eur, usd: b.usd },
    updatedAt: typeof t === "number" && Number.isFinite(t) ? t * 1000 : null,
  };
}

async function readPrice(): Promise<ParsedPrice> {
  if (Date.now() >= publicSkipUntil) {
    // Not AbortSignal.timeout(): missing before Safari 16 (see connectivity.ts).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUBLIC_TIMEOUT_MS);
    try {
      // no-cache: the copy is revalidated against the CDN (free, no Worker) every
      // time, so an old answer in the browser's own cache (a 404 from before the
      // file existed, a long Browser TTL) can never hold the price back.
      const res = await fetch(PUBLIC_PRICE_URL, { credentials: "omit", cache: "no-cache", signal: controller.signal });
      const parsed = res.ok ? parsePrice(await res.json()) : null;
      if (parsed && parsed.updatedAt !== null && Date.now() - parsed.updatedAt < PUBLIC_MAX_AGE_MS) return parsed;
    } catch {
      // Falls back below.
    } finally {
      clearTimeout(timer);
    }
    publicSkipUntil = Date.now() + PUBLIC_RETRY_MS;
  }
  const res = await throttledFetch(SIMPLE_PRICE_URL);
  if (!res.ok) throw new Error("Kurz se nepodařilo načíst.");
  const parsed = parsePrice(await res.json());
  if (!parsed) throw new Error("Neplatná odpověď kurzu.");
  return parsed;
}

// updatedAt: when CoinGecko itself last refreshed the price (ms), if it said.
// freshUntil: when to ask the Worker again (see QUIET_AFTER_CHANGE_MS).
let cached: { rates: Rates; at: number; updatedAt: number | null; freshUntil: number } | null = null;
let inFlight: Promise<Rates> | null = null;

export async function fetchBtcRates(): Promise<Rates> {
  if (cached && Date.now() < cached.freshUntil) return cached.rates;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const startedAt = Date.now();
      const { rates, updatedAt } = await readPrice();
      const changedOnCadence =
        cached !== null &&
        updatedAt !== null &&
        cached.updatedAt !== null &&
        updatedAt !== cached.updatedAt &&
        startedAt - cached.at <= UNBROKEN_POLL_MS;
      const wait = changedOnCadence ? QUIET_AFTER_CHANGE_MS : CACHE_MS;
      cached = { rates, at: startedAt, updatedAt, freshUntil: startedAt + wait - EXPIRY_SLACK_MS };
      return rates;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// When CoinGecko itself last refreshed the rates fetchBtcRates currently hands
// out, for an honest "last updated" readout: the Worker's edge cache and this
// module's own cache both sit in between, so the time of our fetch says
// nothing about how old the number is. Null when CoinGecko didn't say.
export function btcRatesUpdatedAt(): number | null {
  return cached?.updatedAt ?? null;
}

export function satsToFiat(sats: number, btcRate: number): number {
  return (sats / 100_000_000) * btcRate;
}

export function fiatToSats(amount: number, btcRate: number): number {
  return Math.round((amount / btcRate) * 100_000_000);
}

export interface PricePoint {
  t: number;
  v: number;
}

export type PriceRange = "1d" | "7d" | "30d" | "3m" | "1y";

const RANGE_DAYS: Record<PriceRange, number> = { "1d": 1, "7d": 7, "30d": 30, "3m": 90, "1y": 365 };

// CoinGecko auto-selects hourly buckets for any days<=90 request (see the
// worker proxy) — great for scrubbing precision, but 30d/3m come back as
// 720/2160 points, which renders as a visually noisy, jittery line rather
// than a readable trend. Cap each range at a target point count that still
// keeps the underlying bucket size reasonable for scrubbing (30d ends up
// ~4h/point, 3m ~12h/point) without the raw hourly noise. 7d/1y are already
// at or below their cap, so this is a no-op for them.
// 1d comes back in 5-minute buckets (~288 points), kept whole.
const RANGE_MAX_POINTS: Record<PriceRange, number> = { "1d": 300, "7d": 200, "30d": 180, "3m": 180, "1y": 400 };

function downsample(points: PricePoint[], maxPoints: number): PricePoint[] {
  if (points.length <= maxPoints) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  const sampled: PricePoint[] = [];
  for (let i = 0; i < maxPoints; i++) {
    sampled.push(points[Math.round(i * step)]);
  }
  return sampled;
}

const HISTORY_CACHE_MS = 5 * 60_000;
const historyCache = new Map<string, { points: PricePoint[]; at: number }>();
const historyInFlight = new Map<string, Promise<PricePoint[]>>();

// Powers the price chart behind a double-click on the logo. Same best-effort
// spirit as fetchBtcRates — a failed fetch just leaves the modal showing an
// error, nothing else in the app depends on this.
export async function fetchBtcPriceHistory(currency: FiatCurrency, range: PriceRange): Promise<PricePoint[]> {
  const key = `${currency}:${range}`;
  const cached = historyCache.get(key);
  if (cached && Date.now() - cached.at < HISTORY_CACHE_MS) return cached.points;
  const inFlight = historyInFlight.get(key);
  if (inFlight) return inFlight;
  const days = RANGE_DAYS[range];
  const promise = (async () => {
    try {
      const res = await throttledFetch(`${HISTORY_URL}?vs_currency=${currency}&days=${days}`);
      if (!res.ok) throw new Error("Historii ceny se nepodařilo načíst.");
      const data = (await res.json()) as { prices?: [number, number][] };
      const rawPoints = (data.prices ?? []).map(([t, v]) => ({ t, v }));
      if (rawPoints.length === 0) throw new Error("Prázdná historie ceny.");
      const points = downsample(rawPoints, RANGE_MAX_POINTS[range]);
      historyCache.set(key, { points, at: Date.now() });
      return points;
    } finally {
      historyInFlight.delete(key);
    }
  })();
  historyInFlight.set(key, promise);
  return promise;
}

function fiatFormatter(currency: FiatCurrency): Intl.NumberFormat {
  return new Intl.NumberFormat("cs-CZ", {
    style: "currency",
    currency: currency.toUpperCase(),
    // Without this, Intl renders USD as "US$" under the cs-CZ locale (it
    // disambiguates from other dollar currencies by default) instead of the
    // plain "$" people actually expect.
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: currency === "czk" ? 0 : 2,
  });
}

export function formatFiat(amount: number, currency: FiatCurrency): string {
  return fiatFormatter(currency).format(amount);
}

// Same string as formatFiat, split so the symbol can be styled apart from
// the number wherever the locale puts it.
export function formatFiatParts(amount: number, currency: FiatCurrency): { value: string; symbol: string; symbolFirst: boolean } {
  const parts = fiatFormatter(currency).formatToParts(amount);
  const at = parts.findIndex((p) => p.type === "currency");
  const symbol = at === -1 ? "" : parts[at].value;
  const value = parts
    .filter((p) => p.type !== "currency")
    .map((p) => p.value)
    .join("")
    .trim();
  const firstNumber = parts.findIndex((p) => p.type === "integer");
  return { value, symbol, symbolFirst: at !== -1 && at < firstNumber };
}

// Test-only: the module-level cache would otherwise leak between tests.
export function __resetBtcRatesForTests(): void {
  cached = null;
  inFlight = null;
  lastRequestAt = 0;
  requestQueue = Promise.resolve();
  publicSkipUntil = 0;
}
