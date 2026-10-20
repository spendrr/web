// Fuzz + regression tests for src/lib/vault/password.ts and the entropy estimator
// behind it (src/lib/vault/passwordStrength.ts) — the strength gate applied to
// both wallet creation and password change.
//
// The old version of this file asserted the character-class rules that used
// to be the gate ("rejects a password missing any single required class").
// Those assertions are gone because the rules are: a password is now judged
// by the cheapest way an attacker can decompose it, not by which classes it
// contains. The case that motivated the change is kept below as an explicit
// regression test — "Abcdefg1!" satisfied every old rule and is worth about
// 18 bits.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isPasswordStrong, passwordProblem, passwordStrengthLevel, PASSWORD_MIN_LENGTH } from "../src/lib/vault/password";
import { estimatePasswordStrength, MIN_PASSWORD_BITS } from "../src/lib/vault/passwordStrength";

describe("isPasswordStrong", () => {
  it("never throws for arbitrary input, including empty strings and huge strings", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 5000 }), (password) => {
        expect(() => isPasswordStrong(password)).not.toThrow();
        expect(() => passwordProblem(password)).not.toThrow();
        expect(() => passwordStrengthLevel(password)).not.toThrow();
      }),
      // Each run walks an O(n^2) DP over the (capped) analysis window, so
      // this is deliberately a smaller corpus than the pure-string tests
      // elsewhere in tests/.
      { numRuns: 200 },
    );
  });

  it("rejects anything shorter than the minimum length regardless of content", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: PASSWORD_MIN_LENGTH - 1 }), (password) => {
        expect(isPasswordStrong(password)).toBe(false);
      }),
    );
  });

  it("agrees with the estimator it wraps, above the length floor", () => {
    fc.assert(
      fc.property(fc.string({ minLength: PASSWORD_MIN_LENGTH, maxLength: 60 }), (password) => {
        expect(isPasswordStrong(password)).toBe(estimatePasswordStrength(password).ok);
      }),
      { numRuns: 200 },
    );
  });

  it("rejects the passwords the old character-class rule accepted", () => {
    // Every one of these passes "8+ chars, an uppercase, a digit, a special
    // character" and none of them survives a real cracking run.
    for (const weak of ["Abcdefg1!", "ABCDEFGH1!", "Password1!", "P@ssw0rd", "Heslo123!", "Qwertz12!", "Aaaaaaa1!"]) {
      expect(isPasswordStrong(weak), weak).toBe(false);
    }
  });

  it("accepts passphrases the old rule rejected for lacking a class", () => {
    for (const strong of ["correct horse battery staple", "MojeSuperTajneHeslo", "kytka-vlak-radio-buben"]) {
      expect(isPasswordStrong(strong), strong).toBe(true);
    }
  });

  it("accepts a short-but-genuinely-mixed password-manager style string", () => {
    for (const strong of ["J8#kL2p!Qz4", "Kx7#mQ2vLp", "zima-Modry-Kohout-42"]) {
      expect(isPasswordStrong(strong), strong).toBe(true);
    }
  });
});

describe("estimatePasswordStrength", () => {
  it("prices a blocklist word at close to nothing", () => {
    // Rank 2 in passwordBlocklist.ts, so log2(2) = 1 bit.
    expect(estimatePasswordStrength("password").bits).toBeLessThan(3);
  });

  it("sees through leet substitutions and capitalisation", () => {
    const plain = estimatePasswordStrength("bitcoin").bits;
    // A few bits more for the substitutions and the capital, nowhere near
    // the ~7 characters of bruteforce it would cost if unrecognised.
    expect(estimatePasswordStrength("B1tc01n").bits).toBeLessThan(plain + 8);
    expect(estimatePasswordStrength("B1tc01n").bits).toBeLessThan(25);
  });

  it("names the dominant weakness so the UI can explain the rejection", () => {
    expect(estimatePasswordStrength("abcdefghij").weakness).toBe("sequence");
    expect(estimatePasswordStrength("aaaaaaaaaa").weakness).toBe("repeat");
    // Deliberately none of "asdfghjkl" / "zxcvbnm" / "rtyuiop": the first
    // two are themselves blocklist entries and the third contains "yuiop"
    // (the reverse of the blocklist's "poiuy"), so "common" wins for all
    // three — correctly, since it's cheaper for the attacker, just not what
    // this line is testing.
    expect(estimatePasswordStrength("sdfghj").weakness).toBe("keyboard");
    expect(estimatePasswordStrength("password").weakness).toBe("common");
    expect(estimatePasswordStrength("19850612").weakness).toBe("date");
  });

  it("never claims more than plain bruteforce over the whole password", () => {
    // The one hard upper bound the model does guarantee: a single
    // bruteforce edge spanning the entire password is always available to
    // the shortest-path search, so the answer can never exceed it. A
    // violation would mean a matcher priced a *pattern* above what simply
    // enumerating the character set costs, i.e. the estimate had stopped
    // being a lower bound on the attacker's work.
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 60 }), (password) => {
        const classes =
          (/[a-z]/.test(password) ? 26 : 0) +
          (/[A-Z]/.test(password) ? 26 : 0) +
          (/[0-9]/.test(password) ? 10 : 0) +
          (/[ !-/:-@[-`{-~]/.test(password) ? 33 : 0) +
          (/[^\x20-\x7e]/.test(password) ? 100 : 0);
        const ceiling = password.length * Math.log2(Math.max(classes, 1));
        expect(estimatePasswordStrength(password).bits).toBeLessThanOrEqual(ceiling + 1e-9);
      }),
      { numRuns: 200 },
    );
  });

  it("is deliberately NOT monotone in length", () => {
    // Worth pinning down rather than leaving as a surprise: appending a
    // character can *lower* the estimate when it completes a pattern. " Cx"
    // is priced as two bruteforce stretches; " CxY" is a space plus a
    // keyboard run, because c-x-y are three adjacent keys on the Czech
    // qwertz layout (the mirror of z-x-c on qwerty). That's the model being
    // right, not a matcher over-claiming — the longer string genuinely is
    // cheaper to guess — so no test should assert monotonicity.
    expect(estimatePasswordStrength(" CxY").bits).toBeLessThan(estimatePasswordStrength(" Cx").bits);
  });

  it("never credits the part of a long password past the analysis window", () => {
    // The cap exists so a cheap pattern repeated forever can't be topped up
    // to passing by a huge uncounted tail. 200 identical characters is the
    // case that would otherwise slip through.
    expect(isPasswordStrong("a".repeat(200))).toBe(false);
    expect(isPasswordStrong("ab".repeat(100))).toBe(false);
  });

  it("stays fast on long repeated input, its worst case", () => {
    // Every (start, unit length) pair of a repeated run is a repeat, and each
    // used to re-price its unit from scratch at every recursion level:
    // "a".repeat(96) took ~2s (on the main thread, per keystroke), and this
    // file's test above timed out in CI. The units are now priced once per
    // estimate (repeatMatches' memo). Measured ~0.2s for all of these
    // together, ~40s before; the bound only has to catch the blow-up, not be
    // tight.
    const worst = ["a".repeat(96), "ab".repeat(48), "abc".repeat(32), "aab".repeat(32), "1".repeat(300)];
    const t0 = performance.now();
    for (const p of worst) estimatePasswordStrength(p);
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it("puts the threshold and the level indicator on the same side of the line", () => {
    fc.assert(
      fc.property(fc.string({ minLength: PASSWORD_MIN_LENGTH, maxLength: 40 }), (password) => {
        const { bits } = estimatePasswordStrength(password);
        const level = passwordStrengthLevel(password);
        if (bits >= MIN_PASSWORD_BITS) expect(level).toBeGreaterThanOrEqual(3);
        else expect(level).toBeLessThanOrEqual(2);
      }),
      { numRuns: 200 },
    );
  });
});

describe("passwordProblem", () => {
  it("says nothing about an empty field and nothing about an accepted password", () => {
    expect(passwordProblem("")).toBeNull();
    expect(passwordProblem("correct horse battery staple")).toBeNull();
  });

  it("always explains a rejection", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), (password) => {
        if (!isPasswordStrong(password)) expect(passwordProblem(password)).not.toBeNull();
      }),
      { numRuns: 200 },
    );
  });
});
