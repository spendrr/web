import { describe, expect, it, vi } from "vitest";
import {
  NAME_LOOKUP_CACHE_TTL_SECONDS,
  cachedNameLookup,
  invalidateNameLookup,
  type LookupCache,
  type NameLookupResult,
} from "../worker/nameLookupCache";

function fakeCache() {
  const store = new Map<string, Response>();
  const puts: { url: string; cacheControl: string | null }[] = [];
  const cache: LookupCache = {
    async match(req) {
      const r = store.get(req.url);
      return r ? r.clone() : undefined;
    },
    async put(req, res) {
      puts.push({ url: req.url, cacheControl: res.headers.get("cache-control") });
      store.set(req.url, res);
    },
    async delete(req) {
      return store.delete(req.url);
    },
  };
  return { cache, store, puts };
}

const TAKEN: NameLookupResult = { status: "taken", name: "pavel", address: "ark1abc", lnAddress: false };
const allow = async () => true;

describe("cachedNameLookup", () => {
  it("asks the registry once for many identical lookups", async () => {
    const { cache } = fakeCache();
    const fresh = vi.fn(async () => TAKEN);
    for (let i = 0; i < 100; i++) {
      const r = await cachedNameLookup(cache, "pavel", fresh, allow);
      expect(r).toMatchObject({ kind: "result", result: TAKEN });
    }
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("marks the first answer a miss and the rest hits", async () => {
    const { cache } = fakeCache();
    const first = await cachedNameLookup(cache, "pavel", async () => TAKEN, allow);
    const second = await cachedNameLookup(cache, "pavel", async () => TAKEN, allow);
    expect(first).toMatchObject({ hit: false });
    expect(second).toMatchObject({ hit: true });
  });

  it("does not charge the miss limiter for a hit", async () => {
    const { cache } = fakeCache();
    const limiter = vi.fn(async () => true);
    await cachedNameLookup(cache, "pavel", async () => TAKEN, limiter);
    for (let i = 0; i < 20; i++) await cachedNameLookup(cache, "pavel", async () => TAKEN, limiter);
    expect(limiter).toHaveBeenCalledTimes(1);
  });

  it("concurrent identical misses share one registry call and one limiter charge", async () => {
    const { cache } = fakeCache();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fresh = vi.fn(async () => {
      await gate;
      return TAKEN;
    });
    const limiter = vi.fn(async () => true);
    const all = Array.from({ length: 30 }, () => cachedNameLookup(cache, "shared", fresh, limiter));
    await new Promise((r) => setTimeout(r, 5));
    release();
    const results = await Promise.all(all);
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(limiter).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.kind === "result")).toBe(true);
  });

  it("a refused miss never reaches the registry", async () => {
    const { cache } = fakeCache();
    const fresh = vi.fn(async () => TAKEN);
    const r = await cachedNameLookup(cache, "pavel", fresh, async () => false);
    expect(r).toEqual({ kind: "limited" });
    expect(fresh).not.toHaveBeenCalled();
  });

  it("a flood of distinct names costs at most the limiter's budget in registry calls", async () => {
    const { cache } = fakeCache();
    let budget = 20;
    const limiter = async () => budget-- > 0;
    const fresh = vi.fn(async () => ({ status: "free" }));
    const results = await Promise.all(
      Array.from({ length: 1000 }, (_, i) => cachedNameLookup(cache, `name-${i}`, fresh, limiter)),
    );
    expect(fresh).toHaveBeenCalledTimes(20);
    expect(results.filter((r) => r.kind === "limited")).toHaveLength(980);
  });

  it("does not cache a registry failure, so the next request asks again", async () => {
    const { cache, store } = fakeCache();
    const fresh = vi.fn<() => Promise<NameLookupResult | null>>().mockResolvedValueOnce(null).mockResolvedValueOnce(TAKEN);
    expect(await cachedNameLookup(cache, "pavel", fresh, allow)).toEqual({ kind: "unavailable" });
    expect(store.size).toBe(0);
    expect(await cachedNameLookup(cache, "pavel", fresh, allow)).toMatchObject({ kind: "result" });
    expect(fresh).toHaveBeenCalledTimes(2);
  });

  it("caches 'free' and other definite answers, not only taken names", async () => {
    const { cache } = fakeCache();
    const fresh = vi.fn(async () => ({ status: "free" }));
    await cachedNameLookup(cache, "nobody", fresh, allow);
    await cachedNameLookup(cache, "nobody", fresh, allow);
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("stores entries with the short TTL", async () => {
    const { cache, puts } = fakeCache();
    await cachedNameLookup(cache, "pavel", async () => TAKEN, allow);
    expect(puts).toHaveLength(1);
    expect(puts[0].cacheControl).toBe(`public, max-age=${NAME_LOOKUP_CACHE_TTL_SECONDS}`);
    expect(NAME_LOOKUP_CACHE_TTL_SECONDS).toBeLessThanOrEqual(30);
  });

  it("keeps different names apart", async () => {
    const { cache } = fakeCache();
    await cachedNameLookup(cache, "alice", async () => ({ status: "taken", name: "alice", address: "a1" }), allow);
    const r = await cachedNameLookup(cache, "bobby", async () => ({ status: "taken", name: "bobby", address: "b1" }), allow);
    expect(r).toMatchObject({ result: { address: "b1" } });
  });

  it("invalidate drops the entry so the next lookup is fresh", async () => {
    const { cache } = fakeCache();
    let address = "old";
    const fresh = vi.fn(async () => ({ status: "taken", name: "pavel", address }));
    await cachedNameLookup(cache, "pavel", fresh, allow);
    address = "new";
    expect(await cachedNameLookup(cache, "pavel", fresh, allow)).toMatchObject({ result: { address: "old" } }); // stale within TTL
    await invalidateNameLookup(cache, "pavel");
    expect(await cachedNameLookup(cache, "pavel", fresh, allow)).toMatchObject({ result: { address: "new" } });
  });

  it("survives a cache that throws", async () => {
    const broken: LookupCache = {
      match: async () => {
        throw new Error("cache down");
      },
      put: async () => {
        throw new Error("cache down");
      },
      delete: async () => {
        throw new Error("cache down");
      },
    };
    const r = await cachedNameLookup(broken, "pavel", async () => TAKEN, allow);
    expect(r).toMatchObject({ kind: "result", hit: false });
    await expect(invalidateNameLookup(broken, "pavel")).resolves.toBeUndefined();
  });

  it("a caller that only joined a refused lookup asks again on its own budget", async () => {
    const { cache } = fakeCache();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // the leader is over its budget; the joiner is not
    const leaderAllow = async () => {
      await gate;
      return false;
    };
    const joinerAllow = vi.fn(async () => true);
    const fresh = vi.fn(async () => TAKEN);
    const leader = cachedNameLookup(cache, "popular", fresh, leaderAllow);
    await new Promise((r) => setTimeout(r, 5));
    const joiner = cachedNameLookup(cache, "popular", fresh, joinerAllow);
    await new Promise((r) => setTimeout(r, 5));
    release();
    expect(await leader).toEqual({ kind: "limited" });
    expect(await joiner).toMatchObject({ kind: "result", result: TAKEN });
    expect(joinerAllow).toHaveBeenCalledTimes(1);
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("a joiner that is itself over budget is refused too", async () => {
    const { cache } = fakeCache();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const leader = cachedNameLookup(cache, "popular2", async () => TAKEN, async () => {
      await gate;
      return false;
    });
    await new Promise((r) => setTimeout(r, 5));
    const joiner = cachedNameLookup(cache, "popular2", async () => TAKEN, async () => false);
    release();
    expect(await leader).toEqual({ kind: "limited" });
    expect(await joiner).toEqual({ kind: "limited" });
  });
});
