// Tests for src/lib/gift/giftPassword.ts — the auto-generated vault password for
// gift-link recipients.
import { describe, expect, it } from "vitest";
import { formatGiftPassword, generateGiftPassword, normalizeGiftPassword } from "../src/lib/gift/giftPassword";

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]+$/;

describe("generateGiftPassword", () => {
  it("produces 12 Crockford symbols grouped in 4s", () => {
    for (let i = 0; i < 1000; i++) {
      const pw = generateGiftPassword();
      const bare = normalizeGiftPassword(pw);
      expect(bare).toHaveLength(12);
      expect(bare).toMatch(CROCKFORD);
      expect(pw).toBe(formatGiftPassword(bare));
      expect(pw.split("-").every((g) => g.length === 4)).toBe(true);
    }
  });

  it("has full symbol spread and no collisions across many draws", () => {
    const seen = new Set<string>();
    const symbols = new Set<string>();
    for (let i = 0; i < 3000; i++) {
      const pw = normalizeGiftPassword(generateGiftPassword());
      seen.add(pw);
      for (const c of pw) symbols.add(c);
    }
    expect(seen.size).toBe(3000);
    // 60 bits over 3000 draws (36000 symbols) should touch most of the 32-symbol alphabet.
    expect(symbols.size).toBeGreaterThan(28);
  });
});

describe("normalizeGiftPassword", () => {
  it("strips grouping and whitespace and upper-cases", () => {
    expect(normalizeGiftPassword("k7qf-9m2t xw04")).toBe("K7QF9M2TXW04");
    expect(normalizeGiftPassword("  ABCD-EFGH  ")).toBe("ABCDEFGH");
  });

  it("round-trips a generated password through format/normalize", () => {
    for (let i = 0; i < 200; i++) {
      const pw = generateGiftPassword();
      expect(formatGiftPassword(normalizeGiftPassword(pw))).toBe(pw);
    }
  });
});
