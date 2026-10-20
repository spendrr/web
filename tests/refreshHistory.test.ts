import { describe, expect, it } from "vitest";
import {
  hiddenFromHistory,
  highestMovementId,
  newestUnseenIncoming,
  type HistoryMovement,
} from "../src/lib/maintenance/refreshHistory";

const mv = (id: number, kind: string, effective: number, status = "successful"): HistoryMovement => ({
  id,
  subsystemKind: kind,
  status,
  effectiveBalanceSats: effective,
});

describe("hiddenFromHistory", () => {
  it("hides free and failed refreshes, keeps paid ones and everything else", () => {
    expect(hiddenFromHistory(mv(1, "refresh", 0, "pending"))).toBe(true);
    expect(hiddenFromHistory(mv(1, "refresh", 0))).toBe(true);
    expect(hiddenFromHistory(mv(1, "refresh", -40, "failed"))).toBe(true);
    expect(hiddenFromHistory(mv(1, "refresh", -40, "pending"))).toBe(false);
    expect(hiddenFromHistory(mv(1, "refresh", -40))).toBe(false);
    expect(hiddenFromHistory(mv(1, "receive", 0))).toBe(false);
    expect(hiddenFromHistory(mv(1, "send", -5, "failed"))).toBe(false);
  });
});

describe("newestUnseenIncoming", () => {
  it("a refresh on top doesn't hide the payment below it", () => {
    const h = [mv(12, "refresh", 0, "pending"), mv(11, "receive", 5000), mv(10, "send", -100)];
    expect(newestUnseenIncoming(h, 10)?.id).toBe(11);
  });

  it("an already seen payment is not announced again", () => {
    const h = [mv(12, "refresh", 0), mv(11, "receive", 5000)];
    expect(newestUnseenIncoming(h, 12)).toBeUndefined();
    expect(newestUnseenIncoming(h, 11)).toBeUndefined();
  });

  it("picks the newest by id regardless of order; null = nothing seen yet", () => {
    const h = [mv(3, "receive", 1), mv(9, "receive", 2), mv(5, "receive", 3)];
    expect(newestUnseenIncoming(h, null)?.id).toBe(9);
    expect(newestUnseenIncoming([], null)).toBeUndefined();
  });

  it("highestMovementId", () => {
    expect(highestMovementId([mv(3, "send", -1), mv(7, "refresh", 0)], null)).toBe(7);
    expect(highestMovementId([], 4)).toBe(4);
    expect(highestMovementId([], null)).toBeNull();
  });
});
