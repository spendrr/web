// Regression: "İ" (U+0130) lower-cases to two code units, which used to push
// keyboard-run match indices past password.length and throw in solve().
import { describe, expect, it } from "vitest";
import { estimatePasswordStrength } from "../src/lib/vault/passwordStrength";
import { isPasswordStrong, passwordProblem } from "../src/lib/vault/password";

describe("passwords with characters whose lower-case changes length", () => {
  for (const pw of ["İqwerty", "aİqwertz", "İ1qaz2wsx", "qwertyİ", "İİİ"]) {
    it(`does not throw for ${JSON.stringify(pw)}`, () => {
      const r = estimatePasswordStrength(pw);
      expect(Number.isFinite(r.bits)).toBe(true);
      expect(() => passwordProblem(pw)).not.toThrow();
      expect(() => isPasswordStrong(pw)).not.toThrow();
    });
  }

  it("rejects İqwerty", () => {
    expect(estimatePasswordStrength("İqwerty").ok).toBe(false);
  });
});
