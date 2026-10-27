import { describe, expect, it } from "vitest";
import { cachedUpstream, type CachedResult, type UpstreamCache } from "../worker/upstreamCache";

function memoryCache(): UpstreamCache & { dropAllButStale(): void } {
  const store = new Map<string, Response>();
  return {
    match: async (req) => store.get(req.url)?.clone(),
    put: async (req, res) => void store.set(req.url, res.clone()),
    dropAllButStale: () => {
      for (const k of [...store.keys()]) if (!k.includes("__stale")) store.delete(k);
    },
  };
}

async function run(cache: ReturnType<typeof memoryCache>, status: number, staleOn?: (s: number) => boolean) {
  return cachedUpstream({
    cache,
    key: new Request("https://x.internal/v1?n=a"),
    ttlSeconds: 60,
    staleTtlSeconds: 600,
    failureTtlSeconds: 30,
    staleOn,
    inFlight: new Map<string, Promise<CachedResult>>(),
    fetcher: async () => ({ status, body: JSON.stringify({ s: status }) }),
  });
}

describe("cachedUpstream staleOn", () => {
  async function primed() {
    const cache = memoryCache();
    expect((await run(cache, 200)).status).toBe(200);
    cache.dropAllButStale(); // fresh entry gone, only the stale copy is left
    return cache;
  }

  it("by default any failure is answered with the stale copy", async () => {
    const cache = await primed();
    const r = await run(cache, 404);
    expect(r.status).toBe(200);
    expect(r.stale).toBe(true);
  });

  it("with staleOn, a definite answer is not replaced by the stale copy", async () => {
    const cache = await primed();
    expect((await run(cache, 404, (s) => s >= 500)).status).toBe(404);
  });

  it("with staleOn, an upstream failure still falls back to the stale copy", async () => {
    const cache = await primed();
    const r = await run(cache, 502, (s) => s >= 500);
    expect(r.status).toBe(200);
    expect(r.stale).toBe(true);
  });
});
