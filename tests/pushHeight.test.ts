// External audit 2026-09-27, N1: the exit's wake-up height must reach the
// Worker while the Ark server is down, without letting anyone move a
// stranger's watch.
import { describe, expect, it } from "vitest";
import { applyHeightUpdate, hashHeightToken } from "../worker/pushHeight";
import type { PushSubscriptionRecord } from "../worker/index";

function record(extra: Partial<PushSubscriptionRecord> = {}): PushSubscriptionRecord {
  return {
    mailboxAuthorization: "aa",
    authExpiresAt: 0,
    subscription: { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "p", auth: "a" } },
    checkpoint: "0",
    lastSeenAt: 1,
    firstExpiringVtxoBlockheight: 900_000,
    expiryNotifiedForHeight: 900_000,
    expiryUrgentNotifiedForHeight: 900_000,
    ...extra,
  };
}

describe("applyHeightUpdate", () => {
  it("moves the watch with the right token and resets its nudges", async () => {
    const hash = await hashHeightToken("a".repeat(64));
    const next = applyHeightUpdate(record({ heightTokenHash: hash }), hash, 900_150, 50);
    expect(next?.firstExpiringVtxoBlockheight).toBe(900_150);
    expect(next?.expiryNotifiedForHeight).toBeUndefined();
    expect(next?.expiryUrgentNotifiedForHeight).toBeUndefined();
    expect(next?.lastSeenAt).toBe(50);
    expect(next?.subscription).toEqual(record().subscription);
  });

  it("keeps the nudge markers when the height didn't change", async () => {
    const hash = await hashHeightToken("a".repeat(64));
    const next = applyHeightUpdate(record({ heightTokenHash: hash }), hash, 900_000, 50);
    expect(next?.expiryNotifiedForHeight).toBe(900_000);
  });

  it("refuses a wrong token and a record that never got one", async () => {
    const hash = await hashHeightToken("a".repeat(64));
    const other = await hashHeightToken("b".repeat(64));
    expect(applyHeightUpdate(record({ heightTokenHash: hash }), other, 1, 50)).toBeNull();
    expect(applyHeightUpdate(record(), hash, 1, 50)).toBeNull();
  });

  it("clears the watch on null", async () => {
    const hash = await hashHeightToken("a".repeat(64));
    expect(applyHeightUpdate(record({ heightTokenHash: hash }), hash, null, 50)?.firstExpiringVtxoBlockheight).toBeUndefined();
  });
});
