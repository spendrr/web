// public/_headers gives each realm its own Content-Security-Policy. A browser
// takes a worker's policy from its own script's response, so these rules are
// the only thing narrowing what the page, the chat worker and the wallet worker
// may connect to. The checks here keep that structure from drifting.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_CHAT_RELAYS } from "../src/lib/chat/relays";
import { PUBLIC_PRICE_URL } from "../src/lib/price";
import { allPublicDataUrls } from "../src/lib/publicData";

interface Line {
  detach: boolean;
  name: string;
  value: string;
}
interface Rule {
  path: string;
  lines: Line[];
}

function parseHeaders(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    if (!raw.startsWith(" ")) {
      rules.push({ path: raw.trim(), lines: [] });
      continue;
    }
    const body = raw.trim();
    const detach = body.startsWith("! ");
    const rest = detach ? body.slice(2) : body;
    const i = rest.indexOf(":");
    const name = (i === -1 ? rest : rest.slice(0, i)).trim();
    const value = i === -1 ? "" : rest.slice(i + 1).trim();
    rules[rules.length - 1].lines.push({ detach, name, value });
  }
  return rules;
}

const rules = parseHeaders(readFileSync("public/_headers", "utf8"));
const ruleFor = (path: string): Rule => {
  const r = rules.find((x) => x.path === path);
  if (!r) throw new Error(`no _headers rule for ${path}`);
  return r;
};
const cspOf = (rule: Rule): string => {
  const l = rule.lines.find((x) => !x.detach && x.name === "Content-Security-Policy");
  if (!l) throw new Error(`rule ${rule.path} sets no CSP`);
  return l.value;
};
function directive(csp: string, name: string): string[] {
  const d = csp.split(";").map((s) => s.trim()).find((s) => s === name || s.startsWith(name + " "));
  if (!d) throw new Error(`no ${name} in CSP`);
  return d.split(/\s+/).slice(1);
}

describe("per-realm CSP in public/_headers", () => {
  it("/* comes first, so every detach below it has something to detach", () => {
    expect(rules[0].path).toBe("/*");
  });

  it("every other rule that sets a CSP detaches the one from /* before setting its own", () => {
    for (const rule of rules.slice(1)) {
      const set = rule.lines.findIndex((l) => !l.detach && l.name === "Content-Security-Policy");
      if (set === -1) continue;
      const detach = rule.lines.findIndex((l) => l.detach && l.name === "Content-Security-Policy");
      expect(detach, `${rule.path} must detach first`).toBeGreaterThanOrEqual(0);
      expect(detach, `${rule.path} detach must precede its CSP`).toBeLessThan(set);
    }
  });

  it("every CSP keeps default-src 'self' (a worker policy has no other fallback)", () => {
    for (const rule of rules) {
      if (!rule.lines.some((l) => !l.detach && l.name === "Content-Security-Policy")) continue;
      expect(directive(cspOf(rule), "default-src"), rule.path).toEqual(["'self'"]);
    }
  });

  it("the page may only connect to itself and the exact public files fetch-guard.js allows", () => {
    const csp = cspOf(ruleFor("/*"));
    const connect = directive(csp, "connect-src");
    expect(connect[0]).toBe("'self'");
    expect(connect.slice(1).sort()).toEqual([PUBLIC_PRICE_URL, ...allPublicDataUrls()].sort());
    expect(directive(csp, "script-src")).toEqual(["'self'"]);
  });

  it("no _headers line goes past Cloudflare's 2000 character cap", () => {
    for (const raw of readFileSync("public/_headers", "utf8").split("\n")) {
      expect(raw.length, raw.slice(0, 60)).toBeLessThanOrEqual(1900);
    }
  });

  it("the wallet worker is the only realm with open https and wasm", () => {
    const csp = cspOf(ruleFor("/assets/wallet.worker-*"));
    expect(directive(csp, "connect-src")).toContain("https:");
    expect(directive(csp, "script-src")).toContain("'wasm-unsafe-eval'");
    for (const rule of rules) {
      if (rule.path === "/assets/wallet.worker-*") continue;
      if (!rule.lines.some((l) => !l.detach && l.name === "Content-Security-Policy")) continue;
      const other = cspOf(rule);
      expect(directive(other, "connect-src"), rule.path).not.toContain("https:");
      expect(directive(other, "script-src"), rule.path).not.toContain("'wasm-unsafe-eval'");
    }
  });

  it("the chat worker connects to exactly the chat relays", () => {
    const connect = directive(cspOf(ruleFor("/assets/chat.worker-*")), "connect-src");
    expect(connect.filter((s) => s.startsWith("wss://")).sort()).toEqual([...ALL_CHAT_RELAYS].sort());
    expect(connect.filter((s) => !s.startsWith("wss://"))).toEqual(["'self'"]);
  });

  it("the status page may reach only the probe Worker beside itself", () => {
    expect(directive(cspOf(ruleFor("/status*")), "connect-src")).toEqual([
      "'self'",
      "https://spendrr-status.spendrr-info.workers.dev",
    ]);
  });
});
