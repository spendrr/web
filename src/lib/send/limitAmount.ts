// The amount typed into the limit sheet. Parsed strictly: digits with at most one decimal separator, and nothing
// else. `Number()` is not used on the text: it accepts hex ("0x10"), binary ("0b11") and exponents ("1e3",
// "5e-3"), each of which would otherwise become a limit.

// Whole units: at most 9 digits (under a billion), so no typed value can overflow what a limit may hold.
const MAX_INTEGER_DIGITS = 9;

// Keeps only what the field can hold while typing: digits, one decimal separator, spaces as grouping. Decimals are
// cut to two (none for sats), the integer part to MAX_INTEGER_DIGITS. Everything else is dropped as it is typed
// or pasted, so a letter never reaches the field.
export function sanitizeLimitText(raw: string, allowDecimals: boolean): string {
  let out = "";
  let seenSeparator = false;
  let intDigits = 0;
  let decDigits = 0;
  for (const ch of raw) {
    if (ch >= "0" && ch <= "9") {
      if (seenSeparator) {
        if (!allowDecimals || decDigits >= 2) continue;
        decDigits++;
      } else {
        if (intDigits >= MAX_INTEGER_DIGITS) continue;
        intDigits++;
      }
      out += ch;
    } else if ((ch === "," || ch === ".") && allowDecimals && !seenSeparator && intDigits > 0) {
      seenSeparator = true;
      out += ch;
    } else if (/[\s  ]/.test(ch) && !seenSeparator && out.length > 0) {
      out += ch;
    }
  }
  return out.trim() === "" ? "" : out;
}

// The typed amount as a number, or null for anything that is not a plain amount.
export function parseLimitAmount(text: string, allowDecimals: boolean): number | null {
  const compact = text.replace(/[\s  ]/g, "");
  const m = allowDecimals ? /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(compact) : /^(\d{1,9})$/.exec(compact);
  if (!m) return null;
  const value = Number(m[2] === undefined ? m[1] : `${m[1]}.${m[2]}`);
  return Number.isFinite(value) ? value : null;
}

// What the field becomes when its text is changed to `next`. A change that is not a plain amount is refused whole
// and the field keeps `prev`, instead of being quietly cut down to a different number: a letter, a sign, an
// exponent, "0x10", a second decimal separator, a third decimal, more than nine digits. Only whitespace at the
// ends is tidied away.
export function acceptLimitText(next: string, prev: string, allowDecimals: boolean): string {
  if (/[^\d\s\u00a0\u202f,.]/.test(next)) return prev;
  const tidy = sanitizeLimitText(next, allowDecimals);
  const strip = (v: string) => v.replace(/[\s\u00a0\u202f]/g, "");
  // Sanitising changed more than whitespace: the text was not a plain amount.
  if (strip(tidy) !== strip(next)) return prev;
  return tidy;
}
