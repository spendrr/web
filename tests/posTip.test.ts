import { describe, expect, it } from "vitest";
import { addTip, describeWithTip, tipAmount, tipFits } from "../src/lib/pos/posTip";
import { MAX_SALE_TOTAL } from "../src/lib/pos/posSale";

describe("tipAmount", () => {
  it("rounds to whole koruny", () => {
    expect(tipAmount(185, 5, "czk")).toBe(9);
    expect(tipAmount(185, 10, "czk")).toBe(19);
    expect(tipAmount(185, 15, "czk")).toBe(28);
  });

  it("rounds to cents in euro and dollars", () => {
    expect(tipAmount(3.4, 5, "eur")).toBe(0.17);
    expect(tipAmount(12.99, 15, "usd")).toBe(1.95);
  });

  it("is zero for a tiny sale or nothing to tip", () => {
    expect(tipAmount(5, 5, "czk")).toBe(0);
    expect(tipAmount(0, 10, "czk")).toBe(0);
    expect(tipAmount(100, 0, "czk")).toBe(0);
  });
});

describe("addTip", () => {
  it("adds without float noise", () => {
    expect(addTip(0.1, 0.2, "eur")).toBe(0.3);
    expect(addTip(185, 19, "czk")).toBe(204);
  });

  it("takes the tip back out for the breakdown line", () => {
    expect(addTip(3.57, -0.17, "eur")).toBe(3.4);
  });
});

describe("tipFits", () => {
  it("keeps the sale within the till's limit", () => {
    expect(tipFits(100, 20, "czk")).toBe(true);
    expect(tipFits(MAX_SALE_TOTAL, 1, "czk")).toBe(false);
    expect(tipFits(100, -1, "czk")).toBe(false);
  });
});

describe("describeWithTip", () => {
  it("appends the tip to the items", () => {
    expect(describeWithTip("Espresso ×2, Cappuccino", "dýško 10 %")).toBe("Espresso ×2, Cappuccino, dýško 10 %");
  });

  it("is the tip alone for typed amounts", () => {
    expect(describeWithTip("", "dýško")).toBe("dýško");
  });

  it("is the summary without a tip", () => {
    expect(describeWithTip("Espresso", "")).toBe("Espresso");
  });
});
