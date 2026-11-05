// public/learn-lang.js picks the landing page's language in the browser; run it
// in a bare realm with a fake window and see where it sends the reader.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

function run(languages: string[] | undefined, search = "", language?: string): string[] {
  const moves: string[] = [];
  runInNewContext(readFileSync("public/learn-lang.js", "utf8"), {
    window: { location: { search, replace: (to: string) => moves.push(to) } },
    navigator: { languages, language },
    RegExp,
    String,
  });
  return moves;
}

describe("learn-lang.js", () => {
  it("keeps Czech when there is no usable language", () => {
    expect(run(undefined)).toEqual([]);
    expect(run([])).toEqual([]);
    expect(run([""])).toEqual([]);
    expect(run(["*"])).toEqual([]);
  });

  it("keeps Czech for Czech and Slovak browsers", () => {
    expect(run(["cs"])).toEqual([]);
    expect(run(["cs-CZ", "en"])).toEqual([]);
    expect(run(["sk-SK", "en-US"])).toEqual([]);
    expect(run(["CS-cz"])).toEqual([]);
  });

  it("sends other browsers to English", () => {
    expect(run(["en-US", "en"])).toEqual(["/learn/en"]);
    expect(run(["de-DE", "en"])).toEqual(["/learn/en"]);
    expect(run(["en-US", "cs"])).toEqual(["/learn/en"]);
    expect(run(undefined, "", "fr")).toEqual(["/learn/en"]);
  });

  it("stays when the reader asked for Czech with ?lang=cs", () => {
    expect(run(["en-US"], "?lang=cs")).toEqual([]);
    expect(run(["en-US"], "?x=1&lang=cs")).toEqual([]);
    expect(run(["en-US"], "?lang=csx")).toEqual(["/learn/en"]);
  });
});
