// Refresh engine: which VTXOs go into the next refresh, decided by us instead
// of bark's maintenance*() / get_vtxos_to_refresh(). Every threshold here was
// agreed with the user (2026-09-26); don't change one without asking.
//
// Two kinds of coins:
// - DUE coins start a refresh: fewer than 250 blocks left, expired, or at the
//   server's max exit depth. 250, not the free window's 288, so a tip that is
//   a few blocks off between us and the server can't push the fee out of the
//   0 ppm band (the server prices with its own tip, no tolerance).
// - COMPANIONS never start one, they only ride along with a due coin: anything
//   in the free window (< 280: 8 under the 288 boundary), dust (<= 330 sats),
//   small coins (< 10 000 sats) in the 0.2% band (< 1000 blocks, 8 under the
//   1008 boundary) or deep enough (exit depth >= 60) to be worth resetting
//   while it's cheap. The two boundaries are read from the server's live fee
//   table when there is one (bandsFromFeeTable), 8 blocks under each: the
//   server prices a delegated refresh at submit with its OWN tip, and a coin
//   offered as free at 287 blocks was rejected ("insufficient refresh fee")
//   whenever that tip was a block behind ours (audit 2026-09-26).
//
// "Is anything due?" is decided after quarantine, so a coin the server keeps
// rejecting can't drag companions into a refresh every cycle (bark's
// maintenance_refresh_retry_loop does it the other way round, lib.rs:1834).
//
// Pure: no wallet calls, no clock, no storage.

export interface EngineVtxo {
  id: string;
  amountSats: number;
  expiryHeight: number;
  exitDepth: number;
  state: { type: string; holder?: { type: string; id: string | number } };
}

export const POLICY = {
  DUE_BLOCKS: 250,
  // Fallback boundaries (mainnet's table on 2026-09-26) when ArkInfo has no
  // fee table; the margin is applied on top of either.
  FREE_BLOCKS: 288,
  CHEAP_BLOCKS: 1008,
  BAND_MARGIN_BLOCKS: 8,
  SMALL_SATS: 10_000,
  DEEP_COMPANION_DEPTH: 60,
  // bitcoin-ext P2TR_DUST_SAT, also ark's VTXO_DUST.
  DUST_SATS: 330,
} as const;

export type DueReason = "expired" | "expiring" | "max-depth";
export type CompanionReason = "free" | "dust" | "small-cheap" | "small-deep";
export type SkipReason = "quarantined" | "in-flight" | "not-spendable" | "over-max-amount";

export interface PlannedVtxo {
  id: string;
  amountSats: number;
  expiryHeight: number;
  blocksLeft: number;
  exitDepth: number;
  reasons: (DueReason | CompanionReason)[];
}

export interface Batch {
  // Ids for one refreshVtxosDelegated() call, due coins first by expiry.
  ids: string[];
  amountSats: number;
  due: PlannedVtxo[];
  companions: PlannedVtxo[];
  // Set for a batch made of an isolation group (engine.ts): only its own
  // members, submitted whether or not they are due yet.
  group?: boolean;
}

export interface Plan {
  batches: Batch[];
  // Companions that didn't fit next to any due coin under the amount cap.
  leftOver: PlannedVtxo[];
  skipped: { id: string; why: SkipReason }[];
  // Set when `batches` is empty.
  idleReason?: "nothing-due" | "below-dust";
}

export interface PlanInput {
  // Straight from wallet.allVtxos(): may contain duplicate rows per id.
  vtxos: readonly EngineVtxo[];
  tipHeight: number;
  // arkInfo().maxVtxoExitDepth.
  maxExitDepth: number;
  // arkInfo().maxVtxoAmountSats: the server silently DROPS a round output
  // above it (server round/mod.rs:664-673), so a batch must never exceed it.
  // undefined = the server has no cap.
  maxAmountSats: number | undefined;
  quarantined: ReadonlySet<string>;
  // Inputs of every batch the engine tracks (and of an uncertain submit).
  // Their lock is the first guard; this is the second, for when a lock failed:
  // offering them again would put the same coin in two live participations.
  inFlight: ReadonlySet<string>;
  // Never offered as companions (may still be due): coins under suspicion
  // after a rejection that named no coin (engine.ts, isolation).
  noCompanion?: ReadonlySet<string>;
  // Isolation groups (engine.ts): halves of a batch the server rejected, or
  // whose round failed, without naming a coin. Each group's members go as a
  // batch of their own and nothing else joins it, until the engine has
  // narrowed the culprit down.
  groups?: readonly (readonly string[])[];
  // Manual "Obnovit teď": every spendable coin counts as due.
  everything?: boolean;
  // Companion band limits (bandsFromFeeTable); DEFAULT_BANDS when absent.
  bands?: Bands;
}

const STATE_RANK: Record<string, number> = { spendable: 0, locked: 1, exited: 2, spent: 3 };

// A safeguard: allVtxos() once returned the same id twice with different
// states (cause never found; bark 0.7.1's IndexedDB store is keyed by id, so
// it shouldn't). Keep the most restrictive row so a coin is never treated as more spendable
// than it is (same rule as Settings' VtxoList).
export function dedupeVtxos(vtxos: readonly EngineVtxo[]): EngineVtxo[] {
  const byId = new Map<string, EngineVtxo>();
  for (const v of vtxos) {
    const prev = byId.get(v.id);
    const rank = STATE_RANK[v.state.type] ?? 99;
    const prevRank = prev ? (STATE_RANK[prev.state.type] ?? 99) : -1;
    if (!prev || rank > prevRank) byId.set(v.id, v);
  }
  return [...byId.values()];
}

export function dueReasons(v: EngineVtxo, tipHeight: number, maxExitDepth: number): DueReason[] {
  const out: DueReason[] = [];
  const left = v.expiryHeight - tipHeight;
  if (left <= 0) out.push("expired");
  else if (left < POLICY.DUE_BLOCKS) out.push("expiring");
  if (v.exitDepth >= maxExitDepth) out.push("max-depth");
  return out;
}

// Blocks-left limits for the "free" and "small-cheap" companion rules,
// already including the margin.
export interface Bands {
  freeBelow: number;
  cheapBelow: number;
}

export const DEFAULT_BANDS: Bands = {
  freeBelow: POLICY.FREE_BLOCKS - POLICY.BAND_MARGIN_BLOCKS,
  cheapBelow: POLICY.CHEAP_BLOCKS - POLICY.BAND_MARGIN_BLOCKS,
};

// From arkInfo().feeSchedule.refresh (bark's calc_ppm_expiry_fee: a coin pays
// the ppm of the last row whose threshold its remaining blocks reach). Free =
// below the first row that charges anything; cheap = below the row after it,
// i.e. inside the lowest paying band. A base fee makes nothing free. No table
// (or an unreadable one): DEFAULT_BANDS.
export function bandsFromFeeTable(
  table: { baseFeeSats: number; ppmExpiryTable: readonly { expiryBlocksThreshold: number; ppm: number }[] } | null | undefined,
): Bands {
  if (!table || !Array.isArray(table.ppmExpiryTable)) return DEFAULT_BANDS;
  const rows = [...table.ppmExpiryTable]
    .filter((r) => Number.isFinite(r.expiryBlocksThreshold) && Number.isFinite(r.ppm))
    .sort((a, b) => a.expiryBlocksThreshold - b.expiryBlocksThreshold);
  const m = POLICY.BAND_MARGIN_BLOCKS;
  const firstPaid = rows.findIndex((r) => r.ppm > 0);
  // Nothing in the table charges: everything is free up to the fallback's
  // reach (don't invent unlimited companions from a strange table).
  if (firstPaid < 0) return table.baseFeeSats > 0 ? { ...DEFAULT_BANDS, freeBelow: 0 } : DEFAULT_BANDS;
  const freeBoundary = rows[firstPaid].expiryBlocksThreshold;
  const next = rows[firstPaid + 1];
  const cheapBoundary = next ? next.expiryBlocksThreshold : POLICY.CHEAP_BLOCKS;
  return {
    freeBelow: table.baseFeeSats > 0 ? 0 : Math.max(0, freeBoundary - m),
    cheapBelow: Math.max(0, cheapBoundary - m),
  };
}

export function companionReasons(v: EngineVtxo, tipHeight: number, bands: Bands = DEFAULT_BANDS): CompanionReason[] {
  const out: CompanionReason[] = [];
  const left = v.expiryHeight - tipHeight;
  const small = v.amountSats < POLICY.SMALL_SATS;
  if (left < bands.freeBelow) out.push("free");
  if (v.amountSats <= POLICY.DUST_SATS) out.push("dust");
  if (small && left < bands.cheapBelow) out.push("small-cheap");
  if (small && v.exitDepth >= POLICY.DEEP_COMPANION_DEPTH) out.push("small-deep");
  return out;
}

const byExpiry = (a: PlannedVtxo, b: PlannedVtxo) => a.expiryHeight - b.expiryHeight || a.id.localeCompare(b.id);

export function planRefresh(input: PlanInput): Plan {
  const cap = input.maxAmountSats ?? Number.POSITIVE_INFINITY;
  const skipped: Plan["skipped"] = [];
  const groupOf = new Map<string, number>();
  (input.groups ?? []).forEach((g, i) => g.forEach((id) => groupOf.set(id, i)));
  const grouped = new Map<number, PlannedVtxo[]>();
  const due: PlannedVtxo[] = [];
  const maybe: PlannedVtxo[] = [];

  for (const v of dedupeVtxos(input.vtxos)) {
    if (v.state.type !== "spendable") {
      // Spent coins are just history; only report the ones still held.
      if (v.state.type !== "spent") skipped.push({ id: v.id, why: "not-spendable" });
      continue;
    }
    if (input.quarantined.has(v.id)) {
      skipped.push({ id: v.id, why: "quarantined" });
      continue;
    }
    if (input.inFlight.has(v.id)) {
      skipped.push({ id: v.id, why: "in-flight" });
      continue;
    }
    if (v.amountSats > cap) {
      // Can't be refreshed at all without the output being dropped.
      skipped.push({ id: v.id, why: "over-max-amount" });
      continue;
    }
    const planned = (reasons: PlannedVtxo["reasons"]): PlannedVtxo => ({
      id: v.id,
      amountSats: v.amountSats,
      expiryHeight: v.expiryHeight,
      blocksLeft: v.expiryHeight - input.tipHeight,
      exitDepth: v.exitDepth,
      reasons,
    });
    const d = dueReasons(v, input.tipHeight, input.maxExitDepth);
    const gi = groupOf.get(v.id);
    if (gi !== undefined) {
      const list = grouped.get(gi) ?? [];
      list.push(planned(d.length > 0 ? d : companionReasons(v, input.tipHeight, input.bands)));
      grouped.set(gi, list);
      continue;
    }
    if (d.length > 0) {
      due.push(planned(d));
      continue;
    }
    const c = companionReasons(v, input.tipHeight, input.bands);
    if (input.everything) due.push(planned(c));
    else if (c.length > 0 && !input.noCompanion?.has(v.id)) maybe.push(planned(c));
  }

  due.sort(byExpiry);
  maybe.sort(byExpiry);
  // Groups first: they are a refresh already under way.
  const groupBatches: Batch[] = [...grouped.values()].map((members) => {
    members.sort(byExpiry);
    return { ids: [], amountSats: members.reduce((sum, v) => sum + v.amountSats, 0), due: members, companions: [], group: true };
  });
  if (due.length === 0 && groupBatches.length === 0) {
    return { batches: [], leftOver: [], skipped, idleReason: "nothing-due" };
  }

  // First fit in expiry order: the soonest-expiring due coins get the first
  // batch; a due coin that fits nowhere opens a new one.
  const batches: Batch[] = [];
  for (const v of due) {
    const b = batches.find((x) => x.amountSats + v.amountSats <= cap);
    if (b) {
      b.due.push(v);
      b.amountSats += v.amountSats;
    } else {
      batches.push({ ids: [], amountSats: v.amountSats, due: [v], companions: [] });
    }
  }
  // Companions only into a batch that already exists, never their own.
  const leftOver: PlannedVtxo[] = [];
  for (const v of due.length > 0 ? maybe : []) {
    const b = batches.find((x) => x.amountSats + v.amountSats <= cap);
    if (b) {
      b.companions.push(v);
      b.amountSats += v.amountSats;
    } else {
      leftOver.push(v);
    }
  }

  // bark refuses a participation below VTXO_DUST outright, and each attempt
  // costs a key index, so don't ask.
  const kept = [...groupBatches, ...batches].filter((b) => b.amountSats >= POLICY.DUST_SATS);
  for (const b of kept) b.ids = [...b.due, ...b.companions].map((v) => v.id);
  if (kept.length === 0) return { batches: [], leftOver, skipped, idleReason: "below-dust" };
  return { batches: kept, leftOver, skipped };
}

// Height the expiry push watches (worker/index.ts checkVtxoExpiry): the
// soonest expiry among coins we still hold, including ones in a refresh (it
// may fail), excluding quarantined ones (nothing the user can do about them,
// and a nudge they can't act on would repeat).
export function watchedExpiryHeight(
  vtxos: readonly EngineVtxo[],
  quarantined: ReadonlySet<string>,
): number | undefined {
  let min: number | undefined;
  for (const v of dedupeVtxos(vtxos)) {
    if (v.state.type !== "spendable" && v.state.type !== "locked") continue;
    if (quarantined.has(v.id)) continue;
    if (min === undefined || v.expiryHeight < min) min = v.expiryHeight;
  }
  return min;
}
