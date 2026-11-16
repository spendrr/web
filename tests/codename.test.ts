import { describe, expect, it } from "vitest";
import { CHANGELOG, CODENAMES, nextCodename } from "../src/lib/changelog";

const SHAPE = /^[A-Z][a-z]+ [A-Z][a-z]+$/;

describe("release codenames", () => {
  it("are 72 unique names, adjective and animal, alliterating, at most 14 characters", () => {
    expect(CODENAMES).toHaveLength(72);
    expect(new Set(CODENAMES).size).toBe(72);
    for (const n of CODENAMES) {
      expect(n).toMatch(SHAPE);
      const [adj, animal] = n.split(" ");
      expect(adj[0]).toBe(animal[0]);
    }
    for (const n of CODENAMES.slice(24)) expect(n.length).toBeLessThanOrEqual(14);
  });

  it("run A to Z in every round of 24", () => {
    const letters = CODENAMES.map((n) => n[0]);
    for (let r = 0; r < 3; r++) {
      const round = letters.slice(r * 24, r * 24 + 24);
      expect([...round].sort()).toEqual(round);
      expect(new Set(round).size).toBe(24);
    }
  });

  it("changelog entries advance one letter per release (newest first, wraps)", () => {
    const letters = CODENAMES.slice(0, 24).map((n) => n[0]);
    const named = CHANGELOG.filter((e) => e.codename);
    for (const e of named) expect(e.codename).toMatch(SHAPE);
    for (let i = 0; i + 1 < named.length; i++) {
      const newer = letters.indexOf(named[i].codename![0]);
      const older = letters.indexOf(named[i + 1].codename![0]);
      expect(newer).toBe((older + 1) % letters.length);
    }
  });

  it("nextCodename steps through the list by count and wraps", () => {
    expect(nextCodename([{}])).toBe("Agile Axolotl");
    expect(nextCodename([{ codename: "Agile Axolotl" }, {}])).toBe("Bold Badger");
    expect(nextCodename([{ codename: "Anxious Ant" }])).toBe("Bold Badger");
    expect(nextCodename([{ codename: "Bold Badger" }, { codename: "Agile Axolotl" }])).toBe("Clever Capybara");
    const all = Array.from({ length: 72 }, () => ({ codename: "x" }));
    expect(nextCodename(all)).toBe("Agile Axolotl");
  });
});
