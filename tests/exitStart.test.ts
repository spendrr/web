import { describe, expect, it } from "vitest";
import { EXIT_LOCK_HOLDER_ID, parseExitStartArgs, planExitStart, type ExitStartVtxo } from "../src/lib/exit/exitLocks";

const spendable = (id: string, amountSats = 10_000): ExitStartVtxo => ({ id, amountSats, state: { type: "spendable" } });
const locked = (id: string, holder: string, amountSats = 10_000): ExitStartVtxo => ({
  id,
  amountSats,
  state: { type: "locked", holder: { type: "action", id: holder } },
});

describe("planExitStart", () => {
  it("leaves out inputs of a pending round, locked or not", () => {
    const p = planExitStart(
      [spendable("free"), spendable("delegated"), locked("engine", "spendrr-refresh")],
      new Set(["delegated"]),
      false,
    );
    expect(p.ids).toEqual(["free"]);
    expect(p.inRoundIds.sort()).toEqual(["delegated", "engine"]);
    expect(p.inRoundSats).toBe(20_000);
  });

  it("takes them too when asked (server down)", () => {
    const p = planExitStart([spendable("free"), locked("engine", "spendrr-refresh")], new Set(), true);
    expect(p.ids.sort()).toEqual(["engine", "free"]);
    expect(p.inRoundSats).toBe(10_000);
  });

  it("skips dust, coins already in our exit, spent and duplicate rows", () => {
    const p = planExitStart(
      [
        spendable("dust", 329),
        locked("exiting", EXIT_LOCK_HOLDER_ID),
        { id: "gone", amountSats: 5_000, state: { type: "spent" } },
        spendable("a"),
        spendable("a"),
      ],
      new Set(),
      false,
    );
    expect(p.ids).toEqual(["a"]);
    expect(p.dustSats).toBe(329);
  });

  it("still holds back locked coins when the round inputs can't be read", () => {
    const p = planExitStart([spendable("free"), locked("engine", "spendrr-refresh")], null, false);
    expect(p.ids).toEqual(["free"]);
    expect(p.inRoundIds).toEqual(["engine"]);
  });
});

describe("parseExitStartArgs (external audit 2026-09-27, L2)", () => {
  it("accepts distinct id strings and a boolean flag", () => {
    expect(parseExitStartArgs([["a", "b", "a"], false])).toEqual({ ids: ["a", "b"], includeInRound: false });
  });
  it("rejects anything else", () => {
    expect(parseExitStartArgs([[], false])).toBeNull();
    expect(parseExitStartArgs([["a", 1], false])).toBeNull();
    expect(parseExitStartArgs([["a"], "yes"])).toBeNull();
    expect(parseExitStartArgs(["a", false])).toBeNull();
    expect(parseExitStartArgs([["x".repeat(101)], false])).toBeNull();
  });
});
