import { describe, expect, it } from "vitest";
import {
  bandsFromFeeTable,
  DEFAULT_BANDS,
  dedupeVtxos,
  planRefresh,
  POLICY,
  watchedExpiryHeight,
  type EngineVtxo,
  type PlanInput,
} from "../../src/lib/refreshEngine/plan";

const TIP = 900_000;
const MAX_DEPTH = 100;
const CAP = 10_000_000;

let n = 0;
function vtxo(over: Partial<EngineVtxo> & { left?: number } = {}): EngineVtxo {
  n++;
  const { left, ...rest } = over;
  return {
    id: `${n.toString(16).padStart(64, "0")}:0`,
    amountSats: 100_000,
    expiryHeight: TIP + (left ?? 3000),
    exitDepth: 1,
    state: { type: "spendable" },
    ...rest,
  };
}

function input(vtxos: EngineVtxo[], over: Partial<PlanInput> = {}): PlanInput {
  return { vtxos, tipHeight: TIP, maxExitDepth: MAX_DEPTH, maxAmountSats: CAP, quarantined: new Set(), inFlight: new Set(), ...over };
}

const ids = (p: ReturnType<typeof planRefresh>) => p.batches.flatMap((b) => b.ids);

describe("due: what starts a refresh", () => {
  it.each([
    [249, true],
    [250, false],
    [1, true],
    [0, true], // expires at the tip
    [-10, true],
  ])("%i blocks left -> due %s", (left, due) => {
    const v = vtxo({ left });
    expect(ids(planRefresh(input([v])))).toEqual(due ? [v.id] : []);
  });

  it.each([
    [99, false],
    [100, true],
    [140, true],
  ])("exit depth %i (max 100) -> due %s", (exitDepth, due) => {
    const v = vtxo({ exitDepth });
    expect(ids(planRefresh(input([v])))).toEqual(due ? [v.id] : []);
  });

  it("reasons are reported", () => {
    const p = planRefresh(input([vtxo({ left: -1, exitDepth: 100 })]));
    expect(p.batches[0].due[0].reasons).toEqual(["expired", "max-depth"]);
  });
});

describe("companions: ride along, never start", () => {
  const cases: [string, Partial<EngineVtxo> & { left?: number }, boolean][] = [
    // 8 blocks of margin under the 288 boundary (audit 2026-09-26).
    ["279 blocks, big", { left: 279, amountSats: 5_000_000 }, true],
    ["280 blocks, big", { left: 280, amountSats: 5_000_000 }, false],
    ["287 blocks, big", { left: 287, amountSats: 5_000_000 }, false],
    ["330 sats far out", { amountSats: 330 }, true],
    ["331 sats far out", { amountSats: 331 }, false],
    ["9 999 sats, 999 blocks", { amountSats: 9_999, left: 999 }, true],
    ["9 999 sats, 1000 blocks", { amountSats: 9_999, left: 1000 }, false],
    ["10 000 sats, 999 blocks", { amountSats: 10_000, left: 999 }, false],
    ["9 999 sats, depth 60", { amountSats: 9_999, exitDepth: 60 }, true],
    ["9 999 sats, depth 59", { amountSats: 9_999, exitDepth: 59 }, false],
    ["10 000 sats, depth 60", { amountSats: 10_000, exitDepth: 60 }, false],
    ["big and deep (99)", { amountSats: 500_000, exitDepth: 99 }, false],
  ];

  it.each(cases)("%s -> companion %s", (_name, over, companion) => {
    const due = vtxo({ left: 10 });
    const c = vtxo(over);
    expect(ids(planRefresh(input([due, c])))).toEqual(companion ? [due.id, c.id] : [due.id]);
  });

  it.each(cases)("%s alone never starts a refresh", (_name, over) => {
    const p = planRefresh(input([vtxo(over), vtxo(over)]));
    expect(p.batches).toEqual([]);
    expect(p.idleReason).toBe("nothing-due");
  });

  it("due coins first, each group by expiry", () => {
    const d2 = vtxo({ left: 200 });
    const d1 = vtxo({ left: 5 });
    const c2 = vtxo({ left: 275 });
    const c1 = vtxo({ left: 260 });
    expect(ids(planRefresh(input([c2, d2, c1, d1])))).toEqual([d1.id, d2.id, c1.id, c2.id]);
  });
});

describe("batches under the server's max amount", () => {
  it("splits due coins into several batches, soonest first", () => {
    const a = vtxo({ left: 10, amountSats: 6_000_000 });
    const b = vtxo({ left: 20, amountSats: 6_000_000 });
    const c = vtxo({ left: 30, amountSats: 3_000_000 });
    const p = planRefresh(input([c, b, a]));
    expect(p.batches.map((x) => x.ids)).toEqual([[a.id, c.id], [b.id]]);
    for (const x of p.batches) expect(x.amountSats).toBeLessThanOrEqual(CAP);
  });

  it("a batch of exactly the cap is fine", () => {
    const a = vtxo({ left: 10, amountSats: 9_000_000 });
    const b = vtxo({ left: 11, amountSats: 1_000_000 });
    expect(planRefresh(input([a, b])).batches.map((x) => x.ids)).toEqual([[a.id, b.id]]);
  });

  it("companions only fill space, never open a batch", () => {
    const a = vtxo({ left: 10, amountSats: 9_999_000 });
    const fits = vtxo({ left: 270, amountSats: 1_000 });
    const tooBig = vtxo({ left: 271, amountSats: 2_000_000 });
    const p = planRefresh(input([a, fits, tooBig]));
    expect(p.batches.map((x) => x.ids)).toEqual([[a.id, fits.id]]);
    expect(p.leftOver.map((v) => v.id)).toEqual([tooBig.id]);
  });

  it("a coin over the cap is never offered (its output would be dropped)", () => {
    const huge = vtxo({ left: 10, amountSats: CAP + 1 });
    const p = planRefresh(input([huge]));
    expect(p.batches).toEqual([]);
    expect(p.skipped).toContainEqual({ id: huge.id, why: "over-max-amount" });
  });

  it("no cap from the server = one batch", () => {
    const a = vtxo({ left: 10, amountSats: 8_000_000 });
    const b = vtxo({ left: 11, amountSats: 8_000_000 });
    expect(planRefresh(input([a, b], { maxAmountSats: undefined })).batches).toHaveLength(1);
  });
});

describe("what is never offered", () => {
  it("quarantined due coin doesn't drag companions in", () => {
    const bad = vtxo({ left: -100 });
    const small = vtxo({ amountSats: 3_000, left: 500 });
    const p = planRefresh(input([bad, small], { quarantined: new Set([bad.id]) }));
    expect(p.batches).toEqual([]);
    expect(p.skipped).toContainEqual({ id: bad.id, why: "quarantined" });
  });

  it("in-flight coins are skipped even when still spendable", () => {
    const a = vtxo({ left: 1 });
    const b = vtxo({ left: 2 });
    const p = planRefresh(input([a, b], { inFlight: new Set([a.id]) }));
    expect(p.batches.map((x) => x.ids)).toEqual([[b.id]]);
    expect(p.skipped).toContainEqual({ id: a.id, why: "in-flight" });
  });

  it("locked, exited and spent coins are skipped", () => {
    const locked = vtxo({ left: 1, state: { type: "locked" } });
    const exited = vtxo({ left: 1, state: { type: "exited" } });
    const spent = vtxo({ left: 1, state: { type: "spent" } });
    const p = planRefresh(input([locked, exited, spent]));
    expect(p.batches).toEqual([]);
    expect(p.skipped.map((s) => s.id).sort()).toEqual([locked.id, exited.id].sort());
  });

  it("a duplicate row with a more restrictive state wins", () => {
    const a = vtxo({ left: 1 });
    const lockedCopy = { ...a, state: { type: "locked" } };
    expect(dedupeVtxos([a, lockedCopy])).toEqual([lockedCopy]);
    expect(dedupeVtxos([lockedCopy, a])).toEqual([lockedCopy]);
    expect(planRefresh(input([a, lockedCopy])).batches).toEqual([]);
  });

  it("refuses a batch below dust", () => {
    const p = planRefresh(input([vtxo({ left: 1, amountSats: 200 }), vtxo({ left: 2, amountSats: 129 })]));
    expect(p.batches).toEqual([]);
    expect(p.idleReason).toBe("below-dust");
  });

  it("exactly dust is enough", () => {
    expect(planRefresh(input([vtxo({ left: 1, amountSats: POLICY.DUST_SATS })])).batches).toHaveLength(1);
  });
});

describe("manual: everything", () => {
  it("every spendable, non-quarantined coin goes, in cap-sized batches", () => {
    const far = vtxo({ amountSats: 7_000_000 });
    const far2 = vtxo({ amountSats: 7_000_000 });
    const q = vtxo();
    const locked = vtxo({ state: { type: "locked" } });
    const p = planRefresh(input([far, far2, q, locked], { everything: true, quarantined: new Set([q.id]) }));
    expect(p.batches.flatMap((b) => b.ids).sort()).toEqual([far.id, far2.id].sort());
    expect(p.batches).toHaveLength(2);
  });
});

describe("watchedExpiryHeight", () => {
  it("soonest of spendable + locked, quarantine excluded", () => {
    const q = vtxo({ left: 5 });
    const locked = vtxo({ left: 50, state: { type: "locked" } });
    const spent = vtxo({ left: 1, state: { type: "spent" } });
    const s = vtxo({ left: 100 });
    expect(watchedExpiryHeight([q, locked, spent, s], new Set([q.id]))).toBe(TIP + 50);
    expect(watchedExpiryHeight([], new Set())).toBeUndefined();
  });
});

describe("property: random wallets", () => {
  it("batches respect the cap, never repeat a coin, only contain spendable non-quarantined coins, and exist only with a due coin", () => {
    let seed = Number(process.env.SEED ?? 42);
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const states = ["spendable", "spendable", "spendable", "locked", "spent", "exited"];
    for (let round = 0; round < 3000; round++) {
      const count = Math.floor(rnd() * 12);
      const vs: EngineVtxo[] = [];
      for (let i = 0; i < count; i++) {
        vs.push(
          vtxo({
            left: Math.floor(rnd() * 4000) - 100,
            amountSats: Math.floor(rnd() < 0.3 ? rnd() * 20_000 : rnd() * 9_000_000) + 1,
            exitDepth: Math.floor(rnd() * 110),
            state: { type: states[Math.floor(rnd() * states.length)] },
          }),
        );
      }
      if (rnd() < 0.2 && vs.length > 0) vs.push({ ...vs[0], state: { type: "locked" } });
      const quarantined = new Set(vs.filter(() => rnd() < 0.1).map((v) => v.id));
      const cap = rnd() < 0.5 ? CAP : 3_000_000;
      const p = planRefresh(input(vs, { quarantined, maxAmountSats: cap }));
      const byId = new Map(dedupeVtxos(vs).map((v) => [v.id, v]));
      const all = p.batches.flatMap((b) => b.ids);
      expect(new Set(all).size).toBe(all.length);
      for (const b of p.batches) {
        expect(b.amountSats).toBeLessThanOrEqual(cap);
        expect(b.amountSats).toBeGreaterThanOrEqual(POLICY.DUST_SATS);
        expect(b.due.length).toBeGreaterThan(0);
        expect(b.ids.slice(0, b.due.length)).toEqual(b.due.map((v) => v.id));
        for (const id of b.ids) {
          expect(byId.get(id)?.state.type).toBe("spendable");
          expect(quarantined.has(id)).toBe(false);
        }
      }
    }
  });
});

describe("bands from the server's fee table (audit 2026-09-26)", () => {
  const row = (expiryBlocksThreshold: number, ppm: number) => ({ expiryBlocksThreshold, ppm });
  it("mainnet's shape: free below 288, 0.2 % below 1008, 8 blocks of margin each", () => {
    expect(bandsFromFeeTable({ baseFeeSats: 0, ppmExpiryTable: [row(0, 0), row(288, 2000), row(1008, 5000)] })).toEqual({
      freeBelow: 280,
      cheapBelow: 1000,
    });
    expect(bandsFromFeeTable(null)).toEqual(DEFAULT_BANDS);
    expect(DEFAULT_BANDS).toEqual({ freeBelow: 280, cheapBelow: 1000 });
  });
  it("follows a changed table, in any row order", () => {
    expect(bandsFromFeeTable({ baseFeeSats: 0, ppmExpiryTable: [row(199, 4000), row(0, 0), row(97, 1000)] })).toEqual({
      freeBelow: 89,
      cheapBelow: 191,
    });
  });
  it("nothing is free when the lowest row charges or there is a base fee", () => {
    expect(bandsFromFeeTable({ baseFeeSats: 0, ppmExpiryTable: [row(0, 500), row(288, 2000)] }).freeBelow).toBe(0);
    expect(bandsFromFeeTable({ baseFeeSats: 10, ppmExpiryTable: [row(0, 0), row(288, 2000)] }).freeBelow).toBe(0);
  });
  it("the planner uses them", () => {
    const due = vtxo({ left: 10 });
    const c = vtxo({ left: 260, amountSats: 5_000_000 });
    const bands = bandsFromFeeTable({ baseFeeSats: 0, ppmExpiryTable: [row(0, 0), row(144, 1000)] });
    expect(ids(planRefresh({ ...input([due, c]), bands }))).toEqual([due.id]);
    expect(ids(planRefresh(input([due, c])))).toEqual([due.id, c.id]);
  });
});
