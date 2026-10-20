import { describe, expect, it } from "vitest";
import { pendingRoundInputIds, type RoundInputsSource } from "../src/lib/wallet/roundInputs";

function source(opts: {
  rounds: string[];
  issued: string[];
  movements: { subsystemName: string; status: string; inputVtxoIds: string[] }[];
}) {
  let historyReads = 0;
  const w: RoundInputsSource = {
    pendingRoundStates: async () => opts.rounds.map((state) => ({ state })),
    pendingRoundInputVtxos: async () => opts.issued.map((id) => ({ id })),
    history: async () => {
      historyReads++;
      return opts.movements;
    },
  };
  return { w, historyReads: () => historyReads };
}

describe("pendingRoundInputIds", () => {
  it("adds a waiting participation's inputs (only its round movement shows them)", async () => {
    const s = source({
      rounds: ["delegated-pending", "delegated-pending"],
      issued: ["a"],
      movements: [
        { subsystemName: "bark.round", status: "pending", inputVtxoIds: ["b", "c"] },
        { subsystemName: "bark.round", status: "successful", inputVtxoIds: ["old"] },
        { subsystemName: "bark.arkoor", status: "pending", inputVtxoIds: ["pay"] },
      ],
    });
    expect([...(await pendingRoundInputIds(s.w))].sort()).toEqual(["a", "b", "c"]);
  });

  it("doesn't read the history with no participation waiting (a stale pending movement holds nothing)", async () => {
    const s = source({
      rounds: [],
      issued: [],
      movements: [{ subsystemName: "bark.round", status: "pending", inputVtxoIds: ["stale"] }],
    });
    expect([...(await pendingRoundInputIds(s.w))]).toEqual([]);
    expect(s.historyReads()).toBe(0);
  });
});
