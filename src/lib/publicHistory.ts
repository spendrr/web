// What the price chart files on data.spendrr.app are called and what they hold.
// One list for the Worker that writes them (worker/priceSeries.ts) and the app
// that reads them (publicData.ts, price.ts); public/fetch-guard.js repeats the
// list as plain JavaScript and tests/fetchGuardPrice.test.ts keeps it equal.
export const PUBLIC_HISTORY_CURRENCIES = ["czk", "eur", "usd"] as const;
export const PUBLIC_HISTORY_DAYS = [1, 7, 30, 90, 365] as const;

export function publicHistoryPath(currency: string, days: number): string {
  return `history/${currency}-${days}.json`;
}

// A chart: [timestamp ms, price] pairs of finite numbers, price above zero. The
// same test for what the Worker stores and for a public copy the app is about to
// believe, so one bad entry sends the app to the Worker route instead of
// throwing while the chart is drawn.
export function isChartPoints(x: unknown): x is [number, number][] {
  return (
    Array.isArray(x) &&
    x.every((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1] > 0)
  );
}
