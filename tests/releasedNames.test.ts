import { describe, expect, it } from "vitest";
import { forgetReleasedName, rememberReleasedName, wasReleasedBy } from "../src/lib/names/releasedNames";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, v),
  };
}

const DAY = 24 * 60 * 60 * 1000;

describe("released names", () => {
  it("is a hint for the wallet that released the name, not for another wallet in the same browser", () => {
    const s = memoryStorage();
    rememberReleasedName("pavel", "ark1walleta", s, 0);
    expect(wasReleasedBy("pavel", "ark1walleta", s, DAY)).toBe(true);
    expect(wasReleasedBy("pavel", "ark1walletb", s, DAY)).toBe(false);
    expect(wasReleasedBy("pavel", null, s, DAY)).toBe(false);
  });

  it("ends with the quarantine", () => {
    const s = memoryStorage();
    rememberReleasedName("pavel", "ark1walleta", s, 0);
    expect(wasReleasedBy("pavel", "ark1walleta", s, 31 * DAY)).toBe(false);
  });

  it("is forgotten once the name is taken again", () => {
    const s = memoryStorage();
    rememberReleasedName("pavel", "ark1walleta", s, 0);
    forgetReleasedName("pavel", s, DAY);
    expect(wasReleasedBy("pavel", "ark1walleta", s, DAY)).toBe(false);
  });

  it("ignores entries it cannot read", () => {
    const s = memoryStorage();
    s.setItem("spendrr.releasedNames", JSON.stringify({ pavel: 5, jana: { at: 0 } }));
    expect(wasReleasedBy("pavel", "ark1walleta", s, DAY)).toBe(false);
    expect(wasReleasedBy("jana", "ark1walleta", s, DAY)).toBe(false);
  });
});
