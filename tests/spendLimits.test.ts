import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  LIMIT_RAISE_DELAY_MS,
  SPEND_WINDOW_MS,
  applyChange,
  checkHard,
  chargeLedger,
  decodeRecord,
  encodeRecord,
  hardRemaining,
  settle,
  type SpendLimits,
} from "../src/lib/wallet/spendLimits";
import { classifyWalletCall, createUnauthorizedSpendBudget } from "../src/lib/wallet/walletSpendPolicy";

const NOW = 1_700_000_000_000;
const hard = (hardSats: number | null, noPasswordSats = 1000): SpendLimits => ({ noPasswordSats, hardSats, pending: null });

describe("applyChange", () => {
  it("tightening is immediate and needs nothing", () => {
    const r = applyChange(hard(50_000, 20_000), { kind: "noPassword", sats: 5000 }, NOW);
    expect(r).toEqual({ ok: true, limits: hard(50_000, 5000), needsAuth: false });
  });
  it("raising the no-password amount needs the password", () => {
    const r = applyChange(DEFAULT_LIMITS, { kind: "noPassword", sats: 200_000 }, NOW);
    expect(r.ok && r.needsAuth).toBe(true);
  });
  it("refuses a no-password amount above the hard limit", () => {
    expect(applyChange(hard(10_000), { kind: "noPassword", sats: 10_001 }, NOW)).toEqual({ ok: false, reason: "above-hard" });
  });
  it("turning the hard limit on is immediate and pulls the no-password amount down", () => {
    const r = applyChange(DEFAULT_LIMITS, { kind: "hard", sats: 30_000 }, NOW);
    expect(r).toEqual({ ok: true, limits: hard(30_000, 30_000), needsAuth: false });
  });
  it("loosening or removing the hard limit waits and needs the password", () => {
    const r = applyChange(hard(30_000), { kind: "hard", sats: null }, NOW);
    expect(r).toEqual({
      ok: true,
      needsAuth: true,
      limits: { noPasswordSats: 1000, hardSats: 30_000, pending: { hardSats: null, effectiveAt: NOW + LIMIT_RAISE_DELAY_MS } },
    });
  });
  it("a matured pending change is applied before anything else", () => {
    const l: SpendLimits = { noPasswordSats: 1000, hardSats: 30_000, pending: { hardSats: null, effectiveAt: NOW } };
    expect(settle(l, NOW - 1)).toBe(l);
    expect(settle(l, NOW)).toEqual(hard(null));
  });
  it("rejects fractions, negatives and a zero hard limit", () => {
    expect(applyChange(DEFAULT_LIMITS, { kind: "noPassword", sats: 1.5 }, NOW).ok).toBe(false);
    expect(applyChange(DEFAULT_LIMITS, { kind: "noPassword", sats: -1 }, NOW).ok).toBe(false);
    expect(applyChange(DEFAULT_LIMITS, { kind: "hard", sats: 0 }, NOW).ok).toBe(false);
  });
});

describe("hard limit ledger", () => {
  it("counts a spend for exactly one window", () => {
    const l = chargeLedger([], 400, NOW);
    expect(hardRemaining(l, 1000, NOW + SPEND_WINDOW_MS - 1)).toBe(600);
    expect(hardRemaining(l, 1000, NOW + SPEND_WINDOW_MS)).toBe(1000);
  });
  it("refuses what does not fit and an unreadable amount, charges what does", () => {
    const l = chargeLedger([], 900, NOW);
    expect(checkHard(hard(1000), l, 200, NOW)).toEqual({ ok: false, remainingSats: 100 });
    expect(checkHard(hard(1000), l, null, NOW)).toEqual({ ok: false, remainingSats: 100 });
    expect(checkHard(hard(1000), l, 100, NOW)).toEqual({ ok: true, charge: 100 });
    expect(checkHard(hard(null), l, 5_000_000, NOW)).toEqual({ ok: true, charge: 0 });
  });
});

describe("record", () => {
  it("round-trips", () => {
    const rec = { limits: { noPasswordSats: 500, hardSats: 9000, pending: { hardSats: null, effectiveAt: NOW } }, ledger: [{ at: NOW, sats: 7 }] };
    expect(decodeRecord(encodeRecord(rec))).toEqual(rec);
  });
  it("refuses anything that is not exactly a v1 record", () => {
    const ok = encodeRecord({ limits: hard(null), ledger: [] });
    expect(decodeRecord(ok)).not.toBeNull();
    for (const bad of [
      "", "null", "[]", "{",
      ok.replace('"v":1', '"v":2'),
      ok.replace('"hardSats":null', '"hardSats":0'),
      ok.replace('"noPasswordSats":1000', '"noPasswordSats":1.5'),
      ok.replace('"ledger":[]', '"ledger":[[1]]'),
      ok.replace('"ledger":[]', '"ledger":[[1,-1]]'),
      ok.replace('"pending":null,', ""),
      encodeRecord({ limits: { noPasswordSats: 5000, hardSats: 1000, pending: null }, ledger: [] }),
    ]) {
      expect(decodeRecord(bad), bad).toBeNull();
    }
  });
});

describe("threshold in the policy", () => {
  const args = [{ invoice: "x", amountSats: 5000 }];
  it("uses the given no-password amount", () => {
    expect(classifyWalletCall("payLightningInvoice", args, 5000)).toEqual({ kind: "needs-auth" });
    expect(classifyWalletCall("payLightningInvoice", args, 5001)).toEqual({ kind: "capped", amountSats: 5000 });
    expect(classifyWalletCall("payLightningInvoice", args)).toEqual({ kind: "capped", amountSats: 5000 });
  });
  it("budget cap changes in place and canReserve does not charge", () => {
    const b = createUnauthorizedSpendBudget(1000, SPEND_WINDOW_MS);
    expect(b.tryReserve(600, NOW)).toBe(true);
    expect(b.canReserve(400, NOW)).toBe(true);
    expect(b.canReserve(400, NOW)).toBe(true);
    b.setCap(900);
    expect(b.canReserve(400, NOW)).toBe(false);
    expect(b.tryReserve(300, NOW)).toBe(true);
  });
});
