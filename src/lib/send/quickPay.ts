// Quick pay (beta): small payments that go out without a confirm screen. A convenience, not a security
// control: it lives on the main thread and fails towards the confirm screen (no price, budget used up).
// The limits that are enforced (password amount, daily limit) live in the wallet worker.
import type { FiatCurrency } from "../currency";
import { fiatToSats } from "../price";

// Fiat steps of the threshold per currency. What is stored is sats, converted at the moment of use.
export const QUICK_STEPS_FIAT: Record<FiatCurrency, readonly number[]> = {
  eur: [1, 2, 5, 10, 20],
  usd: [1, 2, 5, 10, 20],
  czk: [25, 50, 100, 250, 500],
};

// The daily quick-pay budget as a multiple of the threshold.
export const QUICK_BUDGET_MULTIPLES = [1, 3, 5, 10, 50] as const;

export interface QuickPayState {
  // 0 = off, otherwise 1 + index into QUICK_STEPS_FIAT
  step: number;
  // index into QUICK_BUDGET_MULTIPLES
  budgetIdx: number;
}

// --- decision --------------------------------------------------------------


const STATE_KEY = "spendrr-quick-pay-v1";
const LEDGER_KEY = "spendrr-quick-pay-ledger-v1";
const WINDOW_MS = 24 * 60 * 60 * 1000;

export const QUICK_OFF: QuickPayState = { step: 0, budgetIdx: 2 };

function validState(v: unknown): v is QuickPayState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return Number.isInteger(o.step) && (o.step as number) >= 0 && (o.step as number) <= 5 && Number.isInteger(o.budgetIdx) && (o.budgetIdx as number) >= 0 && (o.budgetIdx as number) < QUICK_BUDGET_MULTIPLES.length;
}

export function loadQuickState(): QuickPayState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (validState(parsed)) return parsed;
    }
  } catch {
    // unreadable: off
  }
  return QUICK_OFF;
}

export function saveQuickState(state: QuickPayState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // no storage: the setting does not stick
  }
}

export interface QuickEntry {
  at: number;
  sats: number;
}

export function loadQuickLedger(now: number): QuickEntry[] {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is QuickEntry => typeof e === "object" && e !== null && Number.isFinite((e as QuickEntry).at) && Number.isFinite((e as QuickEntry).sats) && now - (e as QuickEntry).at < WINDOW_MS,
    );
  } catch {
    return [];
  }
}

export function chargeQuick(sats: number, now: number): void {
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify([...loadQuickLedger(now), { at: now, sats }]));
  } catch {
    // no storage: the budget is not counted, the worker's own limits still hold
  }
}

// The largest payment that goes out without a confirm screen, in sats, or null when quick pay is off or cannot
// be used (no price). Never at or above the password amount: such a payment needs a password, which the
// quick path has no screen to ask for.
export function quickThresholdSats(state: QuickPayState, currency: FiatCurrency, btcRate: number | null, noPasswordSats: number): number | null {
  if (state.step <= 0 || btcRate === null) return null;
  const fiat = QUICK_STEPS_FIAT[currency][state.step - 1];
  if (fiat === undefined) return null;
  const sats = Math.floor(fiatToSats(fiat, btcRate));
  const cap = noPasswordSats - 1;
  return cap < 1 ? null : Math.min(sats, cap);
}

export interface QuickInput {
  state: QuickPayState;
  currency: FiatCurrency;
  btcRate: number | null;
  noPasswordSats: number;
  // sats left under the daily limit, null = no daily limit
  hardRemainingSats: number | null;
  amountSats: number;
  now: number;
}

export type QuickReason = "off" | "no-price" | "over-threshold" | "over-hard" | "budget";
export type QuickDecision = { ok: true } | { ok: false; reason: QuickReason };

// Whether this payment may skip the confirm screen, and when not, why (the confirm screen says it). Every doubt
// answers "no": the confirm screen is the safe side.
export function quickDecision(i: QuickInput): QuickDecision {
  if (i.state.step <= 0) return { ok: false, reason: "off" };
  if (i.btcRate === null) return { ok: false, reason: "no-price" };
  const threshold = quickThresholdSats(i.state, i.currency, i.btcRate, i.noPasswordSats);
  if (threshold === null || !(i.amountSats > 0) || i.amountSats > threshold) return { ok: false, reason: "over-threshold" };
  if (i.hardRemainingSats !== null && i.amountSats > i.hardRemainingSats) return { ok: false, reason: "over-hard" };
  const budget = threshold * QUICK_BUDGET_MULTIPLES[i.state.budgetIdx];
  const spent = loadQuickLedger(i.now).reduce((sum, e) => sum + e.sats, 0);
  if (spent + i.amountSats > budget) return { ok: false, reason: "budget" };
  return { ok: true };
}

export function quickAllows(i: QuickInput): boolean {
  return quickDecision(i).ok;
}

// Whether a scan should go on to pay by itself. Needs quick pay on and an amount the QR carries (an invoice's own,
// or a link's), otherwise the form is incomplete and the person still has something to type.
export function scanAutoQuick(state: QuickPayState, qrAmountSats: number | undefined, invoiceAmountSats: number | null): boolean {
  return state.step > 0 && (qrAmountSats !== undefined || invoiceAmountSats !== null);
}
