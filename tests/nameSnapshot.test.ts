// The name snapshot: a compact set of the names the registry knows anything
// about, so a lookup of any other name is answered at the edge and never costs a
// Durable Object request (Workers Free: 100,000 a day for the whole account).
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../worker/index";
import {
  currentNameSnapshot,
  decodeNameSnapshot,
  encodeNameSnapshot,
  invalidateNameSnapshot,
  NAME_SNAPSHOT_TTL_SECONDS,
  resetNameSnapshotMemo,
} from "../worker/nameSnapshot";
import { NAME_QUARANTINE_MS, NameRegistry, NameRegistryCore, type NameStorage } from "../worker/names";

class MemoryStorage implements NameStorage {
  readonly data = new Map<string, unknown>();
  lists = 0;
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async list<T>(options: { prefix: string; limit?: number; startAfter?: string }): Promise<Map<string, T>> {
    this.lists++;
    const keys = [...this.data.keys()]
      .filter((k) => k.startsWith(options.prefix) && (options.startAfter === undefined || k > options.startAfter))
      .sort();
    const out = new Map<string, T>();
    for (const k of keys.slice(0, options.limit ?? keys.length)) out.set(k, this.data.get(k) as T);
    return out;
  }
}

const A = "ark1" + "q".repeat(60);
const MB1 = "02" + "a".repeat(64);
const MB2 = "02" + "b".repeat(64);

function makeCache() {
  const store = new Map<string, Response>();
  return {
    puts: 0,
    async match(req: Request) {
      return store.get(req.url)?.clone();
    },
    async put(req: Request, res: Response) {
      this.puts++;
      store.set(req.url, res);
    },
    async delete(req: Request) {
      return store.delete(req.url);
    },
  };
}

beforeEach(() => {
  resetNameSnapshotMemo();
  (globalThis as { caches?: unknown }).caches = { default: makeCache() };
});
afterEach(() => vi.useRealTimers());

describe("encode / decode", () => {
  it("has() is true for every encoded name (no false negatives)", () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z0-9_-]{3,20}$/), { maxLength: 200 }), (names) => {
        const snapshot = decodeNameSnapshot(encodeNameSnapshot(names, 1));
        expect(snapshot).not.toBeNull();
        for (const n of names) expect(snapshot!.has(n)).toBe(true);
      }),
    );
  });

  it("names that were not encoded are (almost always) absent", () => {
    const known = Array.from({ length: 500 }, (_, i) => `known${i}`);
    const snapshot = decodeNameSnapshot(encodeNameSnapshot(known, 1))!;
    let falsePositives = 0;
    for (let i = 0; i < 5000; i++) if (snapshot.has(`stranger${i}`)) falsePositives++;
    expect(falsePositives).toBeLessThanOrEqual(1);
  });

  it("an empty snapshot is valid and has nothing", () => {
    const snapshot = decodeNameSnapshot(encodeNameSnapshot([], 1))!;
    expect(snapshot.has("pavel")).toBe(false);
  });

  it("duplicates are harmless", () => {
    const snapshot = decodeNameSnapshot(encodeNameSnapshot(["pavel", "pavel", "jana"], 1))!;
    expect(snapshot.has("pavel")).toBe(true);
    expect(snapshot.has("jana")).toBe(true);
  });

  it("a large registry encodes and decodes (no call-stack overflow, exact membership)", () => {
    const names = Array.from({ length: 150_000 }, (_, i) => `n${i.toString(36)}x`);
    const snapshot = decodeNameSnapshot(encodeNameSnapshot(names, 1))!;
    expect(snapshot.count).toBeGreaterThan(149_000); // a few 32-bit collisions at most
    for (let i = 0; i < names.length; i += 997) expect(snapshot.has(names[i])).toBe(true);
    expect(snapshot.has("definitely-not-there")).toBe(false);
  });

  it("garbage does not decode", () => {
    for (const bad of [null, undefined, "x", 1, {}, { v: 2, at: 1, count: 0, hashes: "" }, { v: 1, at: 1, count: 1, hashes: "AAA" }, { v: 1, at: 1, count: 0, hashes: 5 }]) {
      expect(decodeNameSnapshot(bad as never)).toBeNull();
    }
  });
});

describe("NameRegistryCore.snapshotNames", () => {
  function setup() {
    let t = 1_000_000;
    const storage = new MemoryStorage();
    const core = new NameRegistryCore(storage, () => t, {});
    return { core, storage, advance: (ms: number) => (t += ms) };
  }

  it("holds taken, blocked and quarantined names, nothing else", async () => {
    const { core } = setup();
    expect((await core.set({ name: "pavel", mailboxId: MB1, address: A })).ok).toBe(true);
    expect((await core.set({ name: "jana", mailboxId: MB2, address: A })).ok).toBe(true);
    await core.release(MB2); // jana -> quarantined
    await core.adminBlock("badname");
    const names = (await core.snapshotNames()).sort();
    expect(names).toEqual(["badname", "jana", "pavel"]);
  });

  it("a quarantine that has ended is no longer in it", async () => {
    const { core, advance } = setup();
    await core.set({ name: "jana", mailboxId: MB2, address: A });
    await core.release(MB2);
    advance(NAME_QUARANTINE_MS + 1);
    expect(await core.snapshotNames()).toEqual([]);
  });

  it("an alias is in it", async () => {
    const { core } = setup();
    await core.adminAssign({ name: "donate", mailboxId: MB1, address: A });
    expect(await core.snapshotNames()).toContain("donate");
  });

  it("pages through more names than one listing returns", async () => {
    const { core, storage } = setup();
    for (let i = 0; i < 2500; i++) storage.data.set(`n:name${String(i).padStart(4, "0")}`, {});
    expect(await core.snapshotNames()).toHaveLength(2500);
  });
});

describe("NameRegistry /snapshot (the Durable Object)", () => {
  const post = (registry: NameRegistry, path: string, body: unknown) =>
    registry.fetch(new Request(`https://name-registry.internal${path}`, { method: "POST", body: JSON.stringify(body) }));
  const snapshotOf = async (registry: NameRegistry) =>
    decodeNameSnapshot(await (await post(registry, "/snapshot", {})).json())!;

  it("is rebuilt only after a write, not on every call", async () => {
    const storage = new MemoryStorage();
    const registry = new NameRegistry({ storage }, null);
    await snapshotOf(registry);
    const afterFirst = storage.lists;
    await snapshotOf(registry);
    await snapshotOf(registry);
    expect(storage.lists).toBe(afterFirst);
  });

  it("a claim shows up in the next snapshot", async () => {
    const storage = new MemoryStorage();
    const registry = new NameRegistry({ storage }, null);
    expect((await snapshotOf(registry)).has("pavel")).toBe(false);
    await post(registry, "/set", { name: "pavel", mailboxId: MB1, address: A });
    expect((await snapshotOf(registry)).has("pavel")).toBe(true);
  });

  it("an admin block shows up too (every write path is tracked)", async () => {
    const storage = new MemoryStorage();
    const registry = new NameRegistry({ storage }, null);
    await snapshotOf(registry);
    await post(registry, "/admin/block", { name: "badname" });
    expect((await snapshotOf(registry)).has("badname")).toBe(true);
  });

  it("a stale copy is rebuilt after the maximum age even without a tracked write", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const storage = new MemoryStorage();
    const registry = new NameRegistry({ storage }, null);
    await snapshotOf(registry);
    storage.data.set("n:sneaky", {}); // a write that bypassed the tracker
    expect((await snapshotOf(registry)).has("sneaky")).toBe(false);
    vi.setSystemTime(1_000_000 + 11 * 60 * 1000);
    expect((await snapshotOf(registry)).has("sneaky")).toBe(true);
  });
});

describe("currentNameSnapshot (edge cache and memo)", () => {
  const wire = () => encodeNameSnapshot(["pavel"], 1);

  it("200 callers cost one fetch", async () => {
    const cache = makeCache();
    let fetches = 0;
    const fetchFresh = async () => {
      fetches++;
      return wire();
    };
    for (let i = 0; i < 200; i++) expect((await currentNameSnapshot(cache, fetchFresh))!.has("pavel")).toBe(true);
    expect(fetches).toBe(1);
  });

  it("concurrent callers share one fetch", async () => {
    const cache = makeCache();
    let fetches = 0;
    const fetchFresh = async () => {
      fetches++;
      await new Promise((r) => setTimeout(r, 5));
      return wire();
    };
    await Promise.all(Array.from({ length: 20 }, () => currentNameSnapshot(cache, fetchFresh)));
    expect(fetches).toBe(1);
  });

  it("is fetched again after the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const cache = makeCache();
    let fetches = 0;
    const fetchFresh = async () => {
      fetches++;
      return wire();
    };
    await currentNameSnapshot(cache, fetchFresh);
    vi.setSystemTime(5_000_000 + (NAME_SNAPSHOT_TTL_SECONDS + 1) * 1000);
    resetNameSnapshotMemo(); // the edge entry's own expiry is the cache's job, the memo's is ours
    await cache.delete(new Request("https://names-cache.internal/snapshot"));
    await currentNameSnapshot(cache, fetchFresh);
    expect(fetches).toBe(2);
  });

  it("a failing source gives null and is not hammered", async () => {
    const cache = makeCache();
    let fetches = 0;
    const fetchFresh = async () => {
      fetches++;
      return null;
    };
    for (let i = 0; i < 50; i++) expect(await currentNameSnapshot(cache, fetchFresh)).toBeNull();
    expect(fetches).toBe(1);
  });

  it("garbage from the source is a failure, not a snapshot", async () => {
    const cache = makeCache();
    expect(await currentNameSnapshot(cache, async () => ({ status: "free" }) as never)).toBeNull();
  });

  it("invalidate makes the next caller fetch again", async () => {
    const cache = makeCache();
    let fetches = 0;
    const fetchFresh = async () => {
      fetches++;
      return wire();
    };
    await currentNameSnapshot(cache, fetchFresh);
    await invalidateNameSnapshot(cache);
    await currentNameSnapshot(cache, fetchFresh);
    expect(fetches).toBe(2);
  });
});

// Through the real Worker handler, DO and limiters replaced by fakes.
function makeEnv(opts: { known?: string[]; snapshotFails?: boolean; missBudget?: number } = {}) {
  const calls: { path: string; name?: string }[] = [];
  let miss = opts.missBudget ?? 60;
  const known = opts.known ?? ["pavel"];
  const env = {
    NAME_LOOKUP_RATE_LIMITER: { limit: async () => ({ success: true }) },
    NAME_MISS_RATE_LIMITER: { limit: async () => ({ success: miss-- > 0 }) },
    LNURL_RATE_LIMITER: { limit: async () => ({ success: true }) },
    NAME_REGISTRY: {
      idFromName: () => "global",
      get: () => ({
        fetch: async (url: string, init: RequestInit) => {
          const path = new URL(url).pathname;
          const body = JSON.parse(String(init.body)) as { name?: string };
          calls.push({ path, name: body.name });
          if (path === "/snapshot") {
            return opts.snapshotFails ? new Response("no", { status: 500 }) : Response.json(encodeNameSnapshot(known, 1));
          }
          if (path === "/lookup") {
            return known.includes(body.name ?? "")
              ? Response.json({ status: "taken", name: body.name, address: A, lnAddress: true })
              : Response.json({ status: "free" });
          }
          return Response.json(null);
        },
      }),
    },
    ASSETS: { fetch: async () => new Response("<html><head></head></html>", { headers: { "content-type": "text/html" } }) },
  };
  return { env, calls, lookups: () => calls.filter((c) => c.path === "/lookup") };
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const get = (env: unknown, path: string) =>
  worker.fetch(new Request(`https://spendrr.app${path}`, { headers: { "CF-Connecting-IP": "203.0.113.9" } }), env as never, ctx);

describe("public lookups with a snapshot", () => {
  it("a flood of distinct unknown names costs no lookup at the registry", async () => {
    const t = makeEnv();
    for (let i = 0; i < 300; i++) expect((await get(t.env, `/api/names/nobody${i}x`)).status).toBe(404);
    expect(t.lookups()).toHaveLength(0);
    expect(t.calls.filter((c) => c.path === "/snapshot")).toHaveLength(1);
  });

  it("an unknown name is answered 'free' exactly as the registry would", async () => {
    const t = makeEnv();
    const res = await get(t.env, "/api/names/nobodyx");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ status: "free" });
  });

  it("a reserved name nobody holds is answered 'reserved' locally", async () => {
    const t = makeEnv();
    const res = await get(t.env, "/api/names/admin");
    expect(await res.json()).toEqual({ status: "reserved" });
    expect(t.lookups()).toHaveLength(0);
  });

  it("a name in the snapshot still resolves through the registry (and is cached)", async () => {
    const t = makeEnv({ known: ["pavel"] });
    for (let i = 0; i < 20; i++) {
      const res = await get(t.env, "/api/names/pavel");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ name: "pavel", address: A, lnAddress: true });
    }
    expect(t.lookups()).toHaveLength(1);
  });

  it("a blocked or quarantined name (in the snapshot) is asked at the registry", async () => {
    const t = makeEnv({ known: ["blockedone"] });
    await get(t.env, "/api/names/blockedone");
    expect(t.lookups().map((c) => c.name)).toEqual(["blockedone"]);
  });

  it("without a snapshot it behaves as before: registry lookups, capped by the miss budget", async () => {
    const t = makeEnv({ snapshotFails: true, missBudget: 20 });
    const statuses: number[] = [];
    for (let i = 0; i < 100; i++) statuses.push((await get(t.env, `/api/names/nobody${i}x`)).status);
    expect(t.lookups().length).toBeLessThanOrEqual(20);
    expect(statuses).toContain(429);
  });

  it("the Lightning address routes use it too", async () => {
    const t = makeEnv();
    for (let i = 0; i < 100; i++) await get(t.env, `/.well-known/lnurlp/nobody${i}x`);
    expect(t.lookups()).toHaveLength(0);
  });
});
