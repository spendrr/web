import { describe, expect, it } from "vitest";
import type { ExitVtxo } from "@secondts/bark";
import { EXIT_WAKE_AFTER_BLOCKS, buildExitOverview, exitWakeHeight } from "../src/lib/exit/exitModel";
import { exitNotificationHint, exitPushWatchHeight } from "../src/lib/exit/exitNudge";

const ex = (id: string, state: ExitVtxo["state"]): ExitVtxo => ({ vtxoId: id, amountSats: 10_000, state, isClaimable: state.type === "claimable" });
const block = (height: number) => ({ height, hash: `h${height}` });
const id = (s: string) => s;

describe("exit push wake-up", () => {
  it("wakes a broadcasting exit soon, rounded so an open app re-reports at most hourly", () => {
    const o = buildExitOverview([ex("a", { type: "start", tipHeight: 1001 })], [], [], 0);
    const wake = exitWakeHeight(o)!;
    expect(wake % EXIT_WAKE_AFTER_BLOCKS).toBe(0);
    expect(wake).toBeGreaterThanOrEqual(1001 + EXIT_WAKE_AFTER_BLOCKS);
    expect(wake).toBeLessThan(1001 + 2 * EXIT_WAKE_AFTER_BLOCKS);
    // Same bucket for the next few blocks.
    expect(exitWakeHeight(buildExitOverview([ex("a", { type: "start", tipHeight: 1002 })], [], [], 0))).toBe(wake);
  });

  it("wakes a timelocked exit when the first coin becomes claimable", () => {
    const o = buildExitOverview(
      [ex("a", { type: "awaiting-delta", tipHeight: 2000, confirmedBlock: block(1990), claimableHeight: 2100 })],
      [],
      [],
      0,
    );
    expect(exitWakeHeight(o)).toBe(2100);
    // Reported 240 blocks later so the Worker's first nudge lands at 2100.
    expect(exitPushWatchHeight(o)).toBe(2100 + 240);
  });

  it("uses the coin's expiry when that comes first", () => {
    const o = buildExitOverview([ex("a", { type: "start", tipHeight: 3000 })], [], [], 0, new Map([["a", 3050]]));
    expect(exitPushWatchHeight(o)).toBe(3050);
  });

  it("needs nothing while only claims confirm, or without an exit", () => {
    const claiming = buildExitOverview(
      [ex("a", { type: "claim-in-progress", tipHeight: 4000, claimableSince: block(3990), claimTxid: "c" })],
      [],
      [],
      0,
    );
    expect(exitPushWatchHeight(claiming)).toBeNull();
    expect(exitNotificationHint(claiming, false, id, 0)).toBeNull();
    expect(exitPushWatchHeight(buildExitOverview([], [], [], 0))).toBeNull();
  });

  it("words the local notification by what the exit waits for", () => {
    const o = buildExitOverview([ex("a", { type: "start", tipHeight: 1000 })], [], [], 0);
    expect(exitNotificationHint(o, true, id, 0)?.body).toContain("chybí on-chain");
    expect(exitNotificationHint(o, false, id, 0)?.body).toContain("další krok");
    const ready = buildExitOverview(
      [ex("a", { type: "claimable", tipHeight: 1000, claimableSince: block(990), lastScannedBlock: undefined })],
      ["a"],
      [],
      0,
    );
    expect(exitNotificationHint(ready, false, id, 0)?.body).toContain("vyzvednutí");
  });
});
