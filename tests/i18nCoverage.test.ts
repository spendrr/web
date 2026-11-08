// Every Czech sentence the UI passes through t(), and every Czech Error message
// the app throws, must have an English entry in src/lib/i18n.ts. A missing one
// is silent: t() falls back to the Czech source and describeError() lets a Czech
// message through, so the English UI quietly shows Czech.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { __I18N_DICT } from "../src/lib/i18n";

const CZECH = /[áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

// Comments out, string contents kept.
function withoutComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

function literal(raw: string): string | null {
  try {
    return raw[0] === '"' ? (JSON.parse(raw) as string) : raw.slice(1, -1);
  } catch {
    return null;
  }
}

const STR = String.raw`("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|` + "`(?:[^`\\\\$]|\\\\.)*`)";
const T_CALL = new RegExp(String.raw`\bt\(\s*` + STR, "g");
const ERROR_CALL = new RegExp(String.raw`new Error\(\s*` + STR, "g");

function missing(re: RegExp): string[] {
  const out = new Set<string>();
  for (const file of sources("src")) {
    if (file.endsWith("i18n.ts") || file.endsWith("changelog.ts")) continue;
    const text = withoutComments(readFileSync(file, "utf8"));
    for (const m of text.matchAll(re)) {
      const v = literal(m[1]);
      if (v !== null && CZECH.test(v) && !(v in __I18N_DICT)) out.add(`${file}: ${v}`);
    }
  }
  return [...out].sort();
}

describe("English coverage", () => {
  it("every Czech t() literal has an English entry", () => {
    expect(missing(T_CALL)).toEqual([]);
  });

  it("every Czech Error message thrown by the app has an English entry", () => {
    expect(missing(ERROR_CALL)).toEqual([]);
  });
});

describe("push copy", () => {
  it("has an English word for every line a push shows", async () => {
    const { expiryCopy } = await import("../src/lib/expiryCopy");
    const en = (cs: string) => __I18N_DICT[cs] ?? cs;
    const copy = expiryCopy(en, "en-US");
    const lines = [copy.first, copy.reminder, copy.urgent, copy.up, copy.down, copy.payment, copy.paymentNoAmount, ...Object.values(copy.chat)];
    for (const line of lines) expect(line).not.toMatch(/[áčďéěíňóřšťúůýž]/i);
    expect(copy.payment).toContain("{sats}");
  });
});
