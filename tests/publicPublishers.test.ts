// What the minute cron writes to the public bucket (data.spendrr.app): the
// right keys, bodies the app will believe, and the paths that must write nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishPublicChainData } from "../worker/index";
import { publishPublicHistoryStep } from "../worker/priceCache";
import { historyPublishPlan } from "../worker/priceSeries";
import { allPublicDataUrls } from "../src/lib/publicData";
import { isChartPoints } from "../src/lib/publicHistory";

const puts = new Map<string, { body: string; options: unknown }>();
let fetched: string[];
let store: Map<string, string>;

function env(extra: Record<string, unknown> = {}) {
  return {
    PRICE_PUBLIC: { put: async (key: string, body: string, options: unknown) => void puts.set(key, { body, options }) },
    WALLET_BACKUPS: { get: async (key: string) => (store.has(key) ? { text: async () => store.get(key) as string } : null) },
    ...extra,
  } as never;
}

beforeEach(() => {
  puts.clear();
  fetched = [];
  store = new Map();
  const mem = new Map<string, Response>();
  vi.stubGlobal("caches", {
    default: {
      match: async (req: Request) => mem.get(req.url)?.clone(),
      put: async (req: Request, res: Response) => void mem.set(req.url, res),
    },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Minutes whose index is even (fees) and ends in 1 mod 5 (tip): index % 10 === 6.
const FEES_AND_TIP = 29_000_006 * 60_000;
const FEES_ONLY = 29_000_000 * 60_000;
const NEITHER = 29_000_003 * 60_000; // odd, and 3 mod 5

const BLOCKS = [{ height: 900_000, timestamp: 1_800_000_000, tx_count: 3000, weight: 3_990_000, extra: "dropped" }];

function stubUpstreams(opts: { feesFallback?: () => Response; feesPrimary?: () => Response; blocks?: () => Response } = {}) {
  vi.stubGlobal("fetch", async (url: string) => {
    fetched.push(url);
    if (url === "https://mempool.space/api/v1/fees/recommended")
      return (opts.feesFallback ?? (() => Response.json({ fastestFee: 12, halfHourFee: 8, economyFee: 3, minimumFee: 1 })))();
    if (url === "https://mempool.second.tech/api/v1/fees/recommended")
      return (opts.feesPrimary ?? (() => new Response("nope", { status: 404 })))();
    if (url.endsWith("/api/blocks")) return (opts.blocks ?? (() => Response.json(BLOCKS)))();
    return new Response("unexpected", { status: 500 });
  });
}

describe("publishPublicChainData", () => {
  it("writes the three fee numbers with a timestamp, asking the host that has the route first", async () => {
    stubUpstreams();
    await publishPublicChainData(env(), FEES_ONLY);
    expect(fetched).toEqual(["https://mempool.space/api/v1/fees/recommended"]);
    const body = JSON.parse(puts.get("fees.json")?.body ?? "null");
    expect(body).toMatchObject({ fastestFee: 12, halfHourFee: 8, economyFee: 3 });
    expect(typeof body.at).toBe("number");
    expect(body.minimumFee).toBeUndefined();
    expect(puts.has("tip.json")).toBe(false);
  });

  it("falls through to the other host on a bad body or an error status", async () => {
    stubUpstreams({
      feesFallback: () => new Response("<html>bad gateway</html>", { status: 200 }),
      feesPrimary: () => Response.json({ fastestFee: 7, halfHourFee: 5, economyFee: 2 }),
    });
    await publishPublicChainData(env(), FEES_ONLY);
    expect(fetched.length).toBe(2);
    expect(JSON.parse(puts.get("fees.json")?.body ?? "null")).toMatchObject({ fastestFee: 7 });
  });

  it("writes nothing when no host gives usable numbers", async () => {
    stubUpstreams({
      feesFallback: () => Response.json({ fastestFee: 0, halfHourFee: 8, economyFee: 3 }),
      feesPrimary: () => new Response("nope", { status: 404 }),
    });
    await publishPublicChainData(env(), FEES_ONLY);
    expect(puts.size).toBe(0);
  });

  it("writes the last block on its own minutes, trimmed to four fields", async () => {
    stubUpstreams();
    await publishPublicChainData(env(), FEES_AND_TIP);
    const tip = JSON.parse(puts.get("tip.json")?.body ?? "null");
    expect(tip).toMatchObject({ height: 900_000, timestamp: 1_800_000_000, tx_count: 3000, weight: 3_990_000 });
    expect(tip.extra).toBeUndefined();
    expect(typeof tip.at).toBe("number");
  });

  it("does nothing on a minute that is neither, and without the bucket", async () => {
    stubUpstreams();
    await publishPublicChainData(env(), NEITHER);
    expect(fetched).toEqual([]);
    await publishPublicChainData({} as never, FEES_AND_TIP);
    expect(puts.size).toBe(0);
  });

  it("sends the files with a short browser cache", async () => {
    stubUpstreams();
    await publishPublicChainData(env(), FEES_ONLY);
    expect(puts.get("fees.json")?.options).toMatchObject({ httpMetadata: { contentType: "application/json", cacheControl: "public, max-age=60" } });
  });
});

describe("publishPublicHistoryStep", () => {
  const NOW = Date.now();
  const series = (days: number) => {
    const step = (days * 24 * 3_600_000) / 60;
    return Array.from({ length: 60 }, (_, i) => [NOW - days * 24 * 3_600_000 + i * step, 1_000_000 + i]);
  };
  const seed = () => {
    store.set("price/simple", JSON.stringify({ at: NOW, body: JSON.stringify({ bitcoin: { czk: 1_910_000, eur: 70_100, usd: 76_100 } }), ring: [[NOW - 60_000, 1_900_000, 70_000, 76_000], [NOW, 1_910_000, 70_100, 76_100]] }));
    store.set("price/hist/czk/d1", JSON.stringify({ at: NOW, prices: series(1) }));
    store.set("price/hist/czk/d90", JSON.stringify({ at: NOW, prices: series(90) }));
    store.set("price/hist/czk/d365", JSON.stringify({ at: NOW, prices: series(365) }));
  };

  it("writes the 1 day chart of one currency on its minute, ending at the logged price", async () => {
    seed();
    await publishPublicHistoryStep(env(), 6 * 60_000); // minute 6: czk, round 2: the 1 day chart
    expect([...puts.keys()]).toEqual(["history/czk-1.json"]);
    const body = JSON.parse(puts.get("history/czk-1.json")?.body ?? "null");
    expect(isChartPoints(body.prices)).toBe(true);
    expect(body.prices[body.prices.length - 1][1]).toBe(1_910_000);
    expect(typeof body.at).toBe("number");
  });

  it("writes the 7, 30 and 90 day charts from the one hourly series, each cut to its range", async () => {
    seed();
    await publishPublicHistoryStep(env(), 3 * 60_000); // minute 3: czk, round 1
    expect([...puts.keys()].sort()).toEqual(["history/czk-30.json", "history/czk-7.json", "history/czk-90.json"]);
    const len = (k: string) => JSON.parse(puts.get(k)?.body ?? "null").prices.length;
    expect(len("history/czk-7.json")).toBeLessThan(len("history/czk-30.json"));
    expect(len("history/czk-30.json")).toBeLessThan(len("history/czk-90.json"));
  });

  it("skips a series that is missing or too old, so the app keeps using the Worker", async () => {
    seed();
    store.set("price/hist/czk/d1", JSON.stringify({ at: NOW - 7 * 3_600_000, prices: series(1) })); // older than twice its ttl
    await publishPublicHistoryStep(env(), 6 * 60_000);
    expect(puts.size).toBe(0);
    store.delete("price/hist/czk/d1");
    await publishPublicHistoryStep(env(), 6 * 60_000);
    expect(puts.size).toBe(0);
  });

  it("does nothing without the public bucket", async () => {
    seed();
    await publishPublicHistoryStep({ WALLET_BACKUPS: env().WALLET_BACKUPS } as never, 6 * 60_000);
    expect(puts.size).toBe(0);
  });
});

describe("the files the cron writes and the files the app may read", () => {
  it("are the same set of history paths", () => {
    const written = new Set<string>();
    for (let m = 0; m < 3 * 60; m++) {
      const { currency, days } = historyPublishPlan(m);
      for (const d of days) written.add(`https://data.spendrr.app/history/${currency}-${d}.json`);
    }
    const readable = allPublicDataUrls().filter((u) => u.includes("/history/"));
    expect([...written].sort()).toEqual([...readable].sort());
  });
});
