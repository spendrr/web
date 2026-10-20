// Fuzz/integrity tests for src/lib/i18n.ts's plain string-interpolation and
// dictionary. tf() feeds directly into toast/banner text, so it should never
// throw or leave a template placeholder unresolved when a value is provided.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { CHANGELOG, changelogItemText } from "../src/lib/changelog";
import { __I18N_DICT, localeFor, tf } from "../src/lib/i18n";

describe("tf", () => {
  it("never throws for arbitrary templates and values", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        fc.dictionary(fc.string({ maxLength: 20 }), fc.oneof(fc.string({ maxLength: 50 }), fc.integer())),
        (template, vars) => {
          expect(() => tf(template, vars)).not.toThrow();
        },
      ),
    );
  });

  it("substitutes every placeholder present in vars", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }).filter((s) => /^[A-Za-z]+$/.test(s)), fc.integer(), (key, value) => {
        const result = tf(`prefix {${key}} suffix`, { [key]: value });
        expect(result).toBe(`prefix ${value} suffix`);
        expect(result).not.toContain(`{${key}}`);
      }),
    );
  });

  it("leaves an unresolved placeholder as an empty gap rather than throwing", () => {
    expect(tf("hello {missing}!", {})).toBe("hello !");
  });
});

describe("localeFor", () => {
  it("only ever returns one of the two known locale tags", () => {
    fc.assert(
      fc.property(fc.constantFrom("cs", "en") as fc.Arbitrary<"cs" | "en">, (lang) => {
        expect(["cs-CZ", "en-US"]).toContain(localeFor(lang));
      }),
    );
  });
});

describe("translation dictionary integrity", () => {
  it("has no empty keys or values", () => {
    for (const [key, value] of Object.entries(__I18N_DICT)) {
      expect(key.length).toBeGreaterThan(0);
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("has no key translating to itself (a likely copy-paste leftover)", () => {
    // A handful of entries are genuinely identical in both languages —
    // English loanwords already used as-is in the Czech UI text, not a
    // missed translation. Named explicitly here (rather than skipped
    // silently) so this stays a real check: an entry landing in this set by
    // accident is now a one-line diff away from being caught by a reviewer,
    // instead of the test just going quiet on every future identical entry.
    const intentionallyIdentical = new Set([
      "On-chain",
      "Beta",
      "Lightning",
      "SELF CUSTODIAL",
      "Bitcoin.",
      "Beta: Utility hub — Point of Sale",
      "Motion design (beta)",
    ]);
    const identical = Object.entries(__I18N_DICT).filter(
      ([k, v]) => k === v && !intentionallyIdentical.has(k),
    );
    expect(identical).toEqual([]);
  });

  it("has an English translation for every changelog.ts title and item", () => {
    // WhatsNewModal and Settings → O peněžence → Zobrazit changelog render
    // every CHANGELOG title/item through t(), so a new entry with no
    // matching dictionary key would silently fall back to Czech in the
    // English UI. This pins that every string in the changelog is covered.
    const missing: string[] = [];
    for (const entry of CHANGELOG) {
      if (!(entry.title in __I18N_DICT)) missing.push(entry.title);
      for (const item of entry.items) {
        const text = changelogItemText(item);
        if (!(text in __I18N_DICT)) missing.push(text);
      }
    }
    expect(missing).toEqual([]);
  });
});
