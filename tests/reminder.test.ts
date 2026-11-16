// Payment reminders by push (worker/reminder.ts, MailboxWatcher /remind and the
// alarm's send step): the shard keeps an opaque blob and a time, forwards the
// blob when due, and never spends more than its per-alarm share.
import { beforeEach, describe, expect, it, vi } from "vitest";

const checkPayments = vi.fn(async (..._a: unknown[]) => false);
const verifyAuth = vi.fn(async (..._a: unknown[]) => true);
const sendReminder = vi.fn(async (..._a: unknown[]) => ({ ok: true, status: 201, shouldDeleteSubscription: false }));
vi.mock("../worker/mailboxShared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../worker/mailboxShared")>()),
  checkMailboxForPayments: (...a: unknown[]) => checkPayments(...a),
  checkVtxoExpiry: async () => {},
  fetchTipHeightCached: async () => 900000,
  fetchCurrentBtcPriceUsd: async () => 100000,
  sendReminderPush: (...a: unknown[]) => sendReminder(...a),
  verifyMailboxAuthorization: (...a: unknown[]) => verifyAuth(...a),
  pushAuthExpiry: () => Math.floor(Date.now() / 1000) + 3600,
}));

const { MailboxWatcher, CHECKS_PER_INVOCATION } = await import("../worker/mailboxWatcher");
const { applyReminder, dueReminders, isRemindAt, isStaleReminder, REMINDERS_PER_ALARM, REMIND_STALE_SECONDS, REMINDER_RETRY_SECONDS } = await import("../worker/reminder");

const NOW_S = () => Math.floor(Date.now() / 1000);
const id = (n: number) => String(n).padStart(2, "0").repeat(33);
const BLOB = "A".repeat(379);
const TOKEN = "t".repeat(64);

function record(over: Record<string, unknown> = {}) {
  return {
    mailboxAuthorization: "aa",
    authExpiresAt: NOW_S() + 3600,
    subscription: { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "p", auth: "a" } },
    checkpoint: "5",
    lastSeenAt: NOW_S(),
    heightTokenHash: TOKEN,
    ...over,
  };
}

function makeWatcher(mailboxes: number[]) {
  const data = new Map<string, unknown>();
  data.set("ids", mailboxes.map(id));
  for (const m of mailboxes) data.set(`record:${id(m)}`, record());
  let alarm: number | null = null;
  const storage = {
    async get(key: string) {
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
  const watcher = new MailboxWatcher({ id: { toString: () => "shard-0" }, storage } as never, {} as never);
  const remind = (body: Record<string, unknown>) =>
    watcher.fetch(new Request("https://mailbox-watcher.internal/remind", { method: "POST", body: JSON.stringify(body) }));
  return { watcher, data, remind, alarmAt: () => alarm };
}

beforeEach(() => {
  verifyAuth.mockReset().mockResolvedValue(true);
  checkPayments.mockReset().mockResolvedValue(false);
  sendReminder.mockReset().mockResolvedValue({ ok: true, status: 201, shouldDeleteSubscription: false });
});

describe("reminder helpers", () => {
  it("accepts a time from a little in the past to the record's lifetime, whole seconds only", () => {
    const now = 1_000_000;
    expect(isRemindAt(now + 60, now)).toBe(true);
    expect(isRemindAt(now - 60, now)).toBe(true);
    expect(isRemindAt(now - REMIND_STALE_SECONDS - 1, now)).toBe(false);
    expect(isRemindAt(now + 41 * 86400, now)).toBe(false);
    expect(isRemindAt(now + 60.5, now)).toBe(false);
    expect(isRemindAt("1000", now)).toBe(false);
  });

  it("applyReminder needs the record's own token and keeps everything else", () => {
    const r = record();
    expect(applyReminder(r as never, "x".repeat(64), 5, BLOB)).toBeNull();
    expect(applyReminder({ ...r, heightTokenHash: undefined } as never, TOKEN, 5, BLOB)).toBeNull();
    const set = applyReminder(r as never, TOKEN, 5, BLOB)!;
    expect(set).toMatchObject({ remindAt: 5, remindBlob: BLOB, checkpoint: "5", lastSeenAt: r.lastSeenAt });
    const cleared = applyReminder(set, TOKEN, null, null)!;
    expect(cleared.remindAt).toBeUndefined();
    expect(cleared.remindBlob).toBeUndefined();
  });

  it("dueReminders is soonest first and capped", () => {
    expect(dueReminders({ a: 30, b: 10, c: 20, d: 99 }, 50, 2)).toEqual(["b", "c"]);
    expect(isStaleReminder(100, 100 + REMIND_STALE_SECONDS + 1)).toBe(true);
    expect(isStaleReminder(100, 100 + 60)).toBe(false);
  });
});

describe("MailboxWatcher reminders", () => {
  it("stores a reminder and an index entry, then clears both", async () => {
    const { remind, data } = makeWatcher([1]);
    const at = NOW_S() + 3600;
    expect((await remind({ mailboxId: id(1), heightTokenHash: TOKEN, remindAt: at, blob: BLOB })).status).toBe(204);
    expect(data.get(`record:${id(1)}`)).toMatchObject({ remindAt: at, remindBlob: BLOB, checkpoint: "5" });
    expect(data.get("reminders")).toEqual({ [id(1)]: at });

    expect((await remind({ mailboxId: id(1), heightTokenHash: TOKEN, remindAt: null, blob: null })).status).toBe(204);
    expect((data.get(`record:${id(1)}`) as { remindAt?: number }).remindAt).toBeUndefined();
    expect(data.has("reminders")).toBe(false);
  });

  it("refuses a wrong token, an unknown mailbox and a malformed blob", async () => {
    const { remind, data } = makeWatcher([1]);
    const at = NOW_S() + 3600;
    expect((await remind({ mailboxId: id(1), heightTokenHash: "x".repeat(64), remindAt: at, blob: BLOB })).status).toBe(403);
    expect((await remind({ mailboxId: id(2), heightTokenHash: TOKEN, remindAt: at, blob: BLOB })).status).toBe(404);
    expect((await remind({ mailboxId: id(1), heightTokenHash: TOKEN, remindAt: at, blob: "not a blob!" })).status).toBe(400);
    expect(data.has("reminders")).toBe(false);
  });

  it("forwards the blob when due, once, then forgets it", async () => {
    const { remind, watcher, data } = makeWatcher([1, 2]);
    await remind({ mailboxId: id(1), heightTokenHash: TOKEN, remindAt: NOW_S() - 5, blob: BLOB });
    await remind({ mailboxId: id(2), heightTokenHash: TOKEN, remindAt: NOW_S() + 3600, blob: BLOB });
    await watcher.alarm();
    expect(sendReminder).toHaveBeenCalledTimes(1);
    expect(sendReminder.mock.calls[0][2]).toBe(BLOB);
    expect((data.get(`record:${id(1)}`) as { remindAt?: number }).remindAt).toBeUndefined();
    expect(data.get("reminders")).toEqual({ [id(2)]: expect.any(Number) });
    await watcher.alarm();
    expect(sendReminder).toHaveBeenCalledTimes(1);
  });

  it("sends at most REMINDERS_PER_ALARM and gives those reads up from the sweep", async () => {
    const boxes = Array.from({ length: 12 }, (_, i) => i + 1);
    const { remind, watcher } = makeWatcher(boxes);
    for (const b of boxes) await remind({ mailboxId: id(b), heightTokenHash: TOKEN, remindAt: NOW_S() - 5, blob: BLOB });
    await watcher.alarm();
    expect(sendReminder).toHaveBeenCalledTimes(REMINDERS_PER_ALARM);
    expect(checkPayments.mock.calls.length).toBeLessThanOrEqual(CHECKS_PER_INVOCATION - REMINDERS_PER_ALARM);
    await watcher.alarm();
    expect(sendReminder).toHaveBeenCalledTimes(12);
  });

  it("keeps a reminder whose push failed, and drops one that went stale", async () => {
    const { remind, watcher, data } = makeWatcher([1, 2]);
    await remind({ mailboxId: id(1), heightTokenHash: TOKEN, remindAt: NOW_S() - 5, blob: BLOB });
    sendReminder.mockResolvedValueOnce({ ok: false, status: 503, shouldDeleteSubscription: false });
    await watcher.alarm();
    expect((data.get(`record:${id(1)}`) as { remindAt?: number }).remindAt).toBeDefined();
    expect(data.get("reminders")).toBeDefined();

    // The failed one waits its retry time, then goes again.
    expect(data.get("reminders")).toEqual({ [id(1)]: expect.any(Number) });
    data.set("reminders", { [id(1)]: NOW_S() - 1 });

    // Stale: written straight in, as the app can no longer ask for a past time that far back.
    const old = NOW_S() - REMIND_STALE_SECONDS - 100;
    data.set(`record:${id(2)}`, record({ remindAt: old, remindBlob: BLOB }));
    data.set("reminders", { ...(data.get("reminders") as Record<string, number>), [id(2)]: old });
    sendReminder.mockClear();
    await watcher.alarm();
    // The failed one is retried, the stale one is not sent.
    expect(sendReminder).toHaveBeenCalledTimes(1);
    expect((data.get(`record:${id(1)}`) as { remindAt?: number }).remindAt).toBeUndefined();
    expect((data.get(`record:${id(2)}`) as { remindAt?: number }).remindAt).toBeUndefined();
  });

  it("a failing reminder waits out its retry time instead of taking every slot", async () => {
    const boxes = Array.from({ length: 10 }, (_, i) => i + 1);
    const { remind, watcher, data } = makeWatcher(boxes);
    for (const b of boxes) await remind({ mailboxId: id(b), heightTokenHash: TOKEN, remindAt: NOW_S() - 100 + b, blob: BLOB });
    // The eight earliest keep failing; the last two are healthy.
    sendReminder.mockImplementation(async (...a: unknown[]) => {
      const bad = [1, 2, 3, 4, 5, 6, 7, 8].some((b) => (a[1] as { endpoint: string }).endpoint.endsWith(`/${b}`));
      return { ok: !bad, status: bad ? 503 : 201, shouldDeleteSubscription: false };
    });
    for (const b of boxes) {
      const r = data.get(`record:${id(b)}`) as { subscription: { endpoint: string } };
      r.subscription.endpoint = `https://fcm.googleapis.com/${b}`;
    }
    await watcher.alarm();
    const index = data.get("reminders") as Record<string, number>;
    expect(index[id(1)]).toBeGreaterThanOrEqual(NOW_S() + REMINDER_RETRY_SECONDS - 5);
    sendReminder.mockClear();
    await watcher.alarm();
    // Only the two healthy ones are left due; the failing eight are not tried again yet.
    expect(sendReminder.mock.calls.filter((c) => (c[1] as { endpoint: string }).endpoint.match(/\/[1-8]$/)).length).toBe(0);
    expect(data.get("reminders")).toEqual(expect.objectContaining({ [id(1)]: expect.any(Number) }));
  });

  it("does not send a reminder that was moved to later while it waited", async () => {
    const { remind, watcher, data } = makeWatcher([1]);
    await remind({ mailboxId: id(1), heightTokenHash: TOKEN, remindAt: NOW_S() + 3600, blob: BLOB });
    // The index still says due (the move landed after the alarm picked it).
    data.set("reminders", { [id(1)]: NOW_S() - 5 });
    await watcher.alarm();
    expect(sendReminder).not.toHaveBeenCalled();
    expect((data.get(`record:${id(1)}`) as { remindAt?: number }).remindAt).toBeDefined();
    expect((data.get("reminders") as Record<string, number>)[id(1)]).toBeGreaterThan(NOW_S());
  });

  it("a renewing subscribe keeps a reminder set while it verified", async () => {
    const { watcher, remind, data } = makeWatcher([1]);
    const at = NOW_S() + 3600;
    // The reminder lands while the subscribe waits for the Ark server.
    let release: (v: boolean) => void = () => {};
    verifyAuth.mockImplementationOnce(() => new Promise<boolean>((r) => (release = r)));
    const sub = watcher.fetch(
      new Request("https://mailbox-watcher.internal/subscribe", {
        method: "POST",
        body: JSON.stringify({
          mailboxId: id(1),
          mailboxAuthorization: "aa",
          subscription: { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "p", auth: "a" } },
        }),
      }),
    );
    await remind({ mailboxId: id(1), heightTokenHash: TOKEN, remindAt: at, blob: BLOB });
    release(true);
    await sub;
    expect(data.get(`record:${id(1)}`)).toMatchObject({ remindAt: at, remindBlob: BLOB });
    expect(data.get("reminders")).toEqual({ [id(1)]: at });
  });

  it("removes a subscription the push service says is gone", async () => {
    const { remind, watcher, data } = makeWatcher([1]);
    await remind({ mailboxId: id(1), heightTokenHash: TOKEN, remindAt: NOW_S() - 5, blob: BLOB });
    sendReminder.mockResolvedValueOnce({ ok: false, status: 410, shouldDeleteSubscription: true });
    await watcher.alarm();
    expect(data.has(`record:${id(1)}`)).toBe(false);
    expect(data.has("reminders")).toBe(false);
    expect(data.get("ids")).toEqual([]);
  });
});
