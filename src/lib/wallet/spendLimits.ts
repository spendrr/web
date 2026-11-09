// User-set spend limits (beta). Pure: no storage, no crypto, no clock (callers pass `now`).
// The Android app ports this file (spendrr-android-kotlin, SpendLimits.kt) and checks it against the
// golden corpus tools/gen-spendlimits-golden.mjs there: keep names, result shapes and the record text stable.
//
// Two numbers:
//  - noPasswordSats: sends at or above it need the password re-entered, and the sends below it share a rolling
//    budget of the same size (the old PASSWORD_REQUIRED_THRESHOLD_SATS / UNAUTHORIZED_SPEND_CAP_SATS pair, which
//    were deliberately equal, now one setting).
//  - hardSats: optional cap on everything sent in a rolling window, password or not. A brake against hasty and
//    scam payments, NOT a security boundary: whoever knows the password can reveal the seed. Exits are never
//    counted or blocked (they stay on their own always-auth path in walletSpendPolicy.ts).
//
// Tightening is immediate, loosening is not: lowering a limit never needs anything, raising noPasswordSats needs
// the password, and raising or removing hardSats needs the password and only takes effect after
// LIMIT_RAISE_DELAY_MS.

export const SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;
export const LIMIT_RAISE_DELAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_NO_PASSWORD_SATS = 100_000;

// 21M BTC in sats; anything above is a corrupt record, not a limit.
export const MAX_LIMIT_SATS = 2_100_000_000_000_000;

// null hardSats = the hard limit is switched off when this matures.
export interface PendingHardChange {
  hardSats: number | null;
  effectiveAt: number;
}

// null hardSats = no hard limit.
export interface SpendLimits {
  noPasswordSats: number;
  hardSats: number | null;
  pending: PendingHardChange | null;
}

export const DEFAULT_LIMITS: SpendLimits = { noPasswordSats: DEFAULT_NO_PASSWORD_SATS, hardSats: null, pending: null };

export function isLimitSats(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= MAX_LIMIT_SATS;
}

// Applies a pending change whose time has come. Always call before reading the limits, so a matured raise is
// never ignored and an unmatured one never applied early.
export function settle(limits: SpendLimits, now: number): SpendLimits {
  const p = limits.pending;
  if (!p || now < p.effectiveAt) return limits;
  return { noPasswordSats: limits.noPasswordSats, hardSats: p.hardSats, pending: null };
}

export type LimitChange =
  | { kind: "noPassword"; sats: number }
  // null switches the hard limit off.
  | { kind: "hard"; sats: number | null }
  | { kind: "cancelPending" };

export type ChangeResult =
  | { ok: true; limits: SpendLimits; needsAuth: boolean }
  | { ok: false; reason: "invalid" | "above-hard" };

export function applyChange(current: SpendLimits, change: LimitChange, now: number): ChangeResult {
  const l = settle(current, now);
  switch (change.kind) {
    case "cancelPending":
      return { ok: true, limits: { ...l, pending: null }, needsAuth: false };
    case "noPassword": {
      if (!isLimitSats(change.sats)) return { ok: false, reason: "invalid" };
      if (l.hardSats !== null && change.sats > l.hardSats) return { ok: false, reason: "above-hard" };
      return { ok: true, limits: { ...l, noPasswordSats: change.sats }, needsAuth: change.sats > l.noPasswordSats };
    }
    case "hard": {
      const next = change.sats;
      if (next !== null && (!isLimitSats(next) || next < 1)) return { ok: false, reason: "invalid" };
      const loosens = l.hardSats !== null && (next === null || next > l.hardSats);
      if (loosens) {
        return { ok: true, limits: { ...l, pending: { hardSats: next, effectiveAt: now + LIMIT_RAISE_DELAY_MS } }, needsAuth: true };
      }
      // Turning it on, or tightening or keeping it: immediate. The no-password amount follows it down so the
      // ordering always holds.
      const noPasswordSats = next !== null && l.noPasswordSats > next ? next : l.noPasswordSats;
      return { ok: true, limits: { noPasswordSats, hardSats: next, pending: null }, needsAuth: false };
    }
    default:
      return { ok: false, reason: "invalid" };
  }
}

// --- hard limit ledger -----------------------------------------------------

export interface LedgerEntry {
  at: number;
  sats: number;
}

// Sliding window: an entry counts while now - at < SPEND_WINDOW_MS.
export function pruneLedger(entries: readonly LedgerEntry[], now: number): LedgerEntry[] {
  return entries.filter((e) => now - e.at < SPEND_WINDOW_MS && e.at <= now + SPEND_WINDOW_MS);
}

export function hardRemaining(entries: readonly LedgerEntry[], hardSats: number, now: number): number {
  let spent = 0;
  for (const e of pruneLedger(entries, now)) spent += e.sats;
  return Math.max(0, hardSats - spent);
}

export type HardCheck = { ok: true; charge: number } | { ok: false; remainingSats: number };

// amountSats null (the arguments do not say) is refused when a hard limit is on, exactly as an unreadable
// amount already needs the password. `charge` is 0 when there is no hard limit.
export function checkHard(limits: SpendLimits, entries: readonly LedgerEntry[], amountSats: number | null, now: number): HardCheck {
  const hardSats = settle(limits, now).hardSats;
  if (hardSats === null) return { ok: true, charge: 0 };
  const remaining = hardRemaining(entries, hardSats, now);
  if (amountSats === null || amountSats > remaining) return { ok: false, remainingSats: remaining };
  return { ok: true, charge: amountSats };
}

export function chargeLedger(entries: readonly LedgerEntry[], charge: number, now: number): LedgerEntry[] {
  const kept = pruneLedger(entries, now);
  return charge > 0 ? [...kept, { at: now, sats: charge }] : kept;
}

// --- record (de)serialization ----------------------------------------------

export interface LimitsRecord {
  limits: SpendLimits;
  ledger: LedgerEntry[];
}

// The exact text both apps write.
export function encodeRecord(r: LimitsRecord): string {
  return JSON.stringify({
    v: 1,
    noPasswordSats: r.limits.noPasswordSats,
    hardSats: r.limits.hardSats,
    pending: r.limits.pending ? { hardSats: r.limits.pending.hardSats, effectiveAt: r.limits.pending.effectiveAt } : null,
    ledger: r.ledger.map((e) => [e.at, e.sats]),
  });
}

function wholeTime(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER ? v : null;
}

function hardOrNull(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === null) return { ok: true, value: null };
  if (!isLimitSats(v) || v < 1) return { ok: false };
  return { ok: true, value: v };
}

// null for anything that is not exactly a valid v1 record.
export function decodeRecord(text: string): LimitsRecord | null {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
  const rec = o as Record<string, unknown>;
  if (rec.v !== 1) return null;
  const np = rec.noPasswordSats;
  if (!isLimitSats(np)) return null;
  if (!("hardSats" in rec)) return null;
  const hard = hardOrNull(rec.hardSats);
  if (!hard.ok) return null;
  if (hard.value !== null && np > hard.value) return null;
  if (!("pending" in rec)) return null;
  let pending: PendingHardChange | null = null;
  if (rec.pending !== null) {
    const p = rec.pending;
    if (typeof p !== "object" || Array.isArray(p) || p === null) return null;
    const pr = p as Record<string, unknown>;
    if (!("hardSats" in pr)) return null;
    const ph = hardOrNull(pr.hardSats);
    if (!ph.ok) return null;
    const at = wholeTime(pr.effectiveAt);
    if (at === null) return null;
    pending = { hardSats: ph.value, effectiveAt: at };
  }
  const rows = rec.ledger;
  if (!Array.isArray(rows)) return null;
  const ledger: LedgerEntry[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 2) return null;
    const at = wholeTime(row[0]);
    if (at === null || !isLimitSats(row[1])) return null;
    ledger.push({ at, sats: row[1] });
  }
  return { limits: { noPasswordSats: np, hardSats: hard.value, pending }, ledger };
}

// What an unreadable stored record means: the strictest setting that costs nothing. The password for every send,
// and no hard limit known (one we cannot read cannot be enforced; the user can set it again).
export const UNREADABLE_RECORD: LimitsRecord = { limits: { noPasswordSats: 0, hardSats: null, pending: null }, ledger: [] };

// What the worker tells the UI: the settled limits, what is left of the hard limit (null = no hard limit), and
// whether the stored record could not be read (the strict fallback is in force until the user sets limits again).
export interface SpendLimitsStatus {
  limits: SpendLimits;
  hardRemainingSats: number | null;
  // When the oldest payment still inside the daily window was made (null when none, or no daily limit).
  oldestAt: number | null;
  unreadable: boolean;
}

export type LimitChangeOutcome = { ok: true; status: SpendLimitsStatus } | { ok: false; reason: "invalid" | "above-hard" };
