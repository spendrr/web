// Fuzz + round-trip tests for src/lib/send/paymentRequest.ts. Like the gift-link
// decoder, decodeRequestFragment is the first thing an untrusted, pasted URL
// touches, so it must never throw regardless of input — and unlike the gift
// decoder it has an "at least one payable field" rule that is easy to
// regress into "a link that looks fine and can pay nothing".
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  buildRequestUrl,
  decodeRequestFragment,
  encodeRequestFragment,
  generateRequestId,
  isInvoiceExpired,
  isRequestPath,
  REQUEST_PATH,
} from "../src/lib/send/paymentRequest";

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l".split("");

const addressArb = fc
  .array(fc.constantFrom(...BECH32), { minLength: 40, maxLength: 120 })
  .map((c) => "ark1" + c.join(""));

const invoiceArb = fc
  .array(fc.constantFrom(...BECH32), { minLength: 40, maxLength: 300 })
  .map((c) => "lnbc2500u1" + c.join(""));

const paramsArb = fc.record({
  address: fc.option(addressArb, { nil: undefined }),
  invoice: fc.option(invoiceArb, { nil: undefined }),
  amountSats: fc.integer({ min: 1, max: 2_100_000_000_000 }),
  note: fc.option(fc.string({ maxLength: 300 }), { nil: undefined }),
  id: fc.constant(null).map(() => generateRequestId()),
  // At least one payable field, or the link is deliberately rejected.
}).filter((p) => !!(p.address || p.invoice));

describe("decodeRequestFragment", () => {
  it("never throws for arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 4000 }), (input) => {
        expect(() => decodeRequestFragment(input)).not.toThrow();
        expect(() => decodeRequestFragment("#" + input)).not.toThrow();
      }),
    );
  });

  it("round-trips valid params", () => {
    fc.assert(
      fc.property(paramsArb, (params) => {
        const decoded = decodeRequestFragment(encodeRequestFragment(params));
        expect(decoded.ok).toBe(true);
        if (!decoded.ok) return;
        expect(decoded.request.amountSats).toBe(params.amountSats);
        expect(decoded.request.id).toBe(params.id);
        expect(decoded.request.address).toBe(params.address);
        expect(decoded.request.invoice).toBe(params.invoice);
        // The note is capped, never rejected.
        expect(decoded.request.note ?? "").toBe((params.note ?? "").slice(0, 140));
      }),
    );
  });

  it("rejects a link with neither an address nor an invoice", () => {
    const frag = encodeRequestFragment({ amountSats: 1000, id: generateRequestId() });
    const decoded = decodeRequestFragment(frag);
    expect(decoded).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a non-positive or non-integer amount", () => {
    for (const a of ["0", "-1", "1.5", "abc", "1e3", ""]) {
      const decoded = decodeRequestFragment(`#v=1&a=${a}&id=abcd&d=ark1qqqq`);
      expect(decoded.ok).toBe(false);
    }
  });

  it("rejects an unknown version rather than guessing", () => {
    expect(decodeRequestFragment("#v=2&a=100&id=ab&d=ark1qqqq")).toEqual({ ok: false, reason: "bad-version" });
  });

  it("reports a fragment with none of its fields as not-a-request-link", () => {
    expect(decodeRequestFragment("#hello=world")).toEqual({ ok: false, reason: "not-a-request-link" });
  });

  it("rejects an address or invoice that is not bech32-shaped", () => {
    expect(decodeRequestFragment("#v=1&a=100&id=ab&d=bc1qwhatever").ok).toBe(false);
    // "b", "i", "o" and "1" are outside bech32's data alphabet.
    expect(decodeRequestFragment("#v=1&a=100&id=ab&d=ark1bio").ok).toBe(false);
    expect(decodeRequestFragment("#v=1&a=100&id=ab&ln=lntb1qqqq").ok).toBe(false);
  });

  it("keeps a payable link payable when only the expiry is junk", () => {
    const decoded = decodeRequestFragment("#v=1&a=100&id=ab&d=ark1qqqqqq&x=notanumber");
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.request.invoiceExpiresAt).toBeUndefined();
  });

  it("round-trips the invoice expiry to whole seconds", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4_000_000_000 }), (secs) => {
        const frag = encodeRequestFragment({
          amountSats: 100,
          id: "ab",
          address: "ark1qqqqqq",
          invoiceExpiresAt: secs * 1000,
        });
        const decoded = decodeRequestFragment(frag);
        expect(decoded.ok).toBe(true);
        if (!decoded.ok) return;
        expect(decoded.request.invoiceExpiresAt).toBe(secs * 1000);
      }),
    );
  });
});

describe("isInvoiceExpired", () => {
  it("is false when no expiry is known", () => {
    expect(isInvoiceExpired({ amountSats: 1, id: "a", address: "ark1qq" })).toBe(false);
  });

  it("flips exactly at the deadline", () => {
    const req = { amountSats: 1, id: "a", address: "ark1qq", invoiceExpiresAt: 1000 };
    expect(isInvoiceExpired(req, 999)).toBe(false);
    expect(isInvoiceExpired(req, 1000)).toBe(true);
  });
});

describe("buildRequestUrl / isRequestPath", () => {
  it("builds a URL on REQUEST_PATH that isRequestPath accepts", () => {
    fc.assert(
      fc.property(paramsArb, (params) => {
        const url = new URL(buildRequestUrl("https://spendrr.app", params));
        expect(isRequestPath(url.pathname)).toBe(true);
        expect(url.pathname).toBe(REQUEST_PATH);
      }),
    );
  });

  it("tolerates a trailing slash on the origin without doubling it", () => {
    const url = buildRequestUrl("https://spendrr.app///", { amountSats: 1, id: "a", address: "ark1qq" });
    expect(url.startsWith("https://spendrr.app/r#")).toBe(true);
  });

  it("does not accept a neighbouring path", () => {
    expect(isRequestPath("/g")).toBe(false);
    expect(isRequestPath("/receive")).toBe(false);
    expect(isRequestPath("/r/")).toBe(true);
  });
});
