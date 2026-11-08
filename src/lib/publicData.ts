// Public copies of data that is the same for everybody, written by the
// Worker's cron to a public R2 bucket and served by the CDN on
// data.spendrr.app: reading one costs no Worker request. The price has its own reader in price.ts.
//
// Every URL here is an exact entry in public/fetch-guard.js's list (GET only, no
// query, no prefix): keep the two equal (tests/fetchGuardPrice.test.ts checks
// it). Anything wrong with a copy (missing, unreachable, refused, too old)
// returns null and the caller asks the Worker as before.
import { publicHistoryPath, PUBLIC_HISTORY_CURRENCIES, PUBLIC_HISTORY_DAYS } from "./publicHistory";

export const PUBLIC_DATA_ORIGIN = "https://data.spendrr.app";
export const PUBLIC_FEES_URL = `${PUBLIC_DATA_ORIGIN}/fees.json`;
export const PUBLIC_TIP_URL = `${PUBLIC_DATA_ORIGIN}/tip.json`;
export const PUBLIC_LNADDR_URL = `${PUBLIC_DATA_ORIGIN}/lnaddr.json`;
// Hashes of the registered names (src/lib/names/nameHashSet.ts), binary.
export const PUBLIC_NAMES_URL = `${PUBLIC_DATA_ORIGIN}/names.bin`;

export function publicHistoryUrl(currency: string, days: number): string {
  return `${PUBLIC_DATA_ORIGIN}/${publicHistoryPath(currency, days)}`;
}

// Every URL the app may read from the public bucket, for the guard's test.
export function allPublicDataUrls(): string[] {
  const urls = [PUBLIC_FEES_URL, PUBLIC_TIP_URL, PUBLIC_LNADDR_URL, PUBLIC_NAMES_URL];
  for (const c of PUBLIC_HISTORY_CURRENCIES) for (const d of PUBLIC_HISTORY_DAYS) urls.push(publicHistoryUrl(c, d));
  return urls;
}

// How old a copy may be and still be believed. The cron rewrites fees every 2
// minutes, the block every 5, a chart every 6 minutes (1 day), 30 (7 to 90
// days) or 60 (1 year); past these it has stopped.
export const FEES_MAX_AGE_MS = 15 * 60_000;
// The Lightning address switch is rewritten on every status report tick (5 minutes).
export const LNADDR_MAX_AGE_MS = 30 * 60_000;
export function historyMaxAgeMs(days: number): number {
  if (days === 1) return 20 * 60_000;
  if (days === 365) return 150 * 60_000;
  return 75 * 60_000;
}

const RETRY_MS = 10 * 60_000;
// A copy that hangs must not hold its caller for as long as the browser lets a
// request run (not AbortSignal.timeout(): missing before Safari 16).
const TIMEOUT_MS = 5_000;
const skipUntil = new Map<string, number>();

// The parsed object when it carries an `at` (ms) younger than maxAgeMs, else
// null. A failure keeps this URL off the public path for RETRY_MS, so a copy
// that is down costs one request, not one per call.
export async function readPublicCopy(url: string, maxAgeMs: number): Promise<Record<string, unknown> | null> {
  if (Date.now() < (skipUntil.get(url) ?? 0)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // no-cache: revalidated against the CDN (free, no Worker) every time, so an
    // old answer in the browser's own cache can never hold the data back.
    const res = await fetch(url, { credentials: "omit", cache: "no-cache", signal: controller.signal });
    const data = res.ok ? ((await res.json()) as unknown) : null;
    if (data && typeof data === "object") {
      const at = (data as { at?: unknown }).at;
      if (typeof at === "number" && Number.isFinite(at) && Date.now() - at < maxAgeMs) return data as Record<string, unknown>;
    }
  } catch {
    // falls through
  } finally {
    clearTimeout(timer);
  }
  skipUntil.set(url, Date.now() + RETRY_MS);
  return null;
}
