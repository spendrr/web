import { describe, expect, it } from "vitest";
import { deployWatchDue } from "../worker/index";

// The cron runs every minute; the deploy watch is dispatched on :00, :15, :30 and :45 UTC.
const at = (iso: string) => Date.parse(iso);

describe("deployWatchDue", () => {
  it("is due on each quarter hour", () => {
    expect(deployWatchDue(at("2026-11-09T10:00:00Z"))).toBe(true);
    expect(deployWatchDue(at("2026-11-09T10:15:00Z"))).toBe(true);
    expect(deployWatchDue(at("2026-11-09T10:30:00Z"))).toBe(true);
    expect(deployWatchDue(at("2026-11-09T10:45:00Z"))).toBe(true);
  });

  it("is not due on the other minutes", () => {
    expect(deployWatchDue(at("2026-11-09T10:01:00Z"))).toBe(false);
    expect(deployWatchDue(at("2026-11-09T10:14:00Z"))).toBe(false);
    expect(deployWatchDue(at("2026-11-09T10:59:00Z"))).toBe(false);
  });
});
