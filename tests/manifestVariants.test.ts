// The dark manifest is a static copy of the light one with the two colours of
// src/index.css's dark --bg; public/manifest-pick.js links one of them.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (f: string) => JSON.parse(readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8")) as Record<string, unknown>;

describe("manifest variants", () => {
  it("dark differs from light only in theme and background colour", () => {
    const light = read("manifest.json");
    const dark = read("manifest-dark.json");
    expect(dark.theme_color).toBe("#100e0a");
    expect(dark.background_color).toBe("#100e0a");
    expect({ ...dark, theme_color: light.theme_color, background_color: light.background_color }).toEqual(light);
  });
});
