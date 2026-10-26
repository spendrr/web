import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  HANDLE_MAX_LENGTH,
  HANDLE_MIN_LENGTH,
  SUGGESTION_ADJECTIVES,
  SUGGESTION_BARE_ATTEMPTS,
  SUGGESTION_NOUNS,
  checkHandle,
  handleFromPath,
  handleFromProfileUrl,
  handleUrl,
  normalizeHandle,
  parseHandleDestination,
  suggestHandle,
} from "../src/lib/names/handle";

describe("checkHandle", () => {
  it("accepts ordinary handles, with or without the @ and in any case", () => {
    for (const raw of ["pavel", "@pavel", "Pavel", "spooky_scary", "anonymous-pea", "a1b", "x_y-z"]) {
      const r = checkHandle(raw);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.handle).toBe(normalizeHandle(raw));
    }
  });

  it("rejects the wrong length", () => {
    expect(checkHandle("")).toEqual({ ok: false, problem: "empty" });
    expect(checkHandle("@")).toEqual({ ok: false, problem: "empty" });
    expect(checkHandle("ab")).toEqual({ ok: false, problem: "too-short" });
    expect(checkHandle("a".repeat(HANDLE_MAX_LENGTH + 1))).toEqual({ ok: false, problem: "too-long" });
    expect(checkHandle("a".repeat(HANDLE_MAX_LENGTH)).ok).toBe(true);
    expect(checkHandle("a".repeat(HANDLE_MIN_LENGTH)).ok).toBe(true);
  });

  it("rejects diacritics, look-alike letters, spaces and punctuation", () => {
    for (const raw of ["pavél", "pаvel", "pa vel", "pavel!", "pavel.x", "pa@vel", "😀😀😀", "pavel​"]) {
      expect(checkHandle(raw)).toEqual({ ok: false, problem: "chars" });
    }
  });

  it("rejects a leading or trailing separator", () => {
    for (const raw of ["-pavel", "pavel-", "_pavel", "pavel_"]) {
      expect(checkHandle(raw)).toEqual({ ok: false, problem: "edge" });
    }
  });

  it("reserves the names of the app's own features and partners", () => {
    for (const raw of ["donate", "gift", "shop", "store", "voucher", "bitrefill", "@Gift"]) {
      expect(checkHandle(raw)).toEqual({ ok: false, problem: "reserved" });
      expect(checkHandle(raw, { allowReserved: true }).ok).toBe(true);
    }
  });

  it("rejects reserved names", () => {
    for (const raw of ["admin", "@Admin", "spendrr", "bitcoin"]) {
      expect(checkHandle(raw)).toEqual({ ok: false, problem: "reserved" });
    }
  });

  it("never throws, and anything it accepts is normalized and within limits", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (raw) => {
        const r = checkHandle(raw);
        if (r.ok) {
          expect(r.handle).toBe(normalizeHandle(raw));
          expect(r.handle.length).toBeGreaterThanOrEqual(HANDLE_MIN_LENGTH);
          expect(r.handle.length).toBeLessThanOrEqual(HANDLE_MAX_LENGTH);
          expect(r.handle).toMatch(/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/);
        }
      }),
    );
  });
});

describe("suggestHandle", () => {
  it("is deterministic for a seed and attempt", () => {
    expect(suggestHandle("ark1qabc")).toBe(suggestHandle("ark1qabc"));
    expect(suggestHandle("ark1qabc", 4)).toBe(suggestHandle("ark1qabc", 4));
  });

  it("always yields a valid handle, for any seed and any attempt", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), fc.integer({ min: 0, max: 50 }), (seed, attempt) => {
        expect(checkHandle(suggestHandle(seed, attempt)).ok).toBe(true);
      }),
    );
  });

  it("fits the length limit even for the longest words plus the number", () => {
    const longestAdjective = Math.max(...SUGGESTION_ADJECTIVES.map((w) => w.length));
    const longestNoun = Math.max(...SUGGESTION_NOUNS.map((w) => w.length));
    expect(longestAdjective + 1 + longestNoun + "-999".length).toBeLessThanOrEqual(HANDLE_MAX_LENGTH);
  });

  it("has clean word lists: lowercase letters only, no duplicates, none reserved", () => {
    for (const list of [SUGGESTION_ADJECTIVES, SUGGESTION_NOUNS]) {
      expect(new Set(list).size).toBe(list.length);
      for (const w of list) expect(w).toMatch(/^[a-z]+$/);
    }
    expect(SUGGESTION_ADJECTIVES).toContain("anonymous");
    for (const a of SUGGESTION_ADJECTIVES) for (const n of SUGGESTION_NOUNS) expect(checkHandle(`${a}-${n}`).ok).toBe(true);
  });

  it("uses plain word pairs first and only later a number", () => {
    for (let a = 0; a < SUGGESTION_BARE_ATTEMPTS; a++) {
      expect(suggestHandle("seed", a)).toMatch(/^[a-z]+-[a-z]+$/);
    }
    expect(suggestHandle("seed", SUGGESTION_BARE_ATTEMPTS)).toMatch(/^[a-z]+-[a-z]+-\d{3}$/);
  });

  it("changes the words between the first attempts, not just a number", () => {
    let differing = 0;
    for (let i = 0; i < 200; i++) {
      const names = new Set<string>();
      for (let a = 0; a < SUGGESTION_BARE_ATTEMPTS; a++) names.add(suggestHandle(`ark1q${i}`, a));
      if (names.size === SUGGESTION_BARE_ATTEMPTS) differing++;
    }
    expect(differing).toBeGreaterThan(190);
  });

  it("spreads seeds across every adjective and every noun", () => {
    const adjectives = new Set<string>();
    const nouns = new Set<string>();
    for (let i = 0; i < 4000; i++) {
      const [adjective, noun] = suggestHandle(`ark1q${i}`).split("-");
      adjectives.add(adjective);
      nouns.add(noun);
    }
    expect(adjectives.size).toBe(SUGGESTION_ADJECTIVES.length);
    expect(nouns.size).toBe(SUGGESTION_NOUNS.length);
  });

  it("gives thousands of wallets mostly different first suggestions", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) seen.add(suggestHandle(`ark1q${i}`));
    // 40 x 35 = 1400 pairs: 300 draws should collide only a handful of times
    expect(seen.size).toBeGreaterThan(250);
  });
});

describe("handleUrl", () => {
  it("builds a plain web link", () => {
    expect(handleUrl("https://spendrr.app", "pavel")).toBe("https://spendrr.app/@pavel");
  });
});

describe("parseHandleDestination", () => {
  it("reads both ways of writing a handle, case-insensitively", () => {
    expect(parseHandleDestination("@pavel")).toBe("pavel");
    expect(parseHandleDestination("  @Pavel  ")).toBe("pavel");
    expect(parseHandleDestination("pavel@spendrr.app")).toBe("pavel");
    expect(parseHandleDestination("Pavel@SPENDRR.APP")).toBe("pavel");
  });

  it("leaves everything else alone, so other destinations keep their own kind", () => {
    for (const raw of [
      "",
      "@",
      "pavel",
      "pavel@gmail.com",
      "pavel@spendrr.app.evil.com",
      "pavel@evilspendrr.app",
      "a@b@spendrr.app",
      "@pa vel",
      "bc1qexampleaddress",
      "lnbc1invoice",
      "ark1qexampleaddress",
    ]) {
      expect(parseHandleDestination(raw)).toBeNull();
    }
  });

  it("never throws", () => {
    fc.assert(fc.property(fc.string({ maxLength: 80 }), (raw) => void parseHandleDestination(raw)));
  });
});

describe("handleFromProfileUrl", () => {
  it("reads a profile link from the real domain or this app's own origin", () => {
    expect(handleFromProfileUrl("https://spendrr.app/@Pavel", "https://localhost:5173")).toBe("pavel");
    expect(handleFromProfileUrl("https://localhost:5173/@pavel", "https://localhost:5173")).toBe("pavel");
  });

  it("accepts a trailing slash and an encoded @", () => {
    expect(handleFromProfileUrl("https://spendrr.app/@pavel/", "https://localhost:5173")).toBe("pavel");
    expect(handleFromProfileUrl("https://spendrr.app/%40pavel", "https://localhost:5173")).toBe("pavel");
  });

  it("refuses other sites, extra path, query and fragment", () => {
    const own = "https://localhost:5173";
    for (const raw of [
      "https://evil.example/@pavel",
      "https://spendrr.app.evil.example/@pavel",
      "http://spendrr.app/@pavel",
      "https://spendrr.app/@pavel/extra",
      "https://spendrr.app/@pavel?x=1",
      "https://spendrr.app/@pavel#frag",
      "https://spendrr.app/pavel",
      "https://spendrr.app/@",
      "not a url",
    ]) {
      expect(handleFromProfileUrl(raw, own)).toBeNull();
    }
  });
});

describe("handleFromPath", () => {
  it("reads the name out of /@name, with or without a trailing slash", () => {
    expect(handleFromPath("/@pavel")).toBe("pavel");
    expect(handleFromPath("/@Pavel/")).toBe("pavel");
    expect(handleFromPath("/@anonymous-pea")).toBe("anonymous-pea");
  });

  it("reads the percent-encoded form Cloudflare redirects to", () => {
    expect(handleFromPath("/%40pavel")).toBe("pavel");
    expect(handleFromPath("/%40Pavel/")).toBe("pavel");
    expect(handleFromPath("/%40anonymous-pea")).toBe("anonymous-pea");
    expect(handleFromPath("/%40pavel%2f")).toBeNull();
  });

  it("does not claim any other path, so gift, request and app routes are untouched", () => {
    for (const p of ["/", "", "/r", "/g", "/@", "/@/", "/%40", "/@pavel/extra", "/pavel", "/@@pavel", "/x/@pavel", "/%40%40pavel"]) {
      expect(handleFromPath(p)).toBeNull();
    }
  });

  it("never throws on a malformed escape", () => {
    expect(handleFromPath("/@%E0%A4%A")).toBeNull();
    fc.assert(fc.property(fc.string({ maxLength: 60 }), (raw) => void handleFromPath("/@" + raw)));
  });
});
