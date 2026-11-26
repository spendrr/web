import { describe, expect, it } from "vitest";
import { isTillSale, setTillSale } from "../src/lib/pos/tillSale";

describe("tillSale", () => {
  it("knows only the invoice the till is showing", () => {
    setTillSale(null);
    expect(isTillSale("a")).toBe(false);
    setTillSale("a");
    expect(isTillSale("a")).toBe(true);
    expect(isTillSale("b")).toBe(false);
    setTillSale(null);
    expect(isTillSale("a")).toBe(false);
  });
});
