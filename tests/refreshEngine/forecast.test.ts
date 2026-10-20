import { describe, expect, it } from "vitest";
import { forecast, refreshFeeSats, type FeeTable, type ForecastInput } from "../../src/lib/refreshEngine/forecast";
import type { EngineVtxo } from "../../src/lib/refreshEngine/plan";

const TIP = 900_000;
// The live table (arkInfo 2026-09-26).
const FEES: FeeTable = {
  baseFeeSats: 0,
  ppmExpiryTable: [
    { expiryBlocksThreshold: 0, ppm: 0 },
    { expiryBlocksThreshold: 288, ppm: 2000 },
    { expiryBlocksThreshold: 1008, ppm: 4000 },
    { expiryBlocksThreshold: 2016, ppm: 5000 },
  ],
};

let n = 0;
function vtxo(over: Partial<EngineVtxo> & { left?: number } = {}): EngineVtxo {
  n++;
  const { left, ...rest } = over;
  return {
    id: `${n.toString(16).padStart(64, "c")}:0`,
    amountSats: 100_000,
    expiryHeight: TIP + (left ?? 3000),
    exitDepth: 1,
    state: { type: "spendable" },
    ...rest,
  };
}

function input(vtxos: EngineVtxo[], over: Partial<ForecastInput> = {}): ForecastInput {
  return {
    vtxos,
    tipHeight: TIP,
    maxExitDepth: 100,
    maxAmountSats: 10_000_000,
    quarantined: new Set(),
    inFlight: new Set(),
    held: new Set(),
    noCompanion: new Set(),
    groups: [],
    fees: FEES,
    ...over,
  };
}

describe("refreshFeeSats (bark calc_ppm_expiry_fee)", () => {
  it("prices by blocks left at the given height, rows summed, rounded up once", () => {
    expect(refreshFeeSats([{ amountSats: 100_000, expiryHeight: TIP + 100 }], TIP, FEES)).toBe(0);
    expect(refreshFeeSats([{ amountSats: 100_000, expiryHeight: TIP + 500 }], TIP, FEES)).toBe(200);
    expect(refreshFeeSats([{ amountSats: 100_000, expiryHeight: TIP + 3000 }], TIP, FEES)).toBe(500);
    // Two 0.2% coins of 250 sats: 0.5 + 0.5 = 1 sat, not 1 + 1.
    expect(
      refreshFeeSats(
        [
          { amountSats: 250, expiryHeight: TIP + 500 },
          { amountSats: 250, expiryHeight: TIP + 600 },
        ],
        TIP,
        FEES,
      ),
    ).toBe(1);
    // Exactly at a threshold is that row's rate.
    expect(refreshFeeSats([{ amountSats: 1_000_000, expiryHeight: TIP + 288 }], TIP, FEES)).toBe(2000);
    expect(refreshFeeSats([{ amountSats: 1_000_000, expiryHeight: TIP + 288 }], TIP + 1, FEES)).toBe(0);
  });
});

describe("forecast", () => {
  it("nothing due: the next refresh is when the soonest coin drops under 250 blocks", () => {
    const soon = vtxo({ left: 600 });
    const f = forecast(input([vtxo(), soon]));
    expect(f.nextAtHeight).toBe(soon.expiryHeight - 249);
    expect(f.batches[0].due.map((v) => v.id)).toEqual([soon.id]);
    expect(f.batches[0].feeSats).toBe(0);
    expect(f.coins.find((c) => c.id === soon.id)?.fate).toBe("next-due");
  });

  it("companions are judged at that future height, with their fee", () => {
    const soon = vtxo({ left: 600 });
    // At the refresh height it has 1000 - 351 = 649 blocks left: small, 0.2%.
    const small = vtxo({ left: 1000, amountSats: 5_000 });
    const big = vtxo({ left: 1000, amountSats: 500_000 });
    const f = forecast(input([soon, small, big]));
    const b = f.batches[0];
    expect(b.companions.map((v) => v.id)).toEqual([small.id]);
    expect(b.companions[0].reasons).toEqual(["small-cheap"]);
    expect(b.feeSats).toBe(10);
    expect(b.outputSats).toBe(b.amountSats - 10);
    expect(f.coins.find((c) => c.id === big.id)?.fate).toBe("later");
  });

  it("due now: the tip", () => {
    const due = vtxo({ left: 100 });
    expect(forecast(input([due])).nextAtHeight).toBe(TIP);
    expect(forecast(input([vtxo({ exitDepth: 100 })])).nextAtHeight).toBe(TIP);
  });

  it("empty wallet or nothing refreshable: no next refresh", () => {
    expect(forecast(input([])).nextAtHeight).toBeNull();
    const q = vtxo({ left: 10 });
    const f = forecast(input([q], { quarantined: new Set([q.id]) }));
    expect(f.nextAtHeight).toBeNull();
    expect(f.coins[0].fate).toBe("quarantined");
  });

  it("every coin gets a fate", () => {
    const inRefresh = vtxo({ left: 100, state: { type: "locked", holder: { type: "action", id: "spendrr-refresh" } } });
    const payment = vtxo({ state: { type: "locked", holder: { type: "action", id: "ln" } } });
    const held = vtxo({ left: 100 });
    const huge = vtxo({ left: 100, amountSats: 20_000_000 });
    const f = forecast(input([inRefresh, payment, held, huge], { inFlight: new Set([inRefresh.id]), held: new Set([held.id]) }));
    const fate = (id: string) => f.coins.find((c) => c.id === id)?.fate;
    expect(fate(inRefresh.id)).toBe("in-refresh");
    expect(fate(payment.id)).toBe("locked");
    expect(fate(held.id)).toBe("held");
    expect(fate(huge.id)).toBe("over-max-amount");
  });

  it("an isolation group goes now, alone", () => {
    const a = vtxo({ left: 3000 });
    const b = vtxo({ left: 3000 });
    const f = forecast(input([a, b], { groups: [[a.id]] }));
    expect(f.nextAtHeight).toBe(TIP);
    expect(f.batches).toHaveLength(1);
    expect(f.batches[0].group).toBe(true);
    expect(f.batches[0].due.map((v) => v.id)).toEqual([a.id]);
  });

  it("unknown fee table: fee 0, output = amount", () => {
    const f = forecast(input([vtxo({ left: 100 })], { fees: null }));
    expect(f.batches[0].feeSats).toBe(0);
    expect(f.batches[0].outputSats).toBe(f.batches[0].amountSats);
  });
});
