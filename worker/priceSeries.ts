// Pure logic for the shared price history (no Worker, KV or network here, so it
// is unit-testable; the KV and cron glue lives in priceCache.ts).
//
// Why this exists. CoinGecko's Demo plan is 10,000 credits a month and history
// was fetched per colo, per currency, per range, on demand: one busy chart could
// cost more than the whole remaining budget (see priceCache.ts). Shrinking the
// cost by serving older data would make the widget lag the price.
//
// Instead: the older part of a chart is immutable, so it can come from a
// series fetched rarely; the END of every chart is stitched on from a log of
// the app's own price (the cron already fetches /simple every ~6 minutes and
// now remembers each result for a day). A chart is therefore as fresh as the
// price shown next to it, whatever the age of the fetched series.
//
// Three fetched series per currency serve all five ranges, with the same
// granularity CoinGecko gives each range today (1 day: 5 minutes, 2 to 90 days:
// hourly, more: daily):
//   d1   days=1                       -> the 1 day chart
//   d90  days=90 (hourly)             -> 7, 30 and 90 days, cut to length
//   d365 days=365, interval=daily     -> the 1 year chart

export type Point = [number, number];
// [timestamp ms, czk, eur, usd]
export type RingPoint = [number, number, number, number];

export const CURRENCIES = ["czk", "eur", "usd"] as const;
export type Currency = (typeof CURRENCIES)[number];
export const CURRENCY_COLUMN: Record<Currency, 1 | 2 | 3> = { czk: 1, eur: 2, usd: 3 };

export type SeriesName = "d1" | "d90" | "d365";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ttlMs: how old a fetched series may get before the cron refreshes it. Monthly
// credits per currency: 30 d / ttl -> 240 + 240 + 60 = 540; all three
// currencies 1,620, on top of /simple's 7,200 (Demo budget 10,000).
export const SERIES: Record<SeriesName, { days: number; interval?: "daily"; ttlMs: number }> = {
  d1: { days: 1, ttlMs: 3 * HOUR },
  d90: { days: 90, ttlMs: 3 * HOUR },
  d365: { days: 365, interval: "daily", ttlMs: 12 * HOUR },
};

export function seriesNameFor(days: number): SeriesName | null {
  if (days === 1) return "d1";
  if (days === 7 || days === 30 || days === 90) return "d90";
  if (days === 365) return "d365";
  return null;
}

// How long the price log is kept: longer than the oldest fetched series can get
// (its ttl, doubled for a missed cron tick, is the most a tail ever has to cover).
export const RING_KEEP_MS = 26 * HOUR;

export function isPoints(x: unknown): x is Point[] {
  return (
    Array.isArray(x) &&
    x.every((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1] > 0)
  );
}

export function isRing(x: unknown): x is RingPoint[] {
  return (
    Array.isArray(x) &&
    x.every((p) => Array.isArray(p) && p.length === 4 && p.every((n) => Number.isFinite(n)) && p[1] > 0 && p[2] > 0 && p[3] > 0)
  );
}

// Adds one price observation and drops what is older than RING_KEEP_MS. A point
// not newer than the last one is ignored (a clock step back must not scramble
// the log).
export function appendRing(ring: readonly RingPoint[], point: RingPoint, now: number): RingPoint[] {
  const last = ring[ring.length - 1];
  const next = last && point[0] <= last[0] ? [...ring] : [...ring, point];
  return next.filter((p) => p[0] >= now - RING_KEEP_MS);
}

export function ringColumn(ring: readonly RingPoint[], currency: Currency): Point[] {
  const col = CURRENCY_COLUMN[currency];
  return ring.map((p) => [p[0], p[col]] as Point);
}

// Smallest spacing kept in the stitched tail, so a 90 day hourly chart does not
// get a burst of 6 minute points on its right edge. The very last point is
// always kept: that is the current price.
function tailGapMs(days: number): number {
  if (days === 1) return 0;
  if (days === 365) return 12 * HOUR;
  return 50 * 60_000;
}

// The chart for `days`: the fetched series cut to the range, then every logged
// price newer than the series' last point (thinned), so it ends at the current
// price.
export function buildHistory(series: readonly Point[], days: number, tail: readonly Point[], now: number): Point[] {
  const cut = now - days * DAY;
  const body = series.filter((p) => p[0] >= cut);
  const out: Point[] = [...body];
  let lastTs = body.length > 0 ? body[body.length - 1][0] : -Infinity;
  const gap = tailGapMs(days);
  const fresh = tail.filter((p) => p[0] > lastTs && p[0] <= now + 60_000);
  fresh.forEach((p, i) => {
    const isLast = i === fresh.length - 1;
    if (isLast || p[0] - lastTs >= gap) {
      out.push(p);
      lastTs = p[0];
    }
  });
  return out;
}
