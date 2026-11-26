import { describe, expect, it } from "vitest";
import { AVATAR_FAMILIES, friendSpec } from "../src/lib/names/avatarFriends";
import { FRIEND_ADJECTIVES, FRIEND_BARE_ATTEMPTS, FRIEND_NOUNS, friendHandle, hueGroup } from "../src/lib/names/friendName";
import { checkHandle } from "../src/lib/names/handle";

const seeds = Array.from({ length: 600 }, (_, i) => `ark1pseed${i}${"q".repeat(i % 7)}`);

describe("friendHandle", () => {
  it("is deterministic and valid for every attempt", () => {
    for (const s of seeds) {
      for (let n = 0; n < 8; n++) {
        const h = friendHandle(s, n);
        expect(h).toBe(friendHandle(s, n));
        expect(checkHandle(h).ok).toBe(true);
        expect(h.length).toBeLessThanOrEqual(20);
      }
    }
  });
  it("offers five different bare names, then adds a two digit suffix", () => {
    expect(FRIEND_BARE_ATTEMPTS).toBe(5);
    for (const s of seeds) {
      const bare = Array.from({ length: FRIEND_BARE_ATTEMPTS }, (_, n) => friendHandle(s, n));
      expect(new Set(bare).size).toBe(FRIEND_BARE_ATTEMPTS);
      for (const h of bare) expect(h).toMatch(/^[a-z]+-[a-z]+$/);
      expect(friendHandle(s, FRIEND_BARE_ATTEMPTS)).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
    }
  });
  it("noun and adjective match the picture", () => {
    for (const s of seeds) {
      const spec = friendSpec(s);
      const [adj, noun] = friendHandle(s, 0).split("-");
      expect(FRIEND_NOUNS[spec.family]).toContain(noun);
      expect(FRIEND_ADJECTIVES[hueGroup(spec.main)]).toContain(adj);
    }
  });
  it("word lists fit the length budget and have no repeats", () => {
    const all = [...Object.values(FRIEND_ADJECTIVES).flat(), ...Object.values(FRIEND_NOUNS).flat()];
    expect(Math.max(...Object.values(FRIEND_ADJECTIVES).flat().map((w) => w.length))).toBeLessThanOrEqual(8);
    expect(Math.max(...Object.values(FRIEND_NOUNS).flat().map((w) => w.length))).toBeLessThanOrEqual(7);
    expect(new Set(Object.values(FRIEND_ADJECTIVES).flat()).size).toBe(192);
    expect(new Set(Object.values(FRIEND_NOUNS).flat()).size).toBe(140);
    expect(all.every((w) => /^[a-z]+$/.test(w))).toBe(true);
    for (const f of AVATAR_FAMILIES) expect(FRIEND_NOUNS[f].length).toBe(20);
  });
  it("reaches every colour group", () => {
    const seen = new Set(seeds.map((s) => hueGroup(friendSpec(s).main)));
    expect(seen.size).toBe(8);
  });
});
