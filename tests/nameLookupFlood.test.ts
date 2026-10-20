// How many Durable Object requests public name lookups cost, through the real
// Worker handler with the DO, limiters, cache and assets replaced by fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../worker/index";
import { resetNameSnapshotMemo } from "../worker/nameSnapshot";
import { NAME_PROOF_LIFETIME_S } from "../worker/names";

function makeCache() {
  const store = new Map<string, Response>();
  return {
    async match(req: Request) {
      return store.get(req.url)?.clone();
    },
    async put(req: Request, res: Response) {
      store.set(req.url, res);
    },
    async delete(req: Request) {
      return store.delete(req.url);
    },
  };
}

function makeEnv(opts: { missBudget?: number; lookupBudget?: number } = {}) {
  const doCalls: { path: string; body: unknown }[] = [];
  let miss = opts.missBudget ?? 20;
  let lookup = opts.lookupBudget ?? 120;
  const env = {
    NAME_LOOKUP_RATE_LIMITER: { limit: async () => ({ success: lookup-- > 0 }) },
    NAME_MISS_RATE_LIMITER: { limit: async () => ({ success: miss-- > 0 }) },
    NAME_REGISTRY: {
      idFromName: () => "global",
      get: () => ({
        fetch: async (url: string, init: RequestInit) => {
          const path = new URL(url).pathname;
          doCalls.push({ path, body: JSON.parse(String(init.body)) });
          return Response.json({ status: "free" });
        },
      }),
    },
    ASSETS: { fetch: async () => new Response("<html><head></head></html>", { headers: { "content-type": "text/html" } }) },
  };
  return { env, doCalls };
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const get = (env: unknown, path: string) =>
  worker.fetch(new Request(`https://spendrr.app${path}`, { headers: { "CF-Connecting-IP": "203.0.113.9" } }), env as never, ctx);

beforeEach(() => {
  resetNameSnapshotMemo();
  (globalThis as { caches?: unknown }).caches = { default: makeCache() };
});

describe("public name lookups and the Durable Object request budget", () => {
  it("200 lookups of one name cost one DO request", async () => {
    const t = makeEnv({ lookupBudget: 1000 });
    for (let i = 0; i < 200; i++) expect((await get(t.env, "/api/names/pavel")).status).toBe(404);
    expect(t.doCalls.filter((c) => c.path === "/lookup")).toHaveLength(1);
  });

  it("a flood of distinct names is capped at the miss budget", async () => {
    const t = makeEnv({ lookupBudget: 10_000, missBudget: 20 });
    const statuses: number[] = [];
    for (let i = 0; i < 300; i++) statuses.push((await get(t.env, `/api/names/random-name-${i}`)).status);
    expect(t.doCalls.filter((c) => c.path === "/lookup")).toHaveLength(20);
    expect(statuses.filter((s) => s === 429)).toHaveLength(280);
  });

  it("names that cannot exist never reach the DO", async () => {
    const t = makeEnv({ lookupBudget: 10_000 });
    for (const bad of ["a", "ab", "UPPER%20CASE", "x".repeat(40), "bad!chars", "-lead"]) {
      const res = await get(t.env, `/api/names/${bad}`);
      expect(res.status).toBe(404);
    }
    expect(t.doCalls).toHaveLength(0);
  });

  it("a profile page for an invalid name costs no DO request (it used to)", async () => {
    const t = makeEnv({ lookupBudget: 10_000 });
    for (const bad of ["/@a", "/@ab", "/@bad!chars", `/@${"x".repeat(40)}`, "/%40-lead"]) {
      const res = await get(t.env, bad);
      expect(res.status).toBe(200);
    }
    expect(t.doCalls).toHaveLength(0);
  });

  it("profile pages of one valid name share the lookup with the API", async () => {
    const t = makeEnv({ lookupBudget: 10_000 });
    for (let i = 0; i < 50; i++) await get(t.env, "/@pavel");
    for (let i = 0; i < 50; i++) await get(t.env, "/api/names/pavel");
    expect(t.doCalls.filter((c) => c.path === "/lookup")).toHaveLength(1);
  });

  it("the generous per-request limiter still applies to hits", async () => {
    const t = makeEnv({ lookupBudget: 5, missBudget: 100 });
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await get(t.env, "/api/names/pavel")).status);
    expect(statuses.slice(0, 5).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(5).every((s) => s === 429)).toBe(true);
  });
});

describe("writes and the cache", () => {
  const ID = "02" + "ab".repeat(32);
  const le64 = (n: number) => {
    let hex = "";
    let v = BigInt(n);
    for (let i = 0; i < 8; i++) {
      hex += Number(v & 0xffn).toString(16).padStart(2, "0");
      v >>= 8n;
    }
    return hex;
  };
  // "ark1" + 60 bech32-ish chars; the Worker only checks the shape
  const ADDRESS = "ark1" + "q".repeat(60);
  afterEach(() => vi.unstubAllGlobals());

  it("a claim drops the cached 'free' answer, so the claimer sees the name at once", async () => {
    // a registry with real (tiny) state
    const names = new Map<string, string>();
    const consumed = new Set<string>();
    let lookups = 0;
    const env = {
      NAME_LOOKUP_RATE_LIMITER: { limit: async () => ({ success: true }) },
      NAME_MISS_RATE_LIMITER: { limit: async () => ({ success: true }) },
      NAME_WRITE_RATE_LIMITER: { limit: async () => ({ success: true }) },
      PUSH_SUBSCRIPTIONS: { get: async () => null, put: async () => {}, getWithMetadata: async () => ({ value: null, metadata: null }) },
      NAME_REGISTRY: {
        idFromName: () => "global",
        get: () => ({
          fetch: async (url: string, init: RequestInit) => {
            const path = new URL(url).pathname;
            const body = JSON.parse(String(init.body));
            if (path === "/lookup") {
              lookups++;
              const address = names.get(body.name);
              return Response.json(address ? { status: "taken", name: body.name, address } : { status: "free" });
            }
            if (path === "/consume") {
              const fresh = !consumed.has(body.hash);
              consumed.add(body.hash);
              return Response.json({ ok: fresh });
            }
            if (path === "/set") {
              names.set(body.name, body.address);
              return Response.json({ ok: true, action: "claimed", name: body.name, address: body.address });
            }
            return Response.json({});
          },
        }),
      },
    };
    // the Ark server accepts the authorization
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));

    const lookup = async () => (await get(env, "/api/names/pavel")).json();
    expect(await lookup()).toEqual({ status: "free" });
    expect(await lookup()).toEqual({ status: "free" }); // cached
    expect(lookups).toBe(1);

    const auth = ID + le64(Math.floor(Date.now() / 1000) + NAME_PROOF_LIFETIME_S) + "cd".repeat(64);
    const res = await worker.fetch(
      new Request("https://spendrr.app/api/names/set", {
        method: "POST",
        headers: { Origin: "https://spendrr.app", "content-type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
        body: JSON.stringify({ name: "pavel", address: ADDRESS, mailboxId: ID, mailboxAuthorization: auth }),
      }),
      env as never,
      ctx,
    );
    expect(res.status).toBe(200);

    expect(await lookup()).toMatchObject({ name: "pavel", address: ADDRESS });
    expect(lookups).toBe(2); // the write dropped the entry, the next lookup went to the registry
  });
});
