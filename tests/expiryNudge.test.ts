// Expiry nudge stages (worker/mailboxShared.ts checkVtxoExpiry).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POLICY } from "../src/lib/refreshEngine/plan";

const sendFcm = vi.fn(async (..._a: unknown[]) => ({ ok: true, status: 200, shouldDeleteSubscription: false }));
vi.mock("../worker/fcm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../worker/fcm")>()),
  sendFcm: (...a: unknown[]) => sendFcm(...a),
}));

const { checkVtxoExpiry, describeExpiryNudge, expiryPricePct, EXPIRY_NUDGE_THRESHOLD_BLOCKS, EXPIRY_REMINDER_THRESHOLD_BLOCKS, expiryStage } = await import(
  "../worker/mailboxShared"
);
type Rec = import("../worker/index").PushSubscriptionRecord;

const HEIGHT = 900_000;
function record(extra: Partial<Rec> = {}): Rec {
  return {
    mailboxAuthorization: "aa",
    authExpiresAt: 1,
    subscription: { endpoint: "fcm:" + "a".repeat(80), keys: { p256dh: "", auth: "" } },
    checkpoint: "5",
    lastSeenAt: 1,
    firstExpiringVtxoBlockheight: HEIGHT,
    ...extra,
  };
}
function makeStore(initial: Rec) {
  let cur: Rec | null = structuredClone(initial);
  return {
    store: {
      get: async () => (cur ? structuredClone(cur) : null),
      put: async (r: Rec) => void (cur = structuredClone(r)),
      delete: async () => void (cur = null),
    },
    peek: () => cur,
    set: (r: Rec | null) => (cur = r),
  };
}
const run = (s: ReturnType<typeof makeStore>, tip: number) =>
  checkVtxoExpiry({} as never, "m", record(), async () => tip, async () => undefined, s.store);

beforeEach(() => sendFcm.mockClear());

describe("expiry nudge thresholds", () => {
  it("first nudge sits 10 blocks under the refresh engine's due threshold", () => {
    expect(EXPIRY_NUDGE_THRESHOLD_BLOCKS).toBe(POLICY.DUE_BLOCKS - 10);
    expect(EXPIRY_REMINDER_THRESHOLD_BLOCKS).toBeLessThan(EXPIRY_NUDGE_THRESHOLD_BLOCKS);
  });

  it("maps blocks left to a stage", () => {
    expect(expiryStage(240)).toBe("first");
    expect(expiryStage(145)).toBe("first");
    expect(expiryStage(144)).toBe("reminder");
    expect(expiryStage(25)).toBe("reminder");
    expect(expiryStage(24)).toBe("urgent");
  });
});

describe("checkVtxoExpiry", () => {
  it("sends nothing above the first threshold or after expiry", async () => {
    const s = makeStore(record());
    await run(s, HEIGHT - 241);
    await run(s, HEIGHT);
    expect(sendFcm).not.toHaveBeenCalled();
  });

  it("sends first, reminder and urgent once each", async () => {
    const s = makeStore(record());
    for (const left of [240, 200, 144, 100, 24, 10]) await run(s, HEIGHT - left);
    expect(sendFcm).toHaveBeenCalledTimes(3);
  });

  it("a stage already past sends only the current one", async () => {
    const s = makeStore(record());
    await run(s, HEIGHT - 100);
    await run(s, HEIGHT - 90);
    expect(sendFcm).toHaveBeenCalledTimes(1);
    expect(s.peek()?.expiryNotifiedForHeight).toBe(HEIGHT);
    expect(s.peek()?.expiryReminderNotifiedForHeight).toBe(HEIGHT);
    expect(s.peek()?.expiryUrgentNotifiedForHeight).toBeUndefined();
  });

  it("a failed send is retried", async () => {
    const s = makeStore(record());
    sendFcm.mockResolvedValueOnce({ ok: false, status: 500, shouldDeleteSubscription: false });
    await run(s, HEIGHT - 200);
    await run(s, HEIGHT - 199);
    expect(sendFcm).toHaveBeenCalledTimes(2);
  });

  it("does not write back an older height when a subscribe lands during the send", async () => {
    const s = makeStore(record());
    sendFcm.mockImplementationOnce(async () => {
      s.set(record({ firstExpiringVtxoBlockheight: HEIGHT + 4000, checkpoint: "9" }));
      return { ok: true, status: 200, shouldDeleteSubscription: false };
    });
    await run(s, HEIGHT - 200);
    expect(s.peek()?.firstExpiringVtxoBlockheight).toBe(HEIGHT + 4000);
    expect(s.peek()?.checkpoint).toBe("9");
    expect(s.peek()?.expiryNotifiedForHeight).toBeUndefined();
  });

  it("uses the height stored now, not the one loaded before the tip lookup", async () => {
    const s = makeStore(record());
    await checkVtxoExpiry(
      {} as never,
      "m",
      record(),
      async () => {
        s.set(record({ firstExpiringVtxoBlockheight: HEIGHT + 4000 }));
        return HEIGHT - 100;
      },
      async () => undefined,
      s.store,
    );
    expect(sendFcm).not.toHaveBeenCalled();
  });
});

describe("describeExpiryNudge", () => {
  it("first stage names the price move, with the matching arrow", () => {
    expect(describeExpiryNudge("first", 100_000, 101_200)).toBe(
      "BTC mezitím vyrostl o 1,2 % 📈. Mince čekají na obnovu. Otevři Spendrr.",
    );
    expect(describeExpiryNudge("first", 100_000, 98_000)).toContain("spadl o 2,0 % 📉");
  });

  it("leaves the price out when it is missing or flat, and in the later stages", () => {
    const plain = "Mince čekají na obnovu. Otevři Spendrr.";
    expect(describeExpiryNudge("first", undefined, 100_000)).toBe(plain);
    expect(describeExpiryNudge("first", 100_000, 100_050)).toBe(plain);
    expect(describeExpiryNudge("reminder", 100_000, 120_000)).toBe("Obnova mincí pořád čeká. Otevři Spendrr.");
    expect(describeExpiryNudge("urgent", 100_000, 120_000)).toBe("Mince brzy vyprší. Otevři Spendrr hned.");
  });
});

describe("expiry push data", () => {
  it("carries the stage and, in the first stage, the price move", async () => {
    const s = makeStore(record({ lastKnownPriceUsd: 100_000 }));
    await checkVtxoExpiry({} as never, "m", record({ lastKnownPriceUsd: 100_000 }), async () => HEIGHT - 200, async () => 101_200, s.store);
    expect(sendFcm.mock.calls[0][2]).toMatchObject({ data: { stage: "first", pct: "1.2" } });
    sendFcm.mockClear();
    await checkVtxoExpiry({} as never, "m", record(), async () => HEIGHT - 100, async () => 101_200, s.store);
    expect(sendFcm.mock.calls[0][2]).toMatchObject({ data: { stage: "reminder" } });
    expect((sendFcm.mock.calls[0][2] as { data: object }).data).not.toHaveProperty("pct");
  });

  it("rounds the move and drops a flat one", () => {
    expect(expiryPricePct(100_000, 98_000)).toBe(-2);
    expect(expiryPricePct(100_000, 100_050)).toBeUndefined();
    expect(expiryPricePct(undefined, 100_000)).toBeUndefined();
  });
});
