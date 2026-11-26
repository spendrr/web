import { describe, expect, it } from "vitest";
import { AVATAR_FAMILIES, friendSpec } from "../src/lib/names/avatarFriends";
import { makeRng, type AvatarShape } from "../src/lib/names/avatar";
import { renderAvatarRgb } from "../worker/avatarPng";

function seeds(n: number): string[] {
  const chars = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const r = makeRng("friends-seedgen");
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let s = "ark1p";
    for (let k = 0; k < 50; k++) s += chars[Math.floor(r() * 32)];
    out.push(s);
  }
  return out;
}

function numbersOf(shape: AvatarShape): number[] {
  return Object.values(shape).filter((v): v is number => typeof v === "number");
}

describe("friendSpec", () => {
  it("is deterministic and depends on the seed", () => {
    expect(friendSpec("ark1qexample")).toEqual(friendSpec("ark1qexample"));
    expect(JSON.stringify(friendSpec("ark1q7f3k-pavel"))).not.toBe(JSON.stringify(friendSpec("ark1qm29x-pave1")));
  });

  it("reaches every family, roughly evenly", () => {
    const counts = new Map<string, number>();
    for (const s of seeds(500)) counts.set(friendSpec(s).family, (counts.get(friendSpec(s).family) ?? 0) + 1);
    for (const f of AVATAR_FAMILIES) expect(counts.get(f) ?? 0).toBeGreaterThan(50);
  });

  it("emits only finite numbers, hex colours and paths made of M, L and Z", () => {
    for (const s of seeds(300)) {
      const spec = friendSpec(s);
      expect(spec.background.from).toMatch(/^#[0-9a-f]{6}$/);
      expect(spec.shapes.length).toBeGreaterThan(3);
      for (const shape of spec.shapes) {
        for (const n of numbersOf(shape)) expect(Number.isFinite(n)).toBe(true);
        const colour = "fill" in shape ? shape.fill : shape.stroke;
        expect(colour).toMatch(/^#[0-9a-f]{6}$/);
        if (shape.kind === "path") expect(shape.d).toMatch(/^M[-\d. ]+(L[-\d. ]+)*Z$/);
      }
    }
  });

  it("looks the same for the same seed on the Worker's renderer, and differs between seeds", () => {
    const [a, b] = seeds(2);
    const ra = renderAvatarRgb(a, 64, 4, "#f2ede4", true);
    expect(renderAvatarRgb(a, 64, 4, "#f2ede4", true)).toEqual(ra);
    expect(renderAvatarRgb(b, 64, 4, "#f2ede4", true)).not.toEqual(ra);
  });

  it("pins the family and background of approved seeds", () => {
    // Changing any of these repaints that address: bump FRIENDS_SEED_PREFIX instead.
    const got = seeds(8).map((s) => {
      const f = friendSpec(s);
      return `${f.family}:${f.background.from}:${f.shapes.length}`;
    });
    expect(got).toMatchInlineSnapshot(`
      [
        "octopus:#14173a:64",
        "robot:#14173a:14",
        "planet:#a8e6f0:17",
        "cactus:#bbd2ff:28",
        "angler:#15103a:26",
        "cactus:#f9b8cf:30",
        "angler:#0b1530:30",
        "angler:#15103a:33",
      ]
    `);
  });

  it("draws cheaply on the Worker (informational)", () => {
    const t0 = performance.now();
    const n = 30;
    for (const s of seeds(n)) renderAvatarRgb(s, 256, 20, "#f2ede4", true);
    const per = (performance.now() - t0) / n;
    console.log(`friends render 256px: ${per.toFixed(1)} ms each`);
    expect(per).toBeLessThan(40);
  });
});
