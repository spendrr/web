import { describe, expect, it } from "vitest";
import { prefersEnglishLearn } from "../worker/learnLang";

describe("prefersEnglishLearn", () => {
  it("keeps Czech when there is no usable header", () => {
    expect(prefersEnglishLearn(null)).toBe(false);
    expect(prefersEnglishLearn("")).toBe(false);
    expect(prefersEnglishLearn("*")).toBe(false);
    expect(prefersEnglishLearn(" , ;q=1")).toBe(false);
  });

  it("keeps Czech for Czech and Slovak browsers", () => {
    expect(prefersEnglishLearn("cs")).toBe(false);
    expect(prefersEnglishLearn("cs-CZ,cs;q=0.9,en;q=0.8")).toBe(false);
    expect(prefersEnglishLearn("sk-SK,sk;q=0.9,en-US;q=0.8")).toBe(false);
    expect(prefersEnglishLearn("CS-cz")).toBe(false);
  });

  it("sends other browsers to English", () => {
    expect(prefersEnglishLearn("en-US,en;q=0.9")).toBe(true);
    expect(prefersEnglishLearn("de-DE,de;q=0.9,en;q=0.8")).toBe(true);
    expect(prefersEnglishLearn("en-US,en;q=0.9,cs;q=0.8")).toBe(true);
  });

  it("goes by weight, not position", () => {
    expect(prefersEnglishLearn("en;q=0.5,cs;q=0.9")).toBe(false);
    expect(prefersEnglishLearn("cs;q=0.4,en;q=0.8")).toBe(true);
  });

  it("uses order to break a tie", () => {
    expect(prefersEnglishLearn("cs,en")).toBe(false);
    expect(prefersEnglishLearn("en,cs")).toBe(true);
  });

  it("ignores languages refused with q=0 and malformed weights", () => {
    expect(prefersEnglishLearn("en;q=0,cs;q=0.5")).toBe(false);
    expect(prefersEnglishLearn("en;q=abc,cs;q=0.1")).toBe(false);
  });
});
