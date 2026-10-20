import { describe, expect, it } from "vitest";
import {
  NO_REFRESHING,
  refreshingSplitsEqual,
  splitRefreshingVtxos,
  type RefreshingVtxo,
} from "../src/lib/maintenance/refreshingBalance";

const vtxo = (id: string, amountSats: number, type: string): RefreshingVtxo => ({
  id,
  amountSats,
  state: { type },
});

describe("splitRefreshingVtxos", () => {
  it("returns zeros for no inputs", () => {
    expect(splitRefreshingVtxos([])).toEqual(NO_REFRESHING);
  });

  // The delegated case: inputs never get locked, so balance().spendable
  // still counts them and the headline already shows this money.
  it("counts spendable inputs as already in the headline", () => {
    expect(splitRefreshingVtxos([vtxo("a", 1000, "spendable"), vtxo("b", 250, "spendable")])).toEqual({
      countedInHeadlineSats: 1250,
      withheldSats: 0,
    });
  });

  // The interactive case: inputs are locked before the round state exists,
  // so the headline has already dropped them.
  it("counts locked inputs as withheld from the headline", () => {
    expect(splitRefreshingVtxos([vtxo("a", 1000, "locked")])).toEqual({
      countedInHeadlineSats: 0,
      withheldSats: 1000,
    });
  });

  it("splits a mixed set", () => {
    const split = splitRefreshingVtxos([
      vtxo("a", 1000, "spendable"),
      vtxo("b", 400, "locked"),
      vtxo("c", 30, "spendable"),
    ]);
    expect(split).toEqual({ countedInHeadlineSats: 1030, withheldSats: 400 });
  });

  it("ignores inputs whose round has already consumed them", () => {
    expect(
      splitRefreshingVtxos([vtxo("a", 1000, "spent"), vtxo("b", 2000, "exited"), vtxo("c", 7, "locked")]),
    ).toEqual({ countedInHeadlineSats: 0, withheldSats: 7 });
  });

  // The SDK has been seen returning duplicate rows; this number is shown to
  // the user as an exact amount, so a duplicate must not inflate it.
  it("dedupes by id", () => {
    expect(
      splitRefreshingVtxos([vtxo("a", 1000, "spendable"), vtxo("a", 1000, "spendable"), vtxo("b", 5, "locked")]),
    ).toEqual({ countedInHeadlineSats: 1000, withheldSats: 5 });
  });

  it("treats an unknown state as withheld rather than dropping it", () => {
    expect(splitRefreshingVtxos([vtxo("a", 42, "something-new")])).toEqual({
      countedInHeadlineSats: 0,
      withheldSats: 42,
    });
  });
});

describe("refreshingSplitsEqual", () => {
  it("compares both buckets", () => {
    expect(refreshingSplitsEqual(NO_REFRESHING, { countedInHeadlineSats: 0, withheldSats: 0 })).toBe(true);
    expect(refreshingSplitsEqual(NO_REFRESHING, { countedInHeadlineSats: 1, withheldSats: 0 })).toBe(false);
    expect(refreshingSplitsEqual(NO_REFRESHING, { countedInHeadlineSats: 0, withheldSats: 1 })).toBe(false);
  });
});
