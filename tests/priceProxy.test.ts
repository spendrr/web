// The public price/fee/tip proxies through the real Worker handler, with the
// edge cache (which honours max-age), the limiter and the upstream faked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../worker/index";

let now = 1_800_000_000_000;
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

let upstream: (url: string) => Response;
let upstreamCalls: string[];
let limiterBudget: number;
const env = () => ({
  PRICE_RATE_LIMITER: { limit: async () => ({ success: limiterBudget-- > 0 }) },
  COINGECKO_API_KEY: "k",
});
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const get = (path: string) =>
  worker.fetch(new Request(`https://spendrr.app${path}`, { headers: { "CF-Connecting-IP": "203.0.113.7" } }), env() as never, ctx);

beforeEach(() => {
  now += 10_000_000; // fresh in-flight keys and cache windows per test
  vi.spyOn(Date, "now").mockImplementation(() => now);
  (globalThis as { caches?: unknown }).caches = { default: makeCache() };
  upstreamCalls = [];
  limiterBudget = 1000;
  upstream = () => new Response("{}", { status: 200 });
  vi.stubGlobal("fetch", async (url: string) => {
    upstreamCalls.push(String(url));
    return upstream(String(url));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const PRICE = JSON.stringify({ bitcoin: { usd: 100000, czk: 2300000, eur: 92000, last_updated_at: 1 } });

describe("/api/price/simple", () => {
  it("costs one CoinGecko call for many requests", async () => {
    upstream = () => new Response(PRICE, { status: 200 });
    for (let i = 0; i < 100; i++) expect((await get("/api/price/simple")).status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
  });

  it("charges the per-IP limiter for the miss only", async () => {
    upstream = () => new Response(PRICE, { status: 200 });
    limiterBudget = 1;
    for (let i = 0; i < 20; i++) expect((await get("/api/price/simple")).status).toBe(200);
  });

  it("keeps serving the last price when CoinGecko starts answering 429 (credits spent)", async () => {
    upstream = () => new Response(PRICE, { status: 200 });
    await get("/api/price/simple");
    now += 400_000;
    upstream = () => new Response('{"status":{"error_code":429}}', { status: 429 });
    const res = await get("/api/price/simple");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(PRICE);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("an outage costs one upstream attempt per minute, not one per request", async () => {
    upstream = () => new Response("down", { status: 503 });
    for (let i = 0; i < 100; i++) await get("/api/price/simple");
    expect(upstreamCalls).toHaveLength(1);
  });

  it("with no copy to fall back on the upstream status is passed through", async () => {
    upstream = () => new Response("{}", { status: 429 });
    expect((await get("/api/price/simple")).status).toBe(429);
  });

  it("history is kept longer the longer the range: 10 min, 30 min, 1 h", async () => {
    upstream = () => new Response('{"prices":[]}', { status: 200 });
    const calls = async (days: number, waitMs: number) => {
      now += 10_000_000; // every case starts from an expired cache
      upstreamCalls = [];
      await get(`/api/price/history?vs_currency=usd&days=${days}`);
      now += waitMs;
      await get(`/api/price/history?vs_currency=usd&days=${days}`);
      return upstreamCalls.length;
    };
    expect(await calls(1, 500_000)).toBe(1); // 8 min: still fresh
    expect(await calls(1, 700_000)).toBe(2); // 11 min: refetched
    expect(await calls(7, 1_500_000)).toBe(1); // 25 min
    expect(await calls(7, 1_900_000)).toBe(2); // 32 min
    expect(await calls(90, 3_000_000)).toBe(1); // 50 min
    expect(await calls(90, 3_700_000)).toBe(2); // 62 min
  });

  it("history ranges are cached per range", async () => {
    upstream = () => new Response('{"prices":[]}', { status: 200 });
    for (let i = 0; i < 20; i++) await get("/api/price/history?vs_currency=usd&days=7");
    for (let i = 0; i < 20; i++) await get("/api/price/history?vs_currency=usd&days=30");
    expect(upstreamCalls).toHaveLength(2);
  });
});

describe("/api/fees/recommended", () => {
  const FEES = '{"fastestFee":5,"halfHourFee":3,"hourFee":2}';

  it("one upstream call for many requests; falls back to the second host", async () => {
    upstream = (url) => (url.includes("second.tech") ? new Response("nope", { status: 404 }) : new Response(FEES, { status: 200 }));
    for (let i = 0; i < 50; i++) expect(await (await get("/api/fees/recommended")).text()).toBe(FEES);
    expect(upstreamCalls).toHaveLength(2); // primary (404) + fallback, once
  });

  it("serves the last estimate when both hosts fail", async () => {
    upstream = () => new Response(FEES, { status: 200 });
    await get("/api/fees/recommended");
    now += 61_000;
    upstream = () => new Response("down", { status: 500 });
    const res = await get("/api/fees/recommended");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FEES);
  });

  it("answers 429 to a miss the limiter refuses, without an upstream call", async () => {
    limiterBudget = 0;
    expect((await get("/api/fees/recommended")).status).toBe(429);
    expect(upstreamCalls).toHaveLength(0);
  });
});

describe("/api/fees/tip", () => {
  const BLOCKS = JSON.stringify([{ height: 900000, timestamp: 1, tx_count: 2000, weight: 4000000, extra: "x" }]);

  it("returns only the picked fields, cached", async () => {
    upstream = () => new Response(BLOCKS, { status: 200 });
    for (let i = 0; i < 20; i++) {
      const body = await (await get("/api/fees/tip")).json();
      expect(body).toEqual({ height: 900000, timestamp: 1, tx_count: 2000, weight: 4000000 });
    }
    expect(upstreamCalls).toHaveLength(1);
  });

  it("502 when neither host answers usefully, and it is remembered for a moment", async () => {
    upstream = () => new Response("[]", { status: 200 });
    expect((await get("/api/fees/tip")).status).toBe(502);
    for (let i = 0; i < 20; i++) await get("/api/fees/tip");
    expect(upstreamCalls).toHaveLength(2); // both hosts, once
  });
});
