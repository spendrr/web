// Every Czech literal passed to t() must have an English entry, or the English UI
// shows Czech there (found by hand: "Now, then a reminder týdně"). Reads the source
// with the TypeScript parser; strings built from variables are out of its reach.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { __I18N_DICT, getLang, setLang, translate } from "../src/lib/i18n";

// Identical in both languages, so no entry is needed.
const SAME_IN_ENGLISH = new Set(["OK", "Ark", "Blockchain", "Offline", "{n} d", "{n} h", "~{n} min", "~{n} h", "{amount} sats", "≈ {amount} sats"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) && e.name !== "i18n.ts" ? [p] : [];
  });
}

// "a", or the branches of `cond ? "a" : "b"`.
function literals(node: ts.Expression): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isParenthesizedExpression(node)) return literals(node.expression);
  if (ts.isConditionalExpression(node)) return [...literals(node.whenTrue), ...literals(node.whenFalse)];
  return [];
}

describe("English dictionary coverage", () => {
  it("has an entry for every literal t() key", () => {
    const missing: string[] = [];
    for (const file of sourceFiles(join(__dirname, "../src"))) {
      const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "t" && n.arguments.length > 0) {
          for (const key of literals(n.arguments[0])) {
            if (!(key in __I18N_DICT) && !SAME_IN_ENGLISH.has(key)) missing.push(`${file.split("/src/")[1]}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${key}`);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(missing).toEqual([]);
  });

  it("keeps a context suffix out of the Czech text", () => {
    const before = getLang();
    try {
      setLang("cs");
      expect(translate("Přijmout@@accept")).toBe("Přijmout");
      setLang("en");
      expect(translate("Přijmout@@accept")).toBe("Accept");
    } finally {
      setLang(before);
    }
  });
});
