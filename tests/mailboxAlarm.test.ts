// MailboxWatcher.alarm(): the next tick must be scheduled whatever happens
// while checking, and one broken mailbox must not stop the others.
import { beforeEach, describe, expect, it, vi } from "vitest";

const checkPayments = vi.fn(async (..._a: unknown[]) => false);
const checkExpiry = vi.fn(async (..._a: unknown[]) => {});
const tipFetch = vi.fn(async () => 900000);
const priceFetch = vi.fn(async () => 100000);
const verifyAuth = vi.fn(async (..._a: unknown[]) => true);
vi.mock("../worker/mailboxShared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../worker/mailboxShared")>()),
  checkMailboxForPayments: (...a: unknown[]) => checkPayments(...a),
  checkVtxoExpiry: (...a: unknown[]) => checkExpiry(...a),
  fetchTipHeightCached: () => tipFetch(),
  fetchCurrentBtcPriceUsd: () => priceFetch(),
  verifyMailboxAuthorization: (...a: unknown[]) => verifyAuth(...a),
}));

const { MailboxWatcher, CHECKS_PER_INVOCATION, SHARD_TARGET_MAX_MAILBOXES } = await import("../worker/mailboxWatcher");

const NOW_S = () => Math.floor(Date.now() / 1000);
const id = (n: number) => String(n).padStart(2, "0").repeat(33);

function record() {
  return {
    mailboxAuthorization: "aa",
    authExpiresAt: NOW_S() + 3600,
    subscription: { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "p", auth: "a" } },
    checkpoint: "5",
    lastSeenAt: NOW_S(),
  };
}

function makeWatcher(mailboxes: number[], env: Record<string, string> = {}) {
  const data = new Map<string, unknown>();
  data.set("ids", mailboxes.map(id));
  for (const m of mailboxes) data.set(`record:${id(m)}`, record());
  const failing = { get: new Set<string>(), ids: false };
  let alarm: number | null = null;
  const storage = {
    async get(key: string) {
      if (failing.get.has(key)) throw new Error(`storage get failed: ${key}`);
      if (key === "ids" && failing.ids) throw new Error("ids unreadable");
      return data.get(key);
    },
    async put(key: string, value: unknown) {
      data.set(key, value);
    },
    async delete(key: string) {
      return data.delete(key);
    },
    async setAlarm(t: number | Date) {
      alarm = typeof t === "number" ? t : t.getTime();
    },
    async getAlarm() {
      return alarm;
    },
    async deleteAlarm() {
      alarm = null;
    },
  };
  const watcher = new MailboxWatcher({ id: { toString: () => "shard-0" }, storage } as never, env as never);
  return { watcher, data, failing, alarmAt: () => alarm };
}

beforeEach(() => {
  checkPayments.mockReset().mockResolvedValue(false);
  checkExpiry.mockReset().mockResolvedValue(undefined);
  tipFetch.mockClear();
  priceFetch.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("MailboxWatcher.alarm", () => {
  it("checks every mailbox and schedules the next tick", async () => {
    const w = makeWatcher([1, 2, 3]);
    await w.watcher.alarm();
    expect(checkPayments).toHaveBeenCalledTimes(3);
    expect(w.alarmAt()).not.toBeNull();
  });

  it("sweeps again in 15 minutes even with no relay at all, and never asks the relay", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const w = makeWatcher([1]);
    const before = Date.now();
    await w.watcher.alarm();
    const delay = w.alarmAt()! - before;
    expect(delay).toBeGreaterThanOrEqual(15 * 60_000);
    expect(delay).toBeLessThan(15 * 60_000 + 5_000);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("does not schedule anything for an empty shard", async () => {
    const w = makeWatcher([]);
    await w.watcher.alarm();
    expect(w.alarmAt()).toBeNull();
  });

  it("a mailbox whose storage read throws does not stop the others, and the tick is still scheduled", async () => {
    const w = makeWatcher([1, 2, 3]);
    w.failing.get.add(`record:${id(2)}`);
    await expect(w.watcher.alarm()).resolves.toBeUndefined();
    expect(checkPayments).toHaveBeenCalledTimes(2); // 1 and 3
    expect(w.alarmAt()).not.toBeNull();
  });

  it("batches after a failing one are still checked", async () => {
    const many = Array.from({ length: 45 }, (_, i) => i + 1); // BATCH_SIZE is 20, the slice 30
    const w = makeWatcher(many);
    w.failing.get.add(`record:${id(3)}`);
    await w.watcher.alarm();
    await w.watcher.alarm();
    // Two slices of 30 reach all 45 (the second wraps round); only #3 fails.
    const checked = new Set(checkPayments.mock.calls.map((c) => c[1] as string));
    expect(checked.size).toBe(44);
    expect(checked.has(id(3))).toBe(false);
    expect(w.alarmAt()).not.toBeNull();
  });

  it("sweeps a rotating slice: never more than one invocation's budget, every mailbox once per round", async () => {
    const w = makeWatcher(Array.from({ length: 70 }, (_, i) => i + 1));
    const perAlarm: number[] = [];
    for (let a = 0; a < 3; a++) {
      const before = checkPayments.mock.calls.length;
      await w.watcher.alarm();
      perAlarm.push(checkPayments.mock.calls.length - before);
    }
    expect(perAlarm).toEqual([CHECKS_PER_INVOCATION, CHECKS_PER_INVOCATION, CHECKS_PER_INVOCATION]);
    const seen = checkPayments.mock.calls.map((c) => c[1] as string);
    // Three alarms of 30 cover all 70, and the third wraps round to the start.
    expect(new Set(seen).size).toBe(70);
    expect(seen.slice(70)).toEqual([id(1), id(2), id(3), id(4), id(5), id(6), id(7), id(8), id(9), id(10), id(11), id(12), id(13), id(14), id(15), id(16), id(17), id(18), id(19), id(20)]);
  });

  it("counts a mailbox still reading its history as MAX_BACKLOG_PAGES_PER_TICK reads", async () => {
    const w = makeWatcher(Array.from({ length: 10 }, (_, i) => i + 1));
    for (let m = 1; m <= 5; m++) w.data.set(`record:${id(m)}`, { ...record(), checkpoint: "0" });
    for (let m = 6; m <= 8; m++) w.data.set(`record:${id(m)}`, { ...record(), backfilling: true });
    await w.watcher.alarm();
    // 5 + 5 + 5 + 5 + 5 + 5 = 30 reads: six of the eight backfilling ones.
    expect(checkPayments.mock.calls.map((c) => c[1])).toEqual([1, 2, 3, 4, 5, 6].map(id));
    checkPayments.mockClear();
    await w.watcher.alarm();
    // 5 + 5 + 1 + 1, then round to the start: 5 + 5 + 5 = 27, the next would pass 30.
    expect(checkPayments.mock.calls.map((c) => c[1])).toEqual([7, 8, 9, 10, 1, 2, 3].map(id));
  });

  it("a shard takes up to SHARD_TARGET_MAX_MAILBOXES, then refuses new ones", async () => {
    expect(SHARD_TARGET_MAX_MAILBOXES).toBe(200);
    const subscribe = (w: ReturnType<typeof makeWatcher>, n: number) =>
      w.watcher.fetch(
        new Request("https://mailbox-watcher.internal/subscribe", {
          method: "POST",
          body: JSON.stringify({ mailboxId: id(n), mailboxAuthorization: authFor(id(7), NOW_S() + 3600), subscription: record().subscription }),
        }),
      );
    const full = makeWatcher(Array.from({ length: 200 }, (_, i) => i + 1));
    expect((await subscribe(full, 201)).status).toBe(429);
    expect((await subscribe(full, 5)).status).toBe(204); // a renewal is never refused
    const almost = makeWatcher(Array.from({ length: 199 }, (_, i) => i + 1));
    expect((await subscribe(almost, 200)).status).toBe(204);
  });

  it("schedules the tick even when the id list cannot be read afterwards", async () => {
    const w = makeWatcher([1]);
    let reads = 0;
    const realGet = (w.watcher as never as { state: { storage: { get: (k: string) => Promise<unknown> } } }).state.storage.get;
    (w.watcher as never as { state: { storage: { get: (k: string) => Promise<unknown> } } }).state.storage.get = async (k: string) => {
      if (k === "ids" && ++reads > 1) throw new Error("ids unreadable");
      return realGet(k);
    };
    await expect(w.watcher.alarm()).resolves.toBeUndefined();
    expect(w.alarmAt()).not.toBeNull();
  });

  it("stops rescheduling once the last mailbox is gone", async () => {
    const w = makeWatcher([1]);
    // subscription expired: lastSeenAt far in the past -> the shard removes it
    w.data.set(`record:${id(1)}`, { ...record(), lastSeenAt: NOW_S() - 41 * 86400 });
    await w.watcher.alarm();
    expect(checkPayments).not.toHaveBeenCalled();
    expect(w.alarmAt()).toBeNull();
  });

  it("looks up the tip height and the price once per alarm, not once per mailbox", async () => {
    // what checkVtxoExpiry does for every mailbox that watches a VTXO height
    checkExpiry.mockImplementation(async (...a: unknown[]) => {
      await (a[3] as () => Promise<unknown>)();
      await (a[4] as () => Promise<unknown>)();
    });
    const w = makeWatcher(Array.from({ length: 30 }, (_, i) => i + 1));
    await w.watcher.alarm();
    expect(checkExpiry).toHaveBeenCalledTimes(30);
    expect(tipFetch).toHaveBeenCalledTimes(1);
    expect(priceFetch).toHaveBeenCalledTimes(1);
  });

  it("a fresh alarm looks them up again", async () => {
    checkExpiry.mockImplementation(async (...a: unknown[]) => void (await (a[3] as () => Promise<unknown>)()));
    const w = makeWatcher([1, 2]);
    await w.watcher.alarm();
    await w.watcher.alarm();
    expect(tipFetch).toHaveBeenCalledTimes(2);
  });
});

describe("MailboxWatcher pokes from the push relay", () => {
  const poke = (w: ReturnType<typeof makeWatcher>, ids: string[]) =>
    w.watcher.fetch(new Request("https://mailbox-watcher.internal/poke", { method: "POST", body: JSON.stringify({ ids }) }));

  it("checks at most one invocation's budget itself and leaves the rest to an alarm a second later", async () => {
    const w = makeWatcher(Array.from({ length: 60 }, (_, i) => i + 1));
    const before = Date.now();
    await poke(w, Array.from({ length: 45 }, (_, i) => id(i + 1)));
    expect(checkPayments).toHaveBeenCalledTimes(CHECKS_PER_INVOCATION);
    expect(w.alarmAt()! - before).toBeLessThan(5_000);

    checkPayments.mockClear();
    await w.watcher.alarm();
    // The 15 left over first, then the sweep fills the rest of the budget.
    const checked = checkPayments.mock.calls.map((c) => c[1] as string);
    expect(checked.slice(0, 15)).toEqual(Array.from({ length: 15 }, (_, i) => id(i + 31)));
    expect(checked).toHaveLength(CHECKS_PER_INVOCATION);
    expect(w.data.has("pokeQueue")).toBe(false);
    expect(w.alarmAt()! - Date.now()).toBeGreaterThan(14 * 60_000);
  });

  it("counts history reads in a poke too, and queues what does not fit", async () => {
    const w = makeWatcher(Array.from({ length: 10 }, (_, i) => i + 1));
    for (let m = 1; m <= 10; m++) w.data.set(`record:${id(m)}`, { ...record(), checkpoint: "0" });
    await poke(w, Array.from({ length: 10 }, (_, i) => id(i + 1)));
    expect(checkPayments).toHaveBeenCalledTimes(6);
    expect(w.data.get("pokeQueue")).toEqual([7, 8, 9, 10].map(id));
  });

  it("checks only the mailboxes this shard carries, and no expiry nudge", async () => {
    const w = makeWatcher([1, 2]);
    const res = await poke(w, [id(1), id(9)]);
    expect(res.status).toBe(204);
    expect(checkPayments).toHaveBeenCalledTimes(1);
    expect(checkPayments.mock.calls[0][1]).toBe(id(1));
    expect(checkExpiry).not.toHaveBeenCalled();
  });

  it("skips a mailbox whose authorization has expired", async () => {
    const w = makeWatcher([1]);
    w.data.set(`record:${id(1)}`, { ...record(), authExpiresAt: NOW_S() - 1 });
    await poke(w, [id(1)]);
    expect(checkPayments).not.toHaveBeenCalled();
  });

  it("never runs two payment checks of one mailbox at once, and the second starts from the first one's checkpoint", async () => {
    const w = makeWatcher([1]);
    let running = 0;
    let maxRunning = 0;
    const seen: string[] = [];
    checkPayments.mockImplementation(async (...a: unknown[]) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      const rec = a[2] as { checkpoint: string };
      seen.push(rec.checkpoint);
      await new Promise((r) => setTimeout(r, 20));
      await (a[3] as { put: (r: unknown) => Promise<void> }).put({ ...rec, checkpoint: String(Number(rec.checkpoint) + 1) });
      running--;
      return false;
    });
    await Promise.all([poke(w, [id(1)]), w.watcher.alarm(), poke(w, [id(1)])]);
    expect(maxRunning).toBe(1);
    expect(seen).toEqual(["5", "6", "7"]);
  });

  it("drops the mailbox from the shard when the check deleted its subscription", async () => {
    const w = makeWatcher([1, 2]);
    checkPayments.mockImplementation(async (...a: unknown[]) => a[1] === id(1));
    await poke(w, [id(1)]);
    expect(w.data.get("ids")).toEqual([id(2)]);
  });

  it("refuses a body without an id list", async () => {
    const w = makeWatcher([1]);
    const res = await w.watcher.fetch(new Request("https://mailbox-watcher.internal/poke", { method: "POST", body: "{}" }));
    expect(res.status).toBe(400);
  });
});

const le64 = (n: number) => {
  let hex = "";
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) {
    hex += Number(v & 0xffn).toString(16).padStart(2, "0");
    v >>= 8n;
  }
  return hex;
};
const authFor = (mailboxId: string, expiry: number) => mailboxId + le64(expiry) + "cd".repeat(64);

describe("MailboxWatcher subscribe and the push relay", () => {
  const RELAY_ENV = {
    PUSH_RELAY_URL: "https://relay.example",
    PUSH_RELAY_TOKEN: "t",
    PUSH_RELAY_HOOK_SECRET: "s",
    CF_ACCESS_CLIENT_ID: "i",
    CF_ACCESS_CLIENT_SECRET: "c",
  };
  const MAILBOX = "02" + "ab".repeat(32);
  const subscribe = (w: ReturnType<typeof makeWatcher>) =>
    w.watcher.fetch(
      new Request("https://mailbox-watcher.internal/subscribe", {
        method: "POST",
        body: JSON.stringify({
          mailboxId: MAILBOX,
          mailboxAuthorization: authFor(MAILBOX, NOW_S() + 3600),
          subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: "p", auth: "a" } },
          shard: "shard-0",
        }),
      }),
    );

  it("answers 202 when the configured relay did not take the registration, so the app sends it again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    const w = makeWatcher([], RELAY_ENV);
    expect((await subscribe(w)).status).toBe(202);
    // Stored all the same: the sweep watches it meanwhile.
    expect(w.data.get("ids")).toEqual([MAILBOX]);
    vi.unstubAllGlobals();
  });

  it("answers 204 once the relay took it, and without a relay at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    expect((await subscribe(makeWatcher([], RELAY_ENV))).status).toBe(204);
    vi.unstubAllGlobals();
    expect((await subscribe(makeWatcher([]))).status).toBe(204);
  });
});

describe("MailboxWatcher subscribe: how long a mailbox is watched", () => {
  const subscribe = (w: ReturnType<typeof makeWatcher>, mailboxAuthorization: string) =>
    w.watcher.fetch(
      new Request("https://mailbox-watcher.internal/subscribe", {
        method: "POST",
        body: JSON.stringify({
          mailboxId: id(7),
          mailboxAuthorization,
          subscription: { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "p", auth: "a" } },
        }),
      }),
    );

  beforeEach(() => verifyAuth.mockClear());

  it("until the authorization's own expiry", async () => {
    const w = makeWatcher([]);
    const expiry = NOW_S() + 30 * 24 * 60 * 60;
    const res = await subscribe(w, authFor(id(7), expiry));
    expect(res.status).toBeLessThan(300);
    expect((w.data.get(`record:${id(7)}`) as { authExpiresAt: number }).authExpiresAt).toBe(expiry);
  });

  it("refuses one longer than the app ever signs, without asking the Ark server", async () => {
    const w = makeWatcher([]);
    const res = await subscribe(w, authFor(id(7), NOW_S() + 31 * 24 * 60 * 60));
    expect(res.status).toBe(403);
    expect(verifyAuth).not.toHaveBeenCalled();
    expect(w.data.get(`record:${id(7)}`)).toBeUndefined();
  });

  it("refuses an expired one", async () => {
    const w = makeWatcher([]);
    expect((await subscribe(w, authFor(id(7), NOW_S() - 1))).status).toBe(403);
  });
});
