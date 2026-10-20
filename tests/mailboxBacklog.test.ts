// A mailbox's first read (its whole history) is spread over ticks with a page
// cap, never notifies for history, and survives a renewal in the middle.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PushSubscriptionRecord, RecordStore } from "../worker/index";

// A fake Ark mailbox: `head` items at checkpoints 10, 20, ..., PAGE items a page.
const PAGE = 3;
let head = 0n;
async function serve(_server: string, _id: string, _auth: string, cursor: bigint) {
  const items: bigint[] = [];
  for (let c = cursor + 10n; c <= head && items.length < PAGE; c += 10n) items.push(c);
  const next = items.length ? items[items.length - 1] : cursor;
  return {
    events: items.map(() => ({ kind: "arkoor" as const, amountSat: 1000 })),
    nextCheckpoint: next,
    haveMore: next < head,
  };
}
const readMailbox = vi.fn(serve as (...a: Parameters<typeof serve>) => Promise<ReturnType<typeof serve> extends Promise<infer R> ? R | null : never>);
vi.mock("../worker/mailbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../worker/mailbox")>()),
  readMailbox: (...a: Parameters<typeof readMailbox>) => readMailbox(...a),
}));
const sendWebPush = vi.fn(async (..._a: unknown[]) => ({ ok: true, status: 201, shouldDeleteSubscription: false }));
vi.mock("../worker/webPush", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../worker/webPush")>()),
  sendWebPush: (...a: unknown[]) => sendWebPush(...a),
}));
vi.mock("../worker/mailboxShared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../worker/mailboxShared")>()),
  verifyMailboxAuthorization: async () => true,
}));

const { checkMailboxForPayments, MAX_BACKLOG_PAGES_PER_TICK } = await import("../worker/mailboxShared");
const { MailboxWatcher } = await import("../worker/mailboxWatcher");

const MAILBOX = "02" + "ab".repeat(32);
const env = { VAPID_PRIVATE_KEY: "k" } as never;

function fresh(): PushSubscriptionRecord {
  return {
    mailboxAuthorization: "aa",
    authExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    subscription: { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "p", auth: "a" } },
    checkpoint: "0",
    lastSeenAt: Math.floor(Date.now() / 1000),
  };
}
function storeFor(box: { record: PushSubscriptionRecord }): RecordStore {
  return {
    get: async () => box.record,
    put: async (r) => {
      box.record = r;
    },
    delete: async () => {},
  };
}
async function tick(box: { record: PushSubscriptionRecord }) {
  readMailbox.mockClear();
  await checkMailboxForPayments(env, MAILBOX, box.record, storeFor(box));
  return readMailbox.mock.calls.length;
}

beforeEach(() => {
  readMailbox.mockReset().mockImplementation(serve);
  sendWebPush.mockClear();
  head = 0n;
});

describe("first read of a mailbox with a long history", () => {
  it("takes at most MAX_BACKLOG_PAGES_PER_TICK pages per tick and never pushes for history", async () => {
    head = 10n * 100n; // 100 items = 34 pages
    const box = { record: fresh() };
    let ticks = 0;
    while (box.record.checkpoint === "0" || box.record.backfilling) {
      const reads = await tick(box);
      expect(reads).toBeLessThanOrEqual(MAX_BACKLOG_PAGES_PER_TICK);
      expect(++ticks).toBeLessThan(50);
    }
    expect(box.record.checkpoint).toBe(head.toString());
    expect(box.record.backfilling).toBeUndefined();
    expect(sendWebPush).not.toHaveBeenCalled();
    expect(ticks).toBe(Math.ceil(34 / MAX_BACKLOG_PAGES_PER_TICK));
  });

  it("marks the record as backfilling while unfinished and keeps progress between ticks", async () => {
    head = 10n * 100n;
    const box = { record: fresh() };
    await tick(box);
    expect(box.record.backfilling).toBe(true);
    expect(BigInt(box.record.checkpoint)).toBe(BigInt(MAX_BACKLOG_PAGES_PER_TICK * PAGE) * 10n);
    const before = box.record.checkpoint;
    await tick(box);
    expect(BigInt(box.record.checkpoint)).toBeGreaterThan(BigInt(before));
  });

  it("a payment that arrives after the history is drained is pushed exactly once", async () => {
    head = 10n * 20n;
    const box = { record: fresh() };
    while (box.record.checkpoint === "0" || box.record.backfilling) await tick(box);
    expect(sendWebPush).not.toHaveBeenCalled();
    head += 10n; // one new payment
    await tick(box);
    expect(sendWebPush).toHaveBeenCalledTimes(1);
    // High urgency, or Android in Doze holds it until the phone wakes.
    expect(sendWebPush.mock.calls[0][5]).toEqual({ urgency: "high" });
    await tick(box);
    expect(sendWebPush).toHaveBeenCalledTimes(1);
  });

  it("history that grows while it is being read is still not pushed", async () => {
    head = 10n * 40n;
    const box = { record: fresh() };
    await tick(box);
    head += 10n * 10n; // payments arrive mid-backfill: they are part of the backlog now
    while (box.record.checkpoint === "0" || box.record.backfilling) await tick(box);
    expect(sendWebPush).not.toHaveBeenCalled();
  });

  it("an empty mailbox stays at checkpoint 0 and costs one read a tick", async () => {
    head = 0n;
    const box = { record: fresh() };
    expect(await tick(box)).toBe(1);
    expect(box.record.checkpoint).toBe("0");
    expect(box.record.backfilling).toBeUndefined();
  });

  it("a page that fails mid-tick keeps the progress of the pages before it", async () => {
    head = 10n * 100n;
    const box = { record: fresh() };
    let calls = 0;
    readMailbox.mockImplementation(async (...a) => (++calls === 3 ? null : serve(...a)));
    await tick(box);
    expect(calls).toBe(3);
    expect(BigInt(box.record.checkpoint)).toBe(BigInt(2 * PAGE) * 10n);
    expect(box.record.backfilling).toBe(true);
    expect(sendWebPush).not.toHaveBeenCalled();
  });

  it("a first page that fails commits nothing", async () => {
    head = 10n * 100n;
    const box = { record: fresh() };
    readMailbox.mockImplementation(async () => null);
    await tick(box);
    expect(box.record.checkpoint).toBe("0");
    expect(box.record.backfilling).toBeUndefined();
  });

  it("a renewal in the middle of the backfill keeps the flag, or the rest would be pushed as new", async () => {
    head = 10n * 100n;
    const box = { record: fresh() };
    await tick(box);
    expect(box.record.backfilling).toBe(true);
    const store = new Map<string, unknown>([["ids", [MAILBOX]], [`record:${MAILBOX}`, box.record]]);
    const storage = {
      get: async (k: string) => store.get(k),
      put: async (k: string, v: unknown) => void store.set(k, v),
      delete: async (k: string) => store.delete(k),
      setAlarm: async () => {},
      getAlarm: async () => 1,
      deleteAlarm: async () => {},
    };
    const watcher = new MailboxWatcher({ id: { toString: () => "s" }, storage } as never, env);
    const res = await watcher.fetch(
      new Request("https://x/subscribe", {
        method: "POST",
        body: JSON.stringify({
          mailboxId: MAILBOX,
          // mailbox key, an expiry an hour out (le64), a signature
          mailboxAuthorization:
            MAILBOX +
            Buffer.from(new BigUint64Array([BigInt(Math.floor(Date.now() / 1000) + 3600)]).buffer).toString("hex") +
            "cd".repeat(64),
          subscription: box.record.subscription,
        }),
      }),
    );
    expect(res.status).toBe(204);
    const renewed = store.get(`record:${MAILBOX}`) as PushSubscriptionRecord;
    expect(renewed.backfilling).toBe(true);
    expect(renewed.checkpoint).toBe(box.record.checkpoint);
    // and the read carries on without sending anything
    box.record = renewed;
    while (box.record.backfilling) await tick(box);
    expect(sendWebPush).not.toHaveBeenCalled();
  });
});
