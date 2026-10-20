// What the engine is going to do, for Settings → Automatická obnova → Plán.
// Pure: the same planner the engine runs (plan.ts), evaluated at the height
// where the next coin becomes due instead of at the tip, plus each coin's own
// schedule and a fee estimate from the server's table.
//
// It is a forecast, not a promise: a refresh only happens while the app is
// open (the engine ticks from refresh()), coins arrive and leave, and the
// server can change its fee table.
import { POLICY, bandsFromFeeTable, dedupeVtxos, dueReasons, planRefresh, type EngineVtxo, type PlannedVtxo } from "./plan";

export interface FeeTable {
  baseFeeSats: number;
  // arkInfo().feeSchedule.refresh.ppmExpiryTable, ascending thresholds.
  ppmExpiryTable: { expiryBlocksThreshold: number; ppm: number }[];
}

// bark's calc_ppm_expiry_fee (lib/src/fees.rs:508): coins are grouped by the
// last table row whose threshold their remaining blocks reach, each row's sum
// is charged its ppm, sub-satoshi parts add up and round up once.
export function refreshFeeSats(
  coins: readonly { amountSats: number; expiryHeight: number }[],
  atHeight: number,
  table: FeeTable,
): number {
  let ppmSats = 0;
  for (const c of coins) {
    const blocks = c.expiryHeight - atHeight;
    let ppm = 0;
    for (const row of table.ppmExpiryTable) if (blocks >= row.expiryBlocksThreshold) ppm = row.ppm;
    ppmSats += c.amountSats * ppm;
  }
  return table.baseFeeSats + Math.ceil(ppmSats / 1_000_000);
}

export interface ForecastBatch {
  due: PlannedVtxo[];
  companions: PlannedVtxo[];
  amountSats: number;
  feeSats: number;
  outputSats: number;
  group: boolean;
}

export interface CoinSchedule {
  id: string;
  amountSats: number;
  expiryHeight: number;
  blocksLeft: number;
  exitDepth: number;
  // Height from which it counts as due (a refresh starts for it), null when
  // it's due already.
  dueAtHeight: number | null;
  trigger: "expired" | "expiring" | "max-depth";
  // What happens to it: in the next refresh (as due, or riding along), or
  // later on its own, or not at all right now (and why).
  fate: "next-due" | "next-companion" | "later" | "quarantined" | "in-refresh" | "locked" | "held" | "over-max-amount";
}

export interface Forecast {
  tipHeight: number;
  // Height of the next refresh: the tip if something is due now.
  nextAtHeight: number | null;
  batches: ForecastBatch[];
  coins: CoinSchedule[];
}

export interface ForecastInput {
  vtxos: readonly EngineVtxo[];
  tipHeight: number;
  maxExitDepth: number;
  maxAmountSats: number | undefined;
  quarantined: ReadonlySet<string>;
  inFlight: ReadonlySet<string>;
  held: ReadonlySet<string>;
  noCompanion: ReadonlySet<string>;
  groups: readonly (readonly string[])[];
  fees: FeeTable | null;
}

// First height at which `v` is due: under DUE_BLOCKS left, or the tip if its
// depth already is at the server's max.
function dueHeight(v: EngineVtxo, input: ForecastInput): { height: number; trigger: CoinSchedule["trigger"] } {
  if (v.exitDepth >= input.maxExitDepth) return { height: input.tipHeight, trigger: "max-depth" };
  const h = v.expiryHeight - POLICY.DUE_BLOCKS + 1;
  if (v.expiryHeight <= input.tipHeight) return { height: input.tipHeight, trigger: "expired" };
  return { height: Math.max(h, input.tipHeight), trigger: "expiring" };
}

export function forecast(input: ForecastInput): Forecast {
  const coins = dedupeVtxos(input.vtxos).filter((v) => v.state.type === "spendable" || v.state.type === "locked");
  const cap = input.maxAmountSats ?? Number.POSITIVE_INFINITY;
  const candidates = coins.filter(
    (v) =>
      v.state.type === "spendable" &&
      !input.quarantined.has(v.id) &&
      !input.inFlight.has(v.id) &&
      !input.held.has(v.id) &&
      v.amountSats <= cap,
  );

  // The next refresh: now if an isolation group waits or anything is due,
  // otherwise when the soonest coin becomes due.
  let next: number | null = input.groups.length > 0 && candidates.some((v) => input.groups.some((g) => g.includes(v.id))) ? input.tipHeight : null;
  for (const v of candidates) {
    const h = dueHeight(v, input).height;
    if (next === null || h < next) next = h;
  }

  let batches: ForecastBatch[] = [];
  if (next !== null) {
    const plan = planRefresh({
      bands: bandsFromFeeTable(input.fees),
      vtxos: candidates,
      tipHeight: next,
      maxExitDepth: input.maxExitDepth,
      maxAmountSats: input.maxAmountSats,
      quarantined: new Set(),
      inFlight: new Set(),
      noCompanion: input.noCompanion,
      groups: input.groups,
    });
    batches = plan.batches.map((b) => {
      const all = [...b.due, ...b.companions];
      const feeSats = input.fees ? refreshFeeSats(all, next!, input.fees) : 0;
      return { due: b.due, companions: b.companions, amountSats: b.amountSats, feeSats, outputSats: b.amountSats - feeSats, group: b.group ?? false };
    });
  }
  const nextDue = new Set(batches.flatMap((b) => b.due.map((v) => v.id)));
  const nextCompanion = new Set(batches.flatMap((b) => b.companions.map((v) => v.id)));

  const schedule: CoinSchedule[] = coins.map((v) => {
    const d = dueHeight(v, input);
    const fate: CoinSchedule["fate"] = input.quarantined.has(v.id)
      ? "quarantined"
      : input.inFlight.has(v.id)
        ? "in-refresh"
        : v.state.type === "locked"
          ? "locked"
          : input.held.has(v.id)
          ? "held"
          : v.amountSats > cap
            ? "over-max-amount"
            : nextDue.has(v.id)
              ? "next-due"
              : nextCompanion.has(v.id)
                ? "next-companion"
                : "later";
    const dueNow = dueReasons(v, input.tipHeight, input.maxExitDepth).length > 0;
    return {
      id: v.id,
      amountSats: v.amountSats,
      expiryHeight: v.expiryHeight,
      blocksLeft: v.expiryHeight - input.tipHeight,
      exitDepth: v.exitDepth,
      dueAtHeight: dueNow ? null : d.height,
      trigger: d.trigger,
      fate,
    };
  });
  schedule.sort((a, b) => (a.dueAtHeight ?? -1) - (b.dueAtHeight ?? -1) || a.expiryHeight - b.expiryHeight);

  return { tipHeight: input.tipHeight, nextAtHeight: next, batches, coins: schedule };
}
