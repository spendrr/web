import { describe, expect, it } from "vitest";
import { acceptLimitText, parseLimitAmount, sanitizeLimitText } from "../src/lib/send/limitAmount";

describe("parseLimitAmount", () => {
  it("takes plain amounts, with a comma or a dot, and grouped with spaces", () => {
    expect(parseLimitAmount("5", true)).toBe(5);
    expect(parseLimitAmount("5,5", true)).toBe(5.5);
    expect(parseLimitAmount("5.25", true)).toBe(5.25);
    expect(parseLimitAmount("5 000", true)).toBe(5000);
    expect(parseLimitAmount("5 000", true)).toBe(5000);
    expect(parseLimitAmount("  7  ", true)).toBe(7);
    expect(parseLimitAmount("00012", true)).toBe(12);
  });
  it("refuses everything Number() would let through", () => {
    for (const bad of ["1e3", "5e-3", "0x10", "0b11", "0o7", "Infinity", "NaN", "+5", "-5", "5.", ".5", "5,5,5", "1.5.2", "abc", "", " ", "１２", "٣"]) {
      expect(parseLimitAmount(bad, true), bad).toBeNull();
    }
  });
  it("refuses more than two decimals and more than nine digits", () => {
    expect(parseLimitAmount("5,123", true)).toBeNull();
    expect(parseLimitAmount("1234567890", true)).toBeNull();
    expect(parseLimitAmount("999999999", true)).toBe(999_999_999);
  });
  it("takes no decimals in sats", () => {
    expect(parseLimitAmount("2500", false)).toBe(2500);
    expect(parseLimitAmount("2,5", false)).toBeNull();
  });
});

describe("sanitizeLimitText", () => {
  it("tidies the structure of what is allowed", () => {
    expect(sanitizeLimitText("5,5,5", true)).toBe("5,55");
    expect(sanitizeLimitText(",5", true)).toBe("5");
    expect(sanitizeLimitText("5,12345", true)).toBe("5,12");
    expect(sanitizeLimitText("12345678901234", true)).toBe("123456789");
    expect(sanitizeLimitText("   ", true)).toBe("");
  });
  it("allows no decimal separator in sats", () => {
    expect(sanitizeLimitText("2,500.5", false)).toBe("25005");
  });
  it("keeps grouping spaces inside the integer part only", () => {
    expect(sanitizeLimitText("5 000", true)).toBe("5 000");
    expect(sanitizeLimitText("5,5 5", true)).toBe("5,55");
  });
});

describe("acceptLimitText", () => {
  it("refuses a change that is not a plain amount, whole, and keeps the field", () => {
    for (const bad of ["1e3", "0x10", "0b11", "-5", "+5", "abc", "5e-3", "Infinity", "１２", "٣", "5€", "5,5,5", "1.5.2", ",5", "5,123", "1234567890"]) {
      expect(acceptLimitText(bad, "42", true), bad).toBe("42");
    }
  });
  it("refuses a decimal separator in sats", () => {
    expect(acceptLimitText("2,5", "25", false)).toBe("25");
  });
  it("lets a normal edit through", () => {
    expect(acceptLimitText("425", "42", true)).toBe("425");
    expect(acceptLimitText("4,25", "4,2", true)).toBe("4,25");
    expect(acceptLimitText("5 000", "5 00", true)).toBe("5 000");
    expect(acceptLimitText("5,", "5", true)).toBe("5,");
    expect(acceptLimitText("", "42", true)).toBe("");
    // a trailing space is kept: it is how "5 000" is typed
    expect(acceptLimitText("  7  ", "", true)).toBe("7  ");
  });
});
