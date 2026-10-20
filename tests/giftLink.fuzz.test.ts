// Fuzz + round-trip tests for src/lib/gift/giftLink.ts. decodeGiftFragment is the
// first thing an untrusted, pasted URL touches on the claim path, so it must
// never throw regardless of input.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  buildGiftUrl,
  decodeGiftFragment,
  encodeGiftFragment,
  generateGiftId,
  isGiftPath,
  GIFT_PATH,
} from "../src/lib/gift/giftLink";

const wordArb = fc
  .array(fc.constantFrom("abandon", "ability", "able", "about", "above", "absent", "zoo", "zone"), {
    minLength: 12,
    maxLength: 24,
  })
  .map((w) => w.join(" "));

const paramsArb = fc.record({
  mnemonic: wordArb,
  amountSats: fc.integer({ min: 1, max: 2_100_000_000_000 }),
  message: fc.option(fc.string({ maxLength: 300 }), { nil: undefined }),
  id: fc.constant(null).map(() => generateGiftId()),
});

describe("decodeGiftFragment", () => {
  it("never throws for arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 4000 }), (input) => {
        expect(() => decodeGiftFragment(input)).not.toThrow();
        expect(() => decodeGiftFragment("#" + input)).not.toThrow();
      }),
    );
  });

  it("round-trips valid params", () => {
    fc.assert(
      fc.property(paramsArb, (params) => {
        const res = decodeGiftFragment(encodeGiftFragment(params));
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.gift.mnemonic).toBe(params.mnemonic);
          expect(res.gift.amountSats).toBe(params.amountSats);
          expect(res.gift.id).toBe(params.id);
          // message is truncated to 140 chars on encode
          expect(res.gift.message ?? "").toBe((params.message ?? "").slice(0, 140));
        }
      }),
    );
  });

  it("rejects an unknown version", () => {
    const frag = encodeGiftFragment({
      mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      amountSats: 1000,
      id: generateGiftId(),
    }).replace("v=1", "v=2");
    expect(decodeGiftFragment(frag)).toEqual({ ok: false, reason: "bad-version" });
  });

  it("flags a fragment with neither v nor g as not-a-gift-link", () => {
    expect(decodeGiftFragment("#foo=bar&baz=1")).toEqual({ ok: false, reason: "not-a-gift-link" });
    expect(decodeGiftFragment("")).toEqual({ ok: false, reason: "not-a-gift-link" });
  });

  it("rejects non-positive / non-integer / unsafe amounts", () => {
    for (const a of ["0", "-5", "1.5", "abc", "1e999", String(Number.MAX_SAFE_INTEGER + 2)]) {
      const frag = `#v=1&g=${encodeGiftFragment({
        mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        amountSats: 1,
        id: "aa",
      })
        .match(/g=([^&]+)/)![1]}&a=${a}&id=aa`;
      expect(decodeGiftFragment(frag).ok).toBe(false);
    }
  });

  it("rejects a mnemonic of the wrong shape", () => {
    for (const m of ["too short", "WORDS IN CAPS ARE NOT VALID HERE OK OK OK OK OK OK", "has123 digits inside foo bar baz qux quux corge grault garply"]) {
      const frag = encodeGiftFragment({ mnemonic: "placeholder", amountSats: 1, id: "aa" });
      // swap in the bad mnemonic by re-encoding
      const bad = frag.replace(/g=[^&]+/, "g=" + Buffer.from(m).toString("base64url"));
      expect(decodeGiftFragment(bad).ok).toBe(false);
    }
  });
});

describe("isGiftPath / buildGiftUrl", () => {
  it("recognizes the gift path", () => {
    expect(isGiftPath(GIFT_PATH)).toBe(true);
    expect(isGiftPath("/g/")).toBe(true);
    expect(isGiftPath("/")).toBe(false);
    expect(isGiftPath("/gift")).toBe(false);
  });

  it("builds a URL that decodes back", () => {
    fc.assert(
      fc.property(paramsArb, (params) => {
        const url = buildGiftUrl("https://wallet.example.org/", params);
        expect(url.startsWith("https://wallet.example.org/g#")).toBe(true);
        const hash = url.slice(url.indexOf("#"));
        expect(decodeGiftFragment(hash).ok).toBe(true);
      }),
    );
  });
});

describe("generateGiftId", () => {
  it("is 16 lowercase hex chars and unique across many calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const id = generateGiftId();
      expect(id).toMatch(/^[0-9a-f]{16}$/);
      seen.add(id);
    }
    expect(seen.size).toBe(5000);
  });
});

describe("passwordless flag", () => {
  const base = { mnemonic: "abandon ability able about above absent zoo zone abandon ability able about", amountSats: 1000, id: "0123456789abcdef" };

  it("round-trips when set", () => {
    const decoded = decodeGiftFragment(encodeGiftFragment({ ...base, passwordless: true }));
    expect(decoded.ok && decoded.gift.passwordless).toBe(true);
  });

  it("is absent, not false, for ordinary links", () => {
    for (const flag of [undefined, false]) {
      const decoded = decodeGiftFragment(encodeGiftFragment({ ...base, passwordless: flag }));
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect("passwordless" in decoded.gift).toBe(false);
    }
  });

  it("anything but n=1 does not turn it on", () => {
    const frag = encodeGiftFragment(base);
    for (const n of ["0", "true", "2", ""]) {
      const decoded = decodeGiftFragment(`${frag}&n=${n}`);
      expect(decoded.ok && decoded.gift.passwordless).toBeFalsy();
    }
  });
});
