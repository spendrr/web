import { beforeEach, describe, expect, it } from "vitest";
import { QUICK_OFF, chargeQuick, loadQuickLedger, quickAllows, quickDecision, quickThresholdSats, scanAutoQuick, type QuickInput } from "../src/lib/send/quickPay";

const NOW = 1_700_000_000_000;
const RATE = 80_000; // EUR per BTC: 1 EUR = 1250 sats

beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  });
});

const base = (over: Partial<QuickInput> = {}): QuickInput => ({
  state: { step: 2, budgetIdx: 2 }, // 2 EUR, 5x
  currency: "eur",
  btcRate: RATE,
  noPasswordSats: 100_000,
  hardRemainingSats: null,
  amountSats: 1000,
  now: NOW,
  ...over,
});

describe("quickThresholdSats", () => {
  it("is off without a step or without a price", () => {
    expect(quickThresholdSats(QUICK_OFF, "eur", RATE, 100_000)).toBeNull();
    expect(quickThresholdSats({ step: 2, budgetIdx: 0 }, "eur", null, 100_000)).toBeNull();
  });
  it("converts the fiat step to sats", () => {
    expect(quickThresholdSats({ step: 2, budgetIdx: 0 }, "eur", RATE, 100_000)).toBe(2500);
  });
  it("never reaches the password amount", () => {
    expect(quickThresholdSats({ step: 5, budgetIdx: 0 }, "eur", RATE, 5000)).toBe(4999);
    expect(quickThresholdSats({ step: 2, budgetIdx: 0 }, "eur", RATE, 0)).toBeNull();
  });
});

describe("quickAllows", () => {
  it("allows a payment under the threshold", () => {
    expect(quickAllows(base())).toBe(true);
  });
  it("refuses over the threshold, zero and fractions of nothing", () => {
    expect(quickAllows(base({ amountSats: 2501 }))).toBe(false);
    expect(quickAllows(base({ amountSats: 0 }))).toBe(false);
  });
  it("refuses what would not fit under the daily limit", () => {
    expect(quickAllows(base({ hardRemainingSats: 500 }))).toBe(false);
    expect(quickAllows(base({ hardRemainingSats: 1000 }))).toBe(true);
  });
  it("stops at the daily quick budget, and the window lets it go again", () => {
    // 2500 sats x 5 = 12500
    for (let i = 0; i < 12; i++) chargeQuick(1000, NOW + i);
    expect(quickAllows(base({ now: NOW + 100 }))).toBe(false);
    expect(loadQuickLedger(NOW + 25 * 3_600_000)).toEqual([]);
    expect(quickAllows(base({ now: NOW + 25 * 3_600_000 }))).toBe(true);
  });
});

describe("scanAutoQuick", () => {
  const on = { step: 2, budgetIdx: 2 };
  it("only with quick pay on and an amount from the QR", () => {
    expect(scanAutoQuick(QUICK_OFF, 1000, null)).toBe(false);
    expect(scanAutoQuick(on, undefined, null)).toBe(false);
    expect(scanAutoQuick(on, 1000, null)).toBe(true);
    expect(scanAutoQuick(on, undefined, 2100)).toBe(true);
  });
});

describe("quickDecision", () => {
  const base2 = (over: Partial<QuickInput> = {}): QuickInput => ({
    state: { step: 2, budgetIdx: 2 },
    currency: "eur",
    btcRate: 80_000,
    noPasswordSats: 100_000,
    hardRemainingSats: null,
    amountSats: 1000,
    now: 1_700_000_000_000,
    ...over,
  });
  it("names why it said no", () => {
    expect(quickDecision(base2())).toEqual({ ok: true });
    expect(quickDecision(base2({ state: QUICK_OFF }))).toEqual({ ok: false, reason: "off" });
    expect(quickDecision(base2({ btcRate: null }))).toEqual({ ok: false, reason: "no-price" });
    expect(quickDecision(base2({ amountSats: 9999 }))).toEqual({ ok: false, reason: "over-threshold" });
    expect(quickDecision(base2({ hardRemainingSats: 10 }))).toEqual({ ok: false, reason: "over-hard" });
  });
});
