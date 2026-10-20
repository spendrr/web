// What the public Lightning-address routes cost in Durable Object requests
// (Workers Free: 100,000 a day for the whole account), through the real Worker
// handler with the DOs, limiters and edge cache replaced by fakes.
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../worker/index";
import { resetNameSnapshotMemo } from "../worker/nameSnapshot";

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

const HASH = "a".repeat(64);

interface Opts {
  lnurlBudget?: number;
  missBudget?: number;
  // name -> record; a name that is absent is "free"
  names?: Record<string, { address: string; lnAddress: boolean; mailboxId?: string }>;
  ledgerFailsFirst?: boolean;
}

function makeEnv(opts: Opts = {}) {
  const registryCalls: { path: string; name?: string }[] = [];
  const ledgerCalls: { path: string }[] = [];
  let lnurl = opts.lnurlBudget ?? 10_000;
  let miss = opts.missBudget ?? 60;
  let ledgerFailed = false;
  const names = opts.names ?? {};
  const env = {
    LNURL_RATE_LIMITER: { limit: async () => ({ success: lnurl-- > 0 }) },
    NAME_LOOKUP_RATE_LIMITER: { limit: async () => ({ success: true }) },
    NAME_MISS_RATE_LIMITER: { limit: async () => ({ success: miss-- > 0 }) },
    NAME_REGISTRY: {
      idFromName: () => "global",
      get: () => ({
        fetch: async (url: string, init: RequestInit) => {
          const path = new URL(url).pathname;
          // No snapshot here: these tests are about the per-name path (the
          // snapshot has its own in nameSnapshot.test.ts) and count what it costs.
          if (path === "/snapshot") return new Response("n/a", { status: 500 });
          const body = JSON.parse(String(init.body)) as { name?: string };
          registryCalls.push({ path, name: body.name });
          const rec = body.name !== undefined ? names[body.name] : undefined;
          if (path === "/lookup") {
            return Response.json(
              rec ? { status: "taken", name: body.name, address: rec.address, lnAddress: rec.lnAddress } : { status: "free" },
            );
          }
          if (path === "/ln-address/target") {
            return Response.json(
              rec && rec.lnAddress ? { name: body.name, address: rec.address, mailboxId: rec.mailboxId ?? "m" } : null,
            );
          }
          return Response.json(null);
        },
      }),
    },
    LN_LEDGER: {
      idFromName: () => "global",
      get: () => ({
        fetch: async (url: string) => {
          const path = new URL(url).pathname;
          ledgerCalls.push({ path });
          if (opts.ledgerFailsFirst && !ledgerFailed) {
            ledgerFailed = true;
            throw new Error("Durable Object is overloaded.");
          }
          if (path === "/precheck") return Response.json({ ok: false, error: "killed" });
          if (path === "/verify-claim") return Response.json({ record: null, check: false });
          return Response.json(null);
        },
      }),
    },
  };
  return { env, registryCalls, ledgerCalls };
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const get = (env: unknown, path: string, ip = "203.0.113.9") =>
  worker.fetch(new Request(`https://spendrr.app${path}`, { headers: { "CF-Connecting-IP": ip } }), env as never, ctx);
const reason = async (res: Response) => ((await res.json()) as { reason?: string }).reason;

const AMOUNT = "amount=100000";
const ENABLED = { address: "ark1qexample", lnAddress: true };

beforeEach(() => {
  resetNameSnapshotMemo();
  (globalThis as { caches?: unknown }).caches = { default: makeCache() };
});

describe("GET /api/lnurlp/<name>/cb", () => {
  it("an unknown name does not reach a Durable Object once the source is over its limit", async () => {
    const t = makeEnv({ lnurlBudget: 0 });
    const res = await get(t.env, `/api/lnurlp/nobody/cb?${AMOUNT}`);
    expect(await reason(res)).toBe("Příliš mnoho požadavků.");
    expect(t.registryCalls).toHaveLength(0);
  });

  it("a bad amount is refused before any Durable Object is asked", async () => {
    const t = makeEnv({ names: { pavel: ENABLED } });
    const res = await get(t.env, "/api/lnurlp/pavel/cb?amount=abc");
    expect(await reason(res)).toBe("Neplatná částka.");
    expect(t.registryCalls).toHaveLength(0);
  });

  it("a name that is not a handle at all is refused before any Durable Object is asked", async () => {
    const t = makeEnv();
    await get(t.env, `/api/lnurlp/${encodeURIComponent("a b!")}/cb?${AMOUNT}`);
    expect(t.registryCalls).toHaveLength(0);
  });

  it("100 callbacks for a name that does not exist cost at most one Durable Object request", async () => {
    const t = makeEnv();
    for (let i = 0; i < 100; i++) {
      expect(await reason(await get(t.env, `/api/lnurlp/nobody/cb?${AMOUNT}`))).toBe("Tato Lightning adresa není dostupná.");
    }
    expect(t.registryCalls.length).toBeLessThanOrEqual(1);
    expect(t.registryCalls.some((c) => c.path === "/ln-address/target")).toBe(false);
  });

  it("a name with the Lightning address off is refused from the cache", async () => {
    const t = makeEnv({ names: { pavel: { address: "ark1q", lnAddress: false } } });
    for (let i = 0; i < 20; i++) await get(t.env, `/api/lnurlp/pavel/cb?${AMOUNT}`);
    expect(t.registryCalls.filter((c) => c.path === "/ln-address/target")).toHaveLength(0);
  });

  it("a real callback still goes name -> target -> ledger precheck", async () => {
    const t = makeEnv({ names: { pavel: ENABLED } });
    const res = await get(t.env, `/api/lnurlp/pavel/cb?${AMOUNT}`);
    // the fake ledger answers "killed", which the handler reports as unavailable
    expect(await reason(res)).toBe("Dočasně nedostupné.");
    expect(t.registryCalls.some((c) => c.path === "/ln-address/target")).toBe(true);
    expect(t.ledgerCalls.map((c) => c.path)).toEqual(["/precheck"]);
  });
});

describe("GET /.well-known/lnurlp/<name>", () => {
  it("200 requests for one name cost one Durable Object request", async () => {
    const t = makeEnv({ names: { pavel: ENABLED } });
    for (let i = 0; i < 200; i++) {
      const body = (await (await get(t.env, "/.well-known/lnurlp/pavel")).json()) as { tag?: string; callback?: string };
      expect(body.tag).toBe("payRequest");
      expect(body.callback).toBe("https://spendrr.app/api/lnurlp/pavel/cb");
    }
    expect(t.registryCalls).toHaveLength(1);
  });

  it("a flood of distinct names is capped at the miss budget", async () => {
    const t = makeEnv({ missBudget: 20 });
    for (let i = 0; i < 200; i++) await get(t.env, `/.well-known/lnurlp/name${i}x`);
    expect(t.registryCalls.length).toBeLessThanOrEqual(20);
  });

  it("a name without the Lightning address is not available", async () => {
    const t = makeEnv({ names: { pavel: { address: "ark1q", lnAddress: false } } });
    expect(await reason(await get(t.env, "/.well-known/lnurlp/pavel"))).toBe("Tato Lightning adresa není dostupná.");
  });

  it("a refused miss says too many requests", async () => {
    const t = makeEnv({ missBudget: 0 });
    expect(await reason(await get(t.env, "/.well-known/lnurlp/pavel"))).toBe("Příliš mnoho požadavků.");
    expect(t.registryCalls).toHaveLength(0);
  });
});

describe("GET /api/lnurlp/verify/<hash>", () => {
  it("50 polls for a hash the ledger does not know cost one Durable Object request", async () => {
    const t = makeEnv();
    for (let i = 0; i < 50; i++) {
      expect(await reason(await get(t.env, `/api/lnurlp/verify/${HASH}`))).toBe("Faktura nenalezena.");
    }
    expect(t.ledgerCalls).toHaveLength(1);
  });

  it("a failing ledger is not remembered as 'not found'", async () => {
    const t = makeEnv({ ledgerFailsFirst: true });
    await get(t.env, `/api/lnurlp/verify/${HASH}`); // the ledger throws
    await get(t.env, `/api/lnurlp/verify/${HASH}`); // asked again, answers
    expect(t.ledgerCalls).toHaveLength(2);
  });
});
