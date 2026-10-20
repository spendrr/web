import { describe, expect, it, beforeEach } from "vitest";
import fc from "fast-check";
import {
  EMPTY_DRAFT,
  applyKey,
  convertFiat,
  formatEntry,
  receiptLines,
  saleDescription,
  saleTotal,
  totalSats,
  DESCRIPTION_MAX,
  type PosDraft,
} from "../src/lib/pos/posSale";
import { loadPosItems, type PosItem } from "../src/lib/pos/posItems";
import { fiatToSats, formatFiat } from "../src/lib/price";

const rates = { czk: 2_400_000, eur: 95_000, usd: 110_000 };
const items: PosItem[] = [
  { id: "a", name: "Espresso", price: 55, currency: "czk" },
  { id: "b", name: "Cappuccino", price: 75, currency: "czk" },
  { id: "c", name: "Croissant", price: 2.5, currency: "eur" },
];

describe("saleTotal", () => {
  it("is everything on the receipt plus the amount still being typed", () => {
    // The live bug: display showed "26 Kč", invoice was for 286 Kč.
    const draft: PosDraft = { cart: { a: 2, b: 2 }, custom: [], entry: "26" };
    const lines = receiptLines(draft, items, "czk", rates, "Částka");
    const total = saleTotal(lines, draft.entry);
    expect(total).toBe(286);
    expect(totalSats(total, "czk", rates)).toBe(fiatToSats(286, rates.czk));
  });

  it("keeps an item priced in Kč in Kč when the display currency changes", () => {
    const draft: PosDraft = { cart: { a: 1 }, custom: [], entry: "" };
    const lines = receiptLines(draft, items, "eur", rates, "Částka");
    expect(lines[0].amount).toBe(55);
    expect(lines[0].currency).toBe("czk");
    const total = saleTotal(lines, "")!;
    expect(total).toBeCloseTo((55 * rates.eur) / rates.czk, 10);
    // Same sats either way: the price means 55 Kč whatever the till shows.
    expect(totalSats(total, "eur", rates)).toBe(fiatToSats(55, rates.czk));
  });

  it("is exact without rates when everything is in the till's currency", () => {
    const draft: PosDraft = { cart: { a: 1, b: 1 }, custom: [{ id: "x", amount: 10, currency: "czk" }], entry: "" };
    expect(saleTotal(receiptLines(draft, items, "czk", null, "Částka"), "")).toBe(140);
  });

  it("refuses to guess when a needed rate is missing", () => {
    const draft: PosDraft = { cart: { c: 1 }, custom: [], entry: "" };
    expect(saleTotal(receiptLines(draft, items, "czk", null, "Částka"), "")).toBeNull();
    expect(totalSats(null, "czk", rates)).toBe(0);
  });

  it("ignores cart entries for items that were deleted", () => {
    const draft: PosDraft = { cart: { gone: 3, a: 1 }, custom: [], entry: "" };
    expect(saleTotal(receiptLines(draft, items, "czk", rates, "Částka"), "")).toBe(55);
  });

  it("empty draft totals zero", () => {
    expect(saleTotal(receiptLines(EMPTY_DRAFT, items, "czk", rates, "Částka"), "")).toBe(0);
  });
});

describe("convertFiat", () => {
  it("round-trips", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.01, max: 1e6, noNaN: true }), (amount) => {
        const eur = convertFiat(amount, "czk", "eur", rates)!;
        expect(convertFiat(eur, "eur", "czk", rates)!).toBeCloseTo(amount, 6);
      }),
    );
  });
});

describe("applyKey", () => {
  it("has no decimals for CZK and a 00 key instead", () => {
    expect(applyKey("12", ".", "czk")).toBe("12");
    expect(applyKey("12", "00", "czk")).toBe("1200");
    expect(applyKey("", "00", "czk")).toBe("");
  });

  it("allows two decimals for EUR", () => {
    let e = "";
    for (const k of ["1", "2", ".", "5", "0", "9"]) e = applyKey(e, k, "eur");
    expect(e).toBe("12.50");
    expect(applyKey("", ".", "eur")).toBe("0.");
    expect(applyKey("1.5", ".", "eur")).toBe("1.5");
  });

  it("replaces a leading zero and caps the length", () => {
    expect(applyKey("0", "7", "czk")).toBe("7");
    let e = "";
    for (let i = 0; i < 20; i++) e = applyKey(e, "9", "czk");
    expect(e).toBe("9999999");
    expect(applyKey("999999", "00", "czk")).toBe("9999990");
  });

  it("always yields a parseable, non-negative number", () => {
    const keys = fc.constantFrom("0", "1", "5", "9", "00", ".", "back", "x");
    fc.assert(
      fc.property(fc.array(keys, { maxLength: 30 }), fc.constantFrom("czk", "eur", "usd") as fc.Arbitrary<"czk" | "eur" | "usd">, (seq, cur) => {
        let e = "";
        for (const k of seq) e = applyKey(e, k, cur);
        const n = Number(e || "0");
        expect(Number.isFinite(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThan(1e7);
        if (cur === "czk") expect(e).not.toContain(".");
      }),
    );
  });
});

describe("formatEntry", () => {
  it("groups thousands and uses a comma", () => {
    expect(formatEntry("")).toBe("0");
    expect(formatEntry("1250000")).toBe("1 250 000");
    expect(formatEntry("12.")).toBe("12,");
    expect(formatEntry("12.5")).toBe("12,5");
  });
});

describe("saleDescription", () => {
  it("lists items with quantities and custom amounts", () => {
    const draft: PosDraft = { cart: { a: 2, b: 1 }, custom: [{ id: "x", amount: 26, currency: "czk" }], entry: "" };
    const text = saleDescription(receiptLines(draft, items, "czk", rates, "Částka"), formatFiat);
    expect(text).toBe(`Espresso ×2, Cappuccino, ${formatFiat(26, "czk")}`);
  });

  it("never exceeds the cap", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1, maxLength: 60 }), { minLength: 1, maxLength: 12 }), (names) => {
        const many = names.map((name, i) => ({ id: String(i), name, price: 1, currency: "czk" as const }));
        const cart = Object.fromEntries(many.map((it) => [it.id, 1]));
        const text = saleDescription(receiptLines({ cart, custom: [], entry: "" }, many, "czk", rates, "Částka"), formatFiat);
        expect(text.length).toBeLessThanOrEqual(DESCRIPTION_MAX + 4);
      }),
    );
  });
});

describe("loadPosItems migration", () => {
  beforeEach(() => localStorage.clear());

  it("stamps legacy items with the currency active at first load, once", () => {
    localStorage.setItem("btc-wallet-pos-items", JSON.stringify([{ id: "a", name: "Espresso", price: 55 }]));
    expect(loadPosItems("czk")).toEqual([{ id: "a", name: "Espresso", price: 55, currency: "czk" }]);
    // A later currency switch no longer changes what the item costs.
    expect(loadPosItems("eur")[0].currency).toBe("czk");
  });

  it("drops malformed entries", () => {
    localStorage.setItem(
      "btc-wallet-pos-items",
      JSON.stringify([{ id: "a", name: "ok", price: 1, currency: "eur" }, { id: "b", name: "neg", price: -1 }, "junk", null]),
    );
    expect(loadPosItems("czk").map((i) => i.id)).toEqual(["a"]);
  });
});
