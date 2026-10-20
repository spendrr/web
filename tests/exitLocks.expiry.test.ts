import { describe, expect, it } from "vitest";
import { exitExpiryHeights, planExitLocks, EXIT_LOCK_HOLDER_ID } from "../src/lib/exit/exitLocks";

describe("exit lock sync", () => {
  it("releases an exit lock when bark reports no exits at all (canceled exit forgotten on reopen)", () => {
    const plan = planExitLocks(
      [{ id: "a", state: { type: "locked", holder: { type: "action", id: EXIT_LOCK_HOLDER_ID } } }],
      [],
    );
    expect(plan.unlock).toEqual(["a"]);
  });

  it("returns expiry heights only for coins in an exit", () => {
    expect(
      exitExpiryHeights(
        [
          { id: "a", expiryHeight: 10 },
          { id: "b", expiryHeight: 20 },
        ],
        [{ vtxoId: "b", state: { type: "processing" } }],
      ),
    ).toEqual({ b: 20 });
  });
});
