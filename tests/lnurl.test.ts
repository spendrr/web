import { describe, expect, it } from "vitest";
import {
  MAX_COMMENT_CHARS,
  MAX_SENDABLE_MSAT,
  MIN_SENDABLE_MSAT,
  buildPayRequest,
  buildVerifyResponse,
  isPlausiblePaymentHash,
  lnAddressMetadataString,
  parseCallbackAmountMsat,
  parseCallbackComment,
} from "../worker/lnurl";

describe("parseCallbackAmountMsat", () => {
  it("accepts a whole-sat amount within bounds", () => {
    expect(parseCallbackAmountMsat("100000")).toEqual({ ok: true, sats: 100 });
    expect(parseCallbackAmountMsat(String(MIN_SENDABLE_MSAT))).toEqual({ ok: true, sats: MIN_SENDABLE_MSAT / 1000 });
    expect(parseCallbackAmountMsat(String(MAX_SENDABLE_MSAT))).toEqual({ ok: true, sats: MAX_SENDABLE_MSAT / 1000 });
  });

  it("rejects missing, non-numeric, fractional-sat, and out-of-range amounts", () => {
    expect(parseCallbackAmountMsat(null)).toEqual({ ok: false, problem: "missing" });
    expect(parseCallbackAmountMsat("")).toEqual({ ok: false, problem: "missing" });
    expect(parseCallbackAmountMsat("abc")).toEqual({ ok: false, problem: "not-a-number" });
    expect(parseCallbackAmountMsat("-1000")).toEqual({ ok: false, problem: "not-a-number" });
    expect(parseCallbackAmountMsat("1500")).toEqual({ ok: false, problem: "not-whole-sats" });
    expect(parseCallbackAmountMsat(String(MIN_SENDABLE_MSAT - 1000))).toEqual({ ok: false, problem: "too-small" });
    expect(parseCallbackAmountMsat(String(MAX_SENDABLE_MSAT + 1000))).toEqual({ ok: false, problem: "too-large" });
  });

  it("never lets an unsafe integer through", () => {
    expect(parseCallbackAmountMsat("9007199254740993000")).toEqual({ ok: false, problem: "not-a-number" });
  });
});

describe("parseCallbackComment", () => {
  it("treats absence as no comment", () => {
    expect(parseCallbackComment(null)).toEqual({ ok: true, comment: null });
    expect(parseCallbackComment("")).toEqual({ ok: true, comment: null });
  });

  it("accepts up to the LUD-12 limit and rejects past it", () => {
    const atLimit = "x".repeat(MAX_COMMENT_CHARS);
    expect(parseCallbackComment(atLimit)).toEqual({ ok: true, comment: atLimit });
    expect(parseCallbackComment(atLimit + "x")).toEqual({ ok: false });
  });
});

describe("buildPayRequest", () => {
  it("builds a LUD-06 payRequest pointing at this origin's callback", () => {
    const req = buildPayRequest("pavel", "https://spendrr.app");
    expect(req.tag).toBe("payRequest");
    expect(req.callback).toBe("https://spendrr.app/api/lnurlp/pavel/cb");
    expect(req.minSendable).toBe(MIN_SENDABLE_MSAT);
    expect(req.maxSendable).toBe(MAX_SENDABLE_MSAT);
    expect(req.commentAllowed).toBe(MAX_COMMENT_CHARS);
    expect(JSON.parse(req.metadata)).toEqual([
      ["text/plain", "Platba pro @pavel (Spendrr)"],
      ["text/identifier", "pavel@spendrr.app"],
    ]);
  });

  it("derives the LN-address domain from the request's own origin", () => {
    expect(lnAddressMetadataString("pavel", "https://staging.example.com")).toContain("pavel@staging.example.com");
  });
});

describe("buildVerifyResponse", () => {
  it("never carries a preimage for an unsettled invoice", () => {
    const res = buildVerifyResponse({ settled: false, preimage: null, pr: "lnbc1..." });
    expect(res).toEqual({ status: "OK", settled: false, preimage: null, pr: "lnbc1..." });
  });

  it("carries the preimage once settled", () => {
    const res = buildVerifyResponse({ settled: true, preimage: "ab".repeat(32), pr: "lnbc1..." });
    expect(res.settled).toBe(true);
    expect(res.preimage).toBe("ab".repeat(32));
  });
});

describe("isPlausiblePaymentHash", () => {
  it("accepts exactly 64 lowercase hex chars", () => {
    expect(isPlausiblePaymentHash("a".repeat(64))).toBe(true);
    expect(isPlausiblePaymentHash("A".repeat(64))).toBe(false);
    expect(isPlausiblePaymentHash("a".repeat(63))).toBe(false);
    expect(isPlausiblePaymentHash("a".repeat(65))).toBe(false);
    expect(isPlausiblePaymentHash("g".repeat(64))).toBe(false);
  });
});
