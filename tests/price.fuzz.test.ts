// Fuzz tests for src/lib/price.ts's pure conversion/formatting helpers —
// these run on every balance render, fed by a live external rate.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { fiatToSats, formatFiat, satsToFiat } from "../src/lib/price";

const finiteNonNegative = fc.double({ min: 0, max: 1e15, noNaN: true, noDefaultInfinity: true });

describe("satsToFiat / fiatToSats", () => {
  it("never throws or produces NaN for finite, positive inputs", () => {
    fc.assert(
      fc.property(finiteNonNegative, fc.double({ min: 0.0001, max: 1e9, noNaN: true }), (sats, rate) => {
        const fiat = satsToFiat(sats, rate);
        expect(Number.isNaN(fiat)).toBe(false);
        const back = fiatToSats(fiat, rate);
        expect(Number.isNaN(back)).toBe(false);
      }),
    );
  });

  it("satsToFiat is monotonically non-decreasing in sats for a fixed positive rate", () => {
    fc.assert(
      fc.property(finiteNonNegative, finiteNonNegative, fc.double({ min: 0.0001, max: 1e9, noNaN: true }), (a, b, rate) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(satsToFiat(lo, rate)).toBeLessThanOrEqual(satsToFiat(hi, rate));
      }),
    );
  });
});

describe("formatFiat", () => {
  it("never throws for arbitrary finite amounts across all supported currencies", () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, min: -1e12, max: 1e12 }),
        fc.constantFrom("czk", "eur", "usd") as fc.Arbitrary<"czk" | "eur" | "usd">,
        (amount, currency) => {
          expect(() => formatFiat(amount, currency)).not.toThrow();
        },
      ),
    );
  });
});
