import { describe, expect, it } from "vitest";
import { estimateWithoutNonStandard, nonStandardVtxoId } from "../src/lib/exit/exitFeeEstimate";

const id = (n: number) => `${n.toString(16).padStart(64, "0")}:0`;
const bad = (v: string) =>
  new Error(`Failed to estimate emergency exit fee: Non-Standard VTXO ${v}: exit chain is not relayable: dust sibling output at genesis item 8/28, output 1`);

describe("nonStandardVtxoId", () => {
  it("reads the coin out of bark's message", () => {
    expect(nonStandardVtxoId(bad(id(1)).message)).toBe(id(1));
    expect(nonStandardVtxoId("timed out")).toBeNull();
  });
});

describe("estimateWithoutNonStandard", () => {
  it("prices the rest when one coin is non-standard", async () => {
    const seen: string[][] = [];
    const r = await estimateWithoutNonStandard(async (ids) => {
      seen.push([...ids]);
      if (ids.includes(id(2))) throw bad(id(2));
      return ids.length;
    }, [id(1), id(2), id(3)]);
    expect(r).toEqual({ result: 2, skipped: [id(2)] });
    expect(seen).toEqual([[id(1), id(2), id(3)], [id(1), id(3)]]);
  });

  it("rethrows an error that names no coin of ours", async () => {
    await expect(estimateWithoutNonStandard(async () => { throw new Error("offline"); }, [id(1), id(2)])).rejects.toThrow("offline");
    await expect(estimateWithoutNonStandard(async () => { throw bad(id(9)); }, [id(1), id(2)])).rejects.toThrow("Non-Standard");
  });

  it("rethrows when the only coin is the bad one", async () => {
    await expect(estimateWithoutNonStandard(async () => { throw bad(id(1)); }, [id(1)])).rejects.toThrow("Non-Standard");
  });

  it("stops after a few coins", async () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8].map(id);
    await expect(
      estimateWithoutNonStandard(async (left) => { throw bad(left[0]); }, ids),
    ).rejects.toThrow("Non-Standard");
  });
});
