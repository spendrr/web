// The shared price copy: the cron keeps ONE copy in KV and every colo reads it,
// so CoinGecko credits no longer grow with the number of active colos.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../worker/index";

let now = 1_900_000_000_000;
function makeCache() {
  const store = new Map<string, { res: Response; expiresAt: number }>();
  return {
    async match(req: Request) {
      const e = store.get(req.url);
      return !e || Date.now() >= e.expiresAt ? undefined : e.res.clone();
    },
    async put(req: Request, res: Response) {
      const m = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "");
      store.set(req.url, { res, expiresAt: Date.now() + (m ? Number(m[1]) * 1000 : 0) });
    },
    async delete(req: Request) {
      return store.delete(req.url);
    },
  };
}

const PRICE = (usd: number) => JSON.stringify({ bitcoin: { usd, czk: usd * 23, eur: usd * 0.9, last_updated_at: 1 } });
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

let kv: Map<string, string>;
let meta: Map<string, Record<string, string>>;
let kvReads: number;
let kvWrites: number;
let upstream: (url: string) => Response;
let upstreamCalls: string[];
const env = () => ({
  PRICE_RATE_LIMITER: { limit: async () => ({ success: true }) },
  COINGECKO_API_KEY: "k",
  WALLET_BACKUPS: {
    async get(k: string) {
      kvReads++;
      const v = kv.get(k);
      return v === undefined ? null : { text: async () => v, body: null, customMetadata: meta.get(k) };
    },
    async head(k: string) {
      return kv.has(k) ? { customMetadata: meta.get(k) } : null;
    },
    async put(k: string, v: string, options?: { customMetadata?: Record<string, string> }) {
      if (k === "price/simple") kvWrites++;
      kv.set(k, v);
      meta.set(k, options?.customMetadata ?? {});
    },
  },
});
const get = () =>
  worker.fetch(new Request("https://spendrr.app/api/price/simple", { headers: { "CF-Connecting-IP": "203.0.113.7" } }), env() as never, ctx);
const tick = () => worker.scheduled({} as never, env() as never);

beforeEach(() => {
  now += 10_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  (globalThis as { caches?: unknown }).caches = { default: makeCache() };
  kv = new Map();
  meta = new Map();
  kvReads = 0;
  kvWrites = 0;
  upstreamCalls = [];
  upstream = () => new Response(PRICE(100000), { status: 200 });
  vi.stubGlobal("fetch", async (url: string) => {
    upstreamCalls.push(String(url));
    return upstream(String(url));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const coingeckoCalls = () => upstreamCalls.filter((u) => u.includes("simple/price"));

describe("cron refresh", () => {
  it("writes one shared copy, then stays quiet until it is about 6 minutes old", async () => {
    await tick();
    expect(kvWrites).toBe(1);
    for (let i = 0; i < 6; i++) {
      now += 60_000;
      await tick();
    }
    expect(kvWrites).toBe(2); // the write at t=0 and the one at t=6 min
    expect(coingeckoCalls()).toHaveLength(2);
  });

  it("keeps the old copy and backs off when CoinGecko fails", async () => {
    await tick();
    const before = kv.get("price/simple");
    upstream = () => new Response("{}", { status: 429 });
    now += 400_000;
    await tick();
    now += 60_000;
    await tick();
    expect(kv.get("price/simple")).toBe(before);
    // one failed attempt, then the 5 minute failure memory holds the next tick off
    expect(coingeckoCalls()).toHaveLength(2);
  });

  it("refuses to store a body the client could not use", async () => {
    upstream = () => new Response('{"bitcoin":{"usd":0}}', { status: 200 });
    await tick();
    expect(kvWrites).toBe(0);
  });

  it("publishes the same body to the public bucket when it is set up, cacheable for a minute", async () => {
    const published: { key: string; value: string; httpMetadata?: Record<string, string> }[] = [];
    const withPublic = () => ({
      ...env(),
      PRICE_PUBLIC: {
        put: async (key: string, value: string, options?: { httpMetadata?: Record<string, string> }) =>
          void published.push({ key, value, httpMetadata: options?.httpMetadata }),
      },
    });
    await worker.scheduled({} as never, withPublic() as never);
    expect(published).toEqual([
      {
        key: "price.json",
        value: PRICE(100000),
        httpMetadata: { contentType: "application/json", cacheControl: "public, max-age=60" },
      },
    ]);
    // Not again until the shared copy itself is refreshed.
    now += 60_000;
    await worker.scheduled({} as never, withPublic() as never);
    expect(published).toHaveLength(1);
  });

  it("without the public bucket nothing changes", async () => {
    await tick();
    expect(kvWrites).toBe(1);
  });
});

describe("/api/price/simple with the shared copy", () => {
  it("many colos and many requests cost no CoinGecko call at all", async () => {
    await tick();
    upstreamCalls = [];
    for (let i = 0; i < 50; i++) {
      // a different colo each time: its own empty cache
      (globalThis as { caches?: unknown }).caches = { default: makeCache() };
      const res = await get();
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(PRICE(100000));
    }
    expect(coingeckoCalls()).toHaveLength(0);
  });

  it("reads KV about once a minute per colo, not once per request", async () => {
    await tick();
    kvReads = 0;
    for (let i = 0; i < 100; i++) await get();
    expect(kvReads).toBe(1);
  });

  it("falls back to asking CoinGecko when there is no usable shared copy", async () => {
    for (let i = 0; i < 10; i++) expect((await get()).status).toBe(200);
    expect(coingeckoCalls()).toHaveLength(1);
  });

  it("serves an older shared copy rather than an error when the fallback fails", async () => {
    await tick();
    now += 20 * 60_000; // past 'fresh' (12 min), still inside the 6 h stale window
    upstream = () => new Response("{}", { status: 429 });
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(PRICE(100000));
  });
});

// --- history -----------------------------------------------------------------
const H = 3_600_000;
const seriesBody = (days: number, stepMs: number) => {
  const prices: [number, number][] = [];
  for (let t = now - days * 24 * H; t <= now; t += stepMs) prices.push([t, 90000 + ((t / 1000) % 500)]);
  return JSON.stringify({ prices });
};
const historyGet = (path: string) =>
  worker.fetch(new Request(`https://spendrr.app/api/price/history?${path}`, { headers: { "CF-Connecting-IP": "203.0.113.7" } }), env() as never, ctx);

describe("history from the shared series", () => {
  const isHist = (u: string) => u.includes("market_chart");
  beforeEach(() => {
    upstream = (url) =>
      isHist(url)
        ? new Response(url.includes("days=1&") || url.endsWith("days=1") ? seriesBody(1, 300_000) : url.includes("days=90") ? seriesBody(90, H) : seriesBody(365, 24 * H), {
            status: 200,
          })
        : new Response(PRICE(100000), { status: 200 });
  });

  it("the cron fills one series per tick, nine in all, and then stops calling", async () => {
    for (let i = 0; i < 12; i++) {
      now += 60_000;
      await tick();
    }
    const hist = upstreamCalls.filter(isHist);
    expect(hist).toHaveLength(9);
    expect([...kv.keys()].filter((k) => k.startsWith("price/hist/"))).toHaveLength(9);
  });

  it("a history refresh that keeps failing never holds the price refresh off", async () => {
    upstream = (url) => (isHist(url) ? new Response("nope", { status: 500 }) : new Response(PRICE(100000), { status: 200 }));
    for (let i = 0; i < 14; i++) {
      await tick();
      now += 60_000;
    }
    expect(kvWrites).toBe(3); // 0, 6 and 12 minutes
  });

  it("serves all five ranges of a currency from three series, with no CoinGecko call", async () => {
    for (let i = 0; i < 12; i++) {
      now += 60_000;
      await tick();
    }
    upstreamCalls = [];
    for (const days of [1, 7, 30, 90, 365]) {
      const res = await historyGet(`vs_currency=czk&days=${days}`);
      expect(res.status).toBe(200);
      const { prices } = (await res.json()) as { prices: [number, number][] };
      expect(prices.length).toBeGreaterThan(20);
      // the chart ends at the logged price, newer than the fetched series
      expect(now - prices[prices.length - 1][0]).toBeLessThan(10 * 60_000);
    }
    expect(upstreamCalls).toHaveLength(0);
  });

  it("the end of the chart follows the price, not the age of the series", async () => {
    for (let i = 0; i < 12; i++) {
      now += 60_000;
      await tick();
    }
    upstream = (url) => (isHist(url) ? new Response("{}", { status: 429 }) : new Response(PRICE(123456), { status: 200 }));
    now += 2 * H + 1000; // series still inside its 3 h ttl, price log keeps growing
    for (let i = 0; i < 25; i++) {
      now += 6 * 60_000;
      await tick();
    }
    const res = await historyGet("vs_currency=usd&days=7");
    const { prices } = (await res.json()) as { prices: [number, number][] };
    expect(prices[prices.length - 1][1]).toBe(123456);
  });

  it("bucket reads follow the clock, not the traffic", async () => {
    for (let i = 0; i < 12; i++) {
      now += 60_000;
      await tick();
    }
    kvReads = 0;
    for (let i = 0; i < 200; i++) {
      for (const days of [1, 7, 30, 90, 365]) await historyGet(`vs_currency=czk&days=${days}`);
    }
    // 1000 requests in one minute: 3 series (cached 10 min) + the price log once per range
    expect(kvReads).toBeLessThanOrEqual(3 + 5);
  });

  it("without a shared series it asks CoinGecko, as before", async () => {
    const res = await historyGet("vs_currency=czk&days=7");
    expect(res.status).toBe(200);
    expect(upstreamCalls.filter(isHist)).toHaveLength(1);
  });
});
