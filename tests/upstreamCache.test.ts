import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedUpstream, type CachedResult, type UpstreamCache } from "../worker/upstreamCache";

// A cache that honours max-age against Date.now(), like the real one.
function fakeCache() {
  const store = new Map<string, { res: Response; expiresAt: number }>();
  const cache: UpstreamCache = {
    async match(req) {
      const e = store.get(req.url);
      if (!e || Date.now() >= e.expiresAt) return undefined;
      return e.res.clone();
    },
    async put(req, res) {
      const m = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "");
      store.set(req.url, { res, expiresAt: Date.now() + (m ? Number(m[1]) * 1000 : 0) });
    },
  };
  return { cache, store };
}

const OK = { status: 200, body: '{"price":1}' };
const key = () => new Request("https://price-cache.internal/simple");

let now = 1_800_000_000_000;
beforeEach(() => vi.spyOn(Date, "now").mockImplementation(() => now));
afterEach(() => vi.restoreAllMocks());

function setup(fetcher: () => Promise<{ status: number; body: string }>, extra: Partial<Parameters<typeof cachedUpstream>[0]> = {}) {
  const { cache } = fakeCache();
  const inFlight = new Map<string, Promise<CachedResult>>();
  const opts = {
    cache,
    key: key(),
    ttlSeconds: 360,
    staleTtlSeconds: 6 * 3600,
    failureTtlSeconds: 60,
    inFlight,
    fetcher,
    ...extra,
  };
  return { call: () => cachedUpstream(opts) };
}

describe("cachedUpstream", () => {
  it("one upstream call for many requests inside the TTL, another after it", async () => {
    const fetcher = vi.fn(async () => OK);
    const { call } = setup(fetcher);
    for (let i = 0; i < 50; i++) expect(await call()).toMatchObject(OK);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 361_000;
    await call();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("serves the last good copy when the upstream fails, and marks it stale", async () => {
    let fail = false;
    const fetcher = vi.fn(async () => (fail ? { status: 429, body: '{"error":"credits"}' } : OK));
    const { call } = setup(fetcher);
    await call();
    now += 400_000; // fresh entry expired
    fail = true;
    const r = await call();
    expect(r).toMatchObject({ status: 200, body: OK.body, stale: true });
  });

  it("a burst of requests during an outage makes one upstream attempt, not one each", async () => {
    let fail = false;
    const fetcher = vi.fn(async () => (fail ? { status: 503, body: "down" } : OK));
    const { call } = setup(fetcher);
    await call();
    now += 400_000;
    fail = true;
    fetcher.mockClear();
    for (let i = 0; i < 200; i++) await call();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries again once the failure memory has expired", async () => {
    let fail = true;
    const fetcher = vi.fn(async () => (fail ? { status: 503, body: "down" } : OK));
    const { call } = setup(fetcher);
    expect((await call()).status).toBe(503);
    expect((await call()).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 61_000;
    fail = false;
    expect(await call()).toMatchObject(OK);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("with nothing to fall back to, the failure is what the caller gets", async () => {
    const { call } = setup(async () => ({ status: 429, body: '{"error":"credits"}' }));
    expect(await call()).toMatchObject({ status: 429, body: '{"error":"credits"}' });
  });

  it("stale copy expires after staleTtlSeconds", async () => {
    let fail = false;
    const { call } = setup(async () => (fail ? { status: 503, body: "down" } : OK), { staleTtlSeconds: 3600 });
    await call();
    fail = true;
    now += 3601_000;
    expect((await call()).status).toBe(503);
  });

  it("a fetcher that throws is a 502 and is remembered", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("dns");
    });
    const { call } = setup(fetcher);
    expect((await call()).status).toBe(502);
    expect((await call()).status).toBe(502);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("charges the limiter for a miss only, never for a hit or a remembered failure", async () => {
    const allow = vi.fn(async () => true);
    const { call } = setup(async () => OK, { allowMiss: allow });
    for (let i = 0; i < 30; i++) await call();
    expect(allow).toHaveBeenCalledTimes(1);
  });

  it("a refused miss reaches no upstream and answers 429", async () => {
    const fetcher = vi.fn(async () => OK);
    const { call } = setup(fetcher, { allowMiss: async () => false });
    expect((await call()).status).toBe(429);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("concurrent misses share one upstream call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetcher = vi.fn(async () => {
      await gate;
      return OK;
    });
    const allow = vi.fn(async () => true);
    const { call } = setup(fetcher, { allowMiss: allow });
    const all = Array.from({ length: 40 }, () => call());
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all(all);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(allow).toHaveBeenCalledTimes(1);
  });

  it("does not cache a 4xx/5xx as a fresh answer", async () => {
    let status = 500;
    const fetcher = vi.fn(async () => ({ status, body: status === 200 ? OK.body : "err" }));
    const { call } = setup(fetcher);
    await call();
    now += 61_000; // failure memory over
    status = 200;
    expect(await call()).toMatchObject(OK);
  });

  it("survives a cache that throws", async () => {
    const broken: UpstreamCache = {
      match: async () => {
        throw new Error("down");
      },
      put: async () => {
        throw new Error("down");
      },
    };
    const r = await cachedUpstream({
      cache: broken,
      key: key(),
      ttlSeconds: 60,
      staleTtlSeconds: 60,
      failureTtlSeconds: 60,
      inFlight: new Map(),
      fetcher: async () => OK,
    });
    expect(r).toMatchObject(OK);
  });

  it("a caller that only joined a refused lookup is not refused for the leader's budget", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { cache } = fakeCache();
    const inFlight = new Map<string, Promise<CachedResult>>();
    const base = { cache, key: key(), ttlSeconds: 360, staleTtlSeconds: 0, failureTtlSeconds: 0, inFlight, fetcher: async () => OK };
    const leader = cachedUpstream({
      ...base,
      allowMiss: async () => {
        await gate;
        return false;
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    const joiner = cachedUpstream({ ...base, allowMiss: async () => true });
    await new Promise((r) => setTimeout(r, 5));
    release();
    expect((await leader).status).toBe(429);
    expect(await joiner).toMatchObject(OK);
  });
});
