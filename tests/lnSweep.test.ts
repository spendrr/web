// The cron's Lightning-address sweep, end to end against a real LnLedger: one
// ledger request a tick when nothing is due, invoices settled from barkd's
// history, and the node's health (auto kill switch, KV mirror, alerts)
// carried in the same request.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../worker/index";
import { LnLedger, NODE_DOWN_AUTO_KILL_MS, type LedgerStorage } from "../worker/lnLedger";
import { LNADDR_REFUSING_KEY } from "../worker/lnAddrHealth";

class MemoryStorage implements LedgerStorage {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, JSON.parse(JSON.stringify(value)));
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async list<T>(options: {
    prefix: string;
    limit?: number;
    startAfter?: string;
    reverse?: boolean;
  }): Promise<Map<string, T>> {
    const keys = [...this.data.keys()]
      .filter((k) => k.startsWith(options.prefix) && (options.startAfter === undefined || k > options.startAfter))
      .sort();
    if (options.reverse) keys.reverse();
    const out = new Map<string, T>();
    for (const k of keys.slice(0, options.limit ?? keys.length)) out.set(k, this.data.get(k) as T);
    return out;
  }
}

function ttlCache() {
  const store = new Map<string, { body: string; until: number }>();
  return {
    async match(req: Request) {
      const e = store.get(req.url);
      return e && Date.now() < e.until ? new Response(e.body) : undefined;
    },
    async put(req: Request, res: Response) {
      const m = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "");
      store.set(req.url, { body: await res.text(), until: Date.now() + (m ? Number(m[1]) * 1000 : 0) });
    },
    async delete(req: Request) {
      return store.delete(req.url);
    },
  };
}

const BARKD = "https://barkd.test";
const PING = "https://hc-ping.test/ln";
const PREIMAGE = "11".repeat(32);
const HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");
const PR = "lnbc10n1sweeptest";

let now: number;
let ledger: LnLedger;
let ledgerPaths: string[];
let barkdPaths: string[];
let pings: string[];
let kv: Map<string, string>;
let nodeUp: boolean;
let dirtyAt: number | null; // upload time of the "newest invoice" object, null = none
let paid: boolean;

const env = () => ({
  BARKD_URL: BARKD,
  BARKD_TOKEN: "t",
  CF_ACCESS_CLIENT_ID: "id",
  CF_ACCESS_CLIENT_SECRET: "s",
  LN_HEALTHCHECK_PING_URL: PING,
  LN_LEDGER: {
    idFromName: () => "global",
    get: () => ({
      fetch: (url: string, init?: RequestInit) => {
        ledgerPaths.push(new URL(url).pathname);
        return ledger.fetch(new Request(url, init));
      },
    }),
  },
  WALLET_BACKUPS: {
    head: async (key: string) => (key === "ln/dirty" && dirtyAt !== null ? { uploaded: new Date(dirtyAt) } : null),
  },
  PUSH_SUBSCRIPTIONS: {
    get: async (k: string) => kv.get(k) ?? null,
    put: async (k: string, v: string) => void kv.set(k, v),
    delete: async (k: string) => void kv.delete(k),
  },
});

// A tick that is not a status report tick (minute 1).
const tick = () => worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 6, 12, 1) } as never, env() as never);

beforeEach(() => {
  now = 1_900_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  ledger = new LnLedger({ storage: new MemoryStorage() } as never);
  ledgerPaths = [];
  barkdPaths = [];
  pings = [];
  kv = new Map();
  nodeUp = true;
  dirtyAt = null;
  paid = false;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(PING)) {
      pings.push(url);
      return new Response("ok");
    }
    if (url.startsWith(BARKD)) {
      if (!nodeUp) throw new Error("connection refused");
      const path = url.slice(BARKD.length);
      barkdPaths.push(path.split("?")[0]);
      if (path.startsWith("/api/v1/history")) {
        return Response.json(paid ? [{ status: "successful", metadata: { payment_preimage: PREIMAGE } }] : []);
      }
      return Response.json([]);
    }
    return new Response("unexpected", { status: 500 });
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  (globalThis as { caches?: unknown }).caches = { default: ttlCache() };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function reserve() {
  const res = await ledger.fetch(
    new Request("https://ln-ledger.internal/reserve", {
      method: "POST",
      body: JSON.stringify({
        hash: HASH,
        name: "pavel",
        address: "ark1x",
        amountSats: 1000,
        comment: null,
        pr: PR,
        source: "203.0.113.7",
        mailboxId: "02" + "ab".repeat(32),
      }),
    }),
  );
  expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
}

async function invoiceState(): Promise<string> {
  const res = await ledger.fetch(
    new Request("https://ln-ledger.internal/status", { method: "POST", body: JSON.stringify({ hash: HASH }) }),
  );
  return ((await res.json()) as { state: string }).state;
}

describe("LN address sweep", () => {
  it("an idle ledger is ticked every few minutes, the node is probed and pinged every minute", async () => {
    await tick();
    now += 60_000;
    await tick(); // idle marker: the ledger is skipped
    expect(ledgerPaths).toEqual(["/tick"]);
    expect(barkdPaths).toEqual(["/api/v1/lightning/receives", "/api/v1/lightning/receives"]);
    expect(pings).toEqual([PING, PING]);

    now += 4 * 60_000; // marker expired
    await tick();
    expect(ledgerPaths).toEqual(["/tick", "/tick"]);
  });

  it("an open invoice that is about to come due keeps the ledger ticking", async () => {
    await reserve();
    await tick(); // the invoice is younger than the sweep age: due in 30 s
    now += 60_000;
    await tick();
    expect(ledgerPaths).toEqual(["/tick", "/tick", "/checked"]);
  });

  it("an invoice opened during the skip makes the next tick run", async () => {
    await tick();
    now += 60_000;
    dirtyAt = now; // the invoice path marked the bucket
    await tick();
    expect(ledgerPaths).toEqual(["/tick", "/tick"]);
  });

  it("an invoice marker that cannot be read never lets a tick be skipped", async () => {
    await tick();
    now += 60_000;
    const noBucket = { ...env(), WALLET_BACKUPS: undefined };
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 6, 12, 1) } as never, noBucket as never);
    expect(ledgerPaths).toEqual(["/tick", "/tick"]);
  });

  it("a status report tick always reaches the ledger", async () => {
    await tick();
    now += 60_000;
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 6, 12, 5) } as never, env() as never);
    expect(ledgerPaths).toEqual(["/tick", "/tick"]);
  });

  it("a node that stops answering is ticked at once, whatever the idle marker says", async () => {
    await tick();
    nodeUp = false;
    now += 60_000;
    await tick();
    expect(ledgerPaths).toEqual(["/tick", "/tick"]);
  });

  it("settles a paid invoice once it is due, and leaves an unpaid one open", async () => {
    await reserve();
    await tick(); // younger than the sweep age: not listed yet
    expect(ledgerPaths).toEqual(["/tick"]);

    now += 5 * 60_000; // past the idle marker
    ledgerPaths = [];
    await tick();
    expect(ledgerPaths).toEqual(["/tick", "/checked"]);
    expect(await invoiceState()).toBe("pending");

    paid = true;
    now += 3 * 60_000; // an unpaid invoice of 5 minutes is looked at every 2
    ledgerPaths = [];
    await tick();
    expect(ledgerPaths).toEqual(["/tick", "/settle"]);
    expect(await invoiceState()).toBe("settled");
  });

  it("node down: no invoice lookups, kill switch after the grace period, mirrored to KV and alerted; lifted when back", async () => {
    await reserve();
    now += 31_000;
    nodeUp = false;
    await tick();
    expect(ledgerPaths).toEqual(["/tick"]);
    expect(pings).toEqual([]);
    expect(kv.has(LNADDR_REFUSING_KEY)).toBe(false);

    now += NODE_DOWN_AUTO_KILL_MS;
    await tick();
    expect(kv.get(LNADDR_REFUSING_KEY)).toBe("1");
    expect(pings).toEqual([`${PING}/fail`]);

    nodeUp = true;
    now += 60_000;
    await tick();
    expect(kv.has(LNADDR_REFUSING_KEY)).toBe(false);
    expect(pings).toEqual([`${PING}/fail`, PING]);
  });
});

describe("LNURL verify polling", () => {
  const verify = async () => {
    const res = await worker.fetch(
      new Request(`https://spendrr.app/api/lnurlp/verify/${HASH}`, { headers: { "CF-Connecting-IP": "203.0.113.9" } }),
      { ...env(), LNURL_RATE_LIMITER: { limit: async () => ({ success: true }) } } as never,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    return (await res.json()) as { settled?: boolean; preimage?: string | null };
  };
  const claimCalls = () => ledgerPaths.filter((p) => p === "/verify-claim").length;
  const historyChecks = () => barkdPaths.filter((p) => p === "/api/v1/history").length;

  beforeEach(() => {
    (globalThis as { caches?: unknown }).caches = { default: ttlCache() };
  });

  it("an unpaid invoice polled every second costs one ledger request per 4 s and a node check per 5 s", async () => {
    await reserve();
    for (let s = 0; s < 10; s++) {
      expect((await verify()).settled).toBe(false);
      now += 1000;
    }
    // Answers are remembered for 4 s: polls at 0, 4 and 8 s reach the ledger.
    expect(claimCalls()).toBe(3);
    // The node is asked at 0 s and again once 5 s have passed (the poll at 8 s), not at 4 s.
    expect(historyChecks()).toBe(2);
  });

  it("a payer is told it is paid on the next poll, without waiting for the cron", async () => {
    await reserve();
    expect((await verify()).settled).toBe(false);
    paid = true;
    now += 6_000; // past both the 4 s answer memory and the 5 s gap between node checks
    const settled = await verify();
    expect(settled.settled).toBe(true);
    expect(settled.preimage).toBe(PREIMAGE);
    expect(await invoiceState()).toBe("settled");

    // Settled is remembered for an hour: no more ledger or node requests.
    const claims = claimCalls();
    const checks = historyChecks();
    for (let s = 0; s < 30; s++) {
      await verify();
      now += 60_000;
    }
    expect(claimCalls()).toBe(claims);
    expect(historyChecks()).toBe(checks);
  });
});
