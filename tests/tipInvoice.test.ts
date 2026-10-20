import { describe, expect, it } from "vitest";
import { parseTipAmount, readTipResponse, satsForFiat } from "../src/lib/names/tipInvoice";

const origin = "https://spendrr.app";
const pr = "lnbc10u1pabcdefghjklmnpqrstuvwxyz0123456789";

describe("parseTipAmount", () => {
  it("accepts whole sats within bounds, with spaces", () => {
    expect(parseTipAmount("1 000")).toBe(1000);
    expect(parseTipAmount("100")).toBe(100);
    expect(parseTipAmount("1000000")).toBe(1_000_000);
  });
  it("rejects out of range and junk", () => {
    for (const bad of ["", "99", "1000001", "1.5", "-5", "abc", "1e3", "12345678"]) expect(parseTipAmount(bad)).toBeNull();
  });
});

describe("readTipResponse", () => {
  it("takes an invoice and a same-origin verify URL", () => {
    const r = readTipResponse({ pr, verify: `${origin}/api/lnurlp/verify/${"a".repeat(64)}` }, origin);
    expect(r).toMatchObject({ ok: true, invoice: { pr } });
    expect(r.ok && r.invoice.verify).not.toBeNull();
  });
  it("drops a verify URL on another origin or path", () => {
    const other = readTipResponse({ pr, verify: "https://evil.example/api/lnurlp/verify/x" }, origin);
    const path = readTipResponse({ pr, verify: `${origin}/api/names/set` }, origin);
    expect(other.ok && other.invoice.verify).toBeNull();
    expect(path.ok && path.invoice.verify).toBeNull();
  });
  it("surfaces the worker's reason", () => {
    expect(readTipResponse({ status: "ERROR", reason: "Dočasně nedostupné." }, origin)).toEqual({
      ok: false,
      reason: "Dočasně nedostupné.",
    });
  });
  it("rejects a non-invoice", () => {
    expect(readTipResponse({ pr: "hello" }, origin)).toEqual({ ok: false, reason: null });
    expect(readTipResponse(null, origin)).toEqual({ ok: false, reason: null });
  });
});

describe("satsForFiat", () => {
  it("converts at the given price", () => {
    expect(satsForFiat("5", 100_000)).toBe(5000);
    expect(satsForFiat("2,50", 100_000)).toBe(2500);
  });
  it("rejects junk, zero and out of bounds", () => {
    for (const bad of ["", "abc", "0", "-1", "1.234", "0.01", "9999999"]) expect(satsForFiat(bad, 100_000)).toBeNull();
    expect(satsForFiat("5", 0)).toBeNull();
  });
});
