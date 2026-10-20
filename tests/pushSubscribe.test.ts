// handlePushSubscribe's KV traffic, through the real Worker handler with the
// Durable Object and KV replaced by in-memory fakes. What the fakes cannot
// tell is whether the Ark server accepts the authorization; that check lives
// inside the Durable Object and is faked to succeed here.
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../worker/index";

const MAILBOX = "02" + "ab".repeat(32);
const AUTH = "cd".repeat(105);
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";
const DAY = 86400_000;

function makeEnv() {
  // Honours expirationTtl against Date.now(), like KV does.
  const raw = new Map<string, { value: string; metadata: unknown; expiresAt: number }>();
  const kvData = {
    get: (k: string) => {
      const e = raw.get(k);
      return e && Date.now() < e.expiresAt ? e : undefined;
    },
    set: (k: string, e: { value: string; metadata: unknown }) => void raw.set(k, { ...e, expiresAt: Infinity }),
    delete: (k: string) => void raw.delete(k),
  };
  const kvPuts: string[] = [];
  const doCalls: { shard: string; path: string }[] = [];
  const shardHas = new Set<string>(); // shards that already hold the mailbox
  const env = {
    PRICE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    PUSH_RATE_LIMITER: { limit: async () => ({ success: true }) },
    PUSH_SUBSCRIPTIONS: {
      async get(key: string) {
        return kvData.get(key)?.value ?? null;
      },
      async getWithMetadata(key: string) {
        const e = kvData.get(key);
        return e ? { value: e.value, metadata: e.metadata } : { value: null, metadata: null };
      },
      async put(key: string, value: string, options?: { metadata?: unknown; expirationTtl?: number }) {
        kvPuts.push(key);
        raw.set(key, {
          value,
          metadata: options?.metadata ?? null,
          expiresAt: options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : Infinity,
        });
      },
      async delete(key: string) {
        kvData.delete(key);
      },
    },
    MAILBOX_WATCHER: {
      idFromName: (name: string) => name,
      get: (shard: string) => ({
        fetch: async (url: string) => {
          const path = new URL(url).pathname;
          doCalls.push({ shard, path });
          if (path === "/has") return Response.json({ exists: shardHas.has(shard) });
          if (path === "/subscribe") {
            shardHas.add(shard);
            return new Response(null, { status: 204 });
          }
          return new Response(null, { status: 204 });
        },
      }),
    },
  };
  return { env, kvData, kvPuts, doCalls, shardHas };
}

function subscribe(env: unknown, body: Record<string, unknown> = {}) {
  return worker.fetch(
    new Request("https://spendrr.app/api/push/subscribe", {
      method: "POST",
      headers: { Origin: "https://spendrr.app", "content-type": "application/json", "CF-Connecting-IP": "203.0.113.5" },
      body: JSON.stringify({
        mailboxId: MAILBOX,
        mailboxAuthorization: AUTH,
        subscription: { endpoint: ENDPOINT, keys: { p256dh: "a", auth: "b" } },
        ...body,
      }),
    }),
    env as never,
    { waitUntil() {}, passThroughOnException() {} } as never,
  );
}

let realNow = Date.now;
beforeEach(() => {
  Date.now = realNow;
});

describe("POST /api/push/subscribe, KV writes", () => {
  it("a first subscribe writes the placement, the cursor and the endpoint mapping", async () => {
    const t = makeEnv();
    const res = await subscribe(t.env);
    expect(res.status).toBe(204);
    expect(t.kvPuts.filter((k) => k.startsWith("shard-assign:"))).toHaveLength(1);
    expect(t.kvPuts.filter((k) => k.startsWith("endpoint:"))).toHaveLength(1);
  });

  it("renewals write nothing to KV (they used to write the endpoint mapping every time)", async () => {
    const t = makeEnv();
    await subscribe(t.env);
    t.kvPuts.length = 0;
    for (let i = 0; i < 20; i++) expect((await subscribe(t.env)).status).toBe(204);
    expect(t.kvPuts).toEqual([]);
  });

  it("slides both entries forward once they are 11 days old, then stays quiet", async () => {
    const t = makeEnv();
    await subscribe(t.env);
    t.kvPuts.length = 0;
    const start = Date.now();
    Date.now = () => start + 11 * DAY;
    await subscribe(t.env);
    expect(t.kvPuts.sort()).toEqual([`endpoint:${ENDPOINT}`, `shard-assign:${MAILBOX}`].sort());
    t.kvPuts.length = 0;
    await subscribe(t.env);
    expect(t.kvPuts).toEqual([]);
  });

  it("an active subscriber keeps their shard past the old 40-day expiry", async () => {
    const t = makeEnv();
    await subscribe(t.env);
    const shardOf = () => t.kvData.get(`shard-assign:${MAILBOX}`)?.value;
    const first = shardOf();
    // Other subscribers have since filled the first shard and moved the
    // allocator's cursor on: a re-placement would now land somewhere else.
    t.kvData.set("shard-cursor", { value: "5", metadata: null });
    const start = Date.now();
    for (let day = 1; day <= 100; day++) {
      Date.now = () => start + day * DAY;
      await subscribe(t.env);
    }
    expect(shardOf()).toBe(first);
    // never bin-packed a second time
    expect(t.doCalls.filter((c) => c.path === "/subscribe").every((c) => c.shard === first)).toBe(true);
  });

  it("a new endpoint for the same mailbox is written at once", async () => {
    const t = makeEnv();
    await subscribe(t.env);
    t.kvPuts.length = 0;
    await subscribe(t.env, { subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/other", keys: { p256dh: "a", auth: "b" } } });
    // the mapping, plus the daily new-pair budgets it draws from (global and per source)
    expect(t.kvPuts).toContain("endpoint:https://fcm.googleapis.com/fcm/send/other");
    expect(t.kvPuts.filter((k) => !k.startsWith("subscribe-cap:") && !k.startsWith("subscribe-src:"))).toEqual(["endpoint:https://fcm.googleapis.com/fcm/send/other"]);
  });
});

describe("POST /api/push/subscribe, rate limit bucket", () => {
  it("is not spent by (or blocked by) the price proxy's bucket", async () => {
    const t = makeEnv();
    (t.env as { PRICE_RATE_LIMITER: unknown }).PRICE_RATE_LIMITER = { limit: async () => ({ success: false }) };
    expect((await subscribe(t.env)).status).toBe(204);
  });

  it("answers 429 when its own bucket refuses", async () => {
    const t = makeEnv();
    (t.env as { PUSH_RATE_LIMITER: unknown }).PUSH_RATE_LIMITER = { limit: async () => ({ success: false }) };
    expect((await subscribe(t.env)).status).toBe(429);
  });
});
