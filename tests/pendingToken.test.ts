import { describe, expect, it } from "vitest";
import { PENDING_TOKEN_MAX_AGE_MS, usablePendingToken } from "../src/lib/chat/pendingToken";

const NOW = 1_800_000_000_000;
const pending = (at: number, endpoint = "e1") => ({ token: "c1.tok", endpoint, at });

describe("usablePendingToken", () => {
  it("uses a token fetched in this very run (age zero)", () => {
    expect(usablePendingToken(pending(NOW), "e1", NOW)).toBe("c1.tok");
  });
  it("uses a token kept from an earlier run", () => {
    expect(usablePendingToken(pending(NOW - 3 * 24 * 3600_000), "e1", NOW)).toBe("c1.tok");
  });
  it("drops a token that is too old, for another subscription, or from the future", () => {
    expect(usablePendingToken(pending(NOW - PENDING_TOKEN_MAX_AGE_MS), "e1", NOW)).toBeNull();
    expect(usablePendingToken(pending(NOW), "e2", NOW)).toBeNull();
    expect(usablePendingToken(pending(NOW + 1), "e1", NOW)).toBeNull();
  });
  it("has nothing when nothing was kept", () => {
    expect(usablePendingToken(undefined, "e1", NOW)).toBeNull();
  });
});
