// Password strength as an entropy estimate, not a character-class checklist.
//
// What this replaces and why: the old gate was `length >= 8 && has upper &&
// has digit && has symbol`. That accepts "Abcdefg1!" — a keyboard-adjacent
// alphabetical run with the three mandatory classes bolted on, and something
// on the order of 20 bits, i.e. minutes on a single consumer GPU against
// PBKDF2-SHA256. It simultaneously *rejects* a long passphrase with no
// symbol in it. For a vault whose ciphertext sits in localStorage on the
// user's own device — an offline oracle an attacker can grind at full speed
// once they have it — that is the wrong shape of test entirely: what matters
// is how many guesses the password costs, and character classes are close to
// uncorrelated with that.
//
// The model, closely following zxcvbn's approach:
//
//  1. Find every way the password can be explained by a *pattern* an
//     attacker's cracker already enumerates cheaply — a blocklist word
//     (after undoing leet substitutions), a keyboard run, an alphabetical
//     or numeric sequence, a repetition, a date.
//  2. Price every remaining stretch as log2(effective alphabet) per
//     character — the honest cost of a stretch we can't explain.
//  3. Find the *cheapest* way to cover the whole password with those pieces
//     (a shortest-path over positions), because the attacker gets to pick
//     the cheapest decomposition, not the flattering one.
//  4. Accept only if that cheapest decomposition costs more than
//     MIN_PASSWORD_BITS.
//
// Known limitation, deliberate: the blocklist is curated to a few hundred
// entries rather than zxcvbn's tens of thousands (see passwordBlocklist.ts
// for the bundle-size reasoning). A word that isn't in it is priced as
// bruteforce, which overestimates it. So this is a reliable lower bound on
// *weakness* — it catches what people actually pick — and not a certified
// upper bound on strength.
//
// This module is pure and has no DOM dependency; tests/passwordStrength
// .fuzz.test.ts exercises it directly.

import { BLOCKLIST, MAX_BLOCKLIST_LENGTH } from "./passwordBlocklist";

// ~45 bits against PBKDF2-SHA256 at 600k iterations (see vaultCrypto.ts) is
// not "uncrackable" — it is deliberately a usability/security compromise. A
// rough sense of scale: each PBKDF2 guess costs 600k SHA-256 compressions,
// so a GPU rig doing ~10^10 SHA-256/s manages on the order of 10^4 vault
// guesses/s, and 2^45 guesses is then centuries of that rig. Push the
// threshold much higher and users write the password down or reuse one,
// which is a worse outcome than this bound.
export const MIN_PASSWORD_BITS = 45;

// Patterns are only searched within this prefix. Two reasons: the matchers
// are O(n^2)-ish and this is called on every keystroke of a password field,
// and the fuzz tests feed in multi-kilobyte strings. Everything past the cap
// is ignored rather than credited, so the estimate can only ever be too
// low, never too high — otherwise "a" repeated 200 times would score as a
// cheap repeat for its first 96 characters plus 100+ bits of "tail", and
// pass.
const ANALYSIS_MAX_LENGTH = 96;

// See its use in solve() below.
const BRUTEFORCE_SEGMENT_PENALTY_BITS = 2;

export type WeaknessKind =
  // A blocklist entry, possibly leeted/capitalised/reversed.
  | "common"
  // A run along one keyboard layout ("qwertz", "asdf", "1qaz").
  | "keyboard"
  // An alphabetical or numeric run ("abcdef", "9876").
  | "sequence"
  // A repeated unit ("abcabcabc", "aaaaaa").
  | "repeat"
  // A plausible date or year ("1985", "01011990").
  | "date";

export interface PasswordStrength {
  // log2 of the cheapest decomposition's guess count.
  bits: number;
  ok: boolean;
  // The pattern covering the most characters of the cheapest decomposition,
  // i.e. the single best thing to tell the user to stop doing. null when the
  // password is simply too short or drawn from too narrow an alphabet, with
  // no recognised pattern in it.
  weakness: WeaknessKind | null;
}

interface Match {
  // Inclusive start, exclusive end — same convention as slice().
  start: number;
  end: number;
  bits: number;
  kind: WeaknessKind;
}

// ---------------------------------------------------------------------------
// Effective alphabet
// ---------------------------------------------------------------------------

const LOWER_RE = /[a-z]/;
const UPPER_RE = /[A-Z]/;
const DIGIT_RE = /[0-9]/;
// Everything a US/CZ keyboard produces that isn't alphanumeric, plus space.
const SYMBOL_RE = /[ !-/:-@[-`{-~]/;

// The alphabet an attacker would have to enumerate for this exact stretch —
// per stretch, not per whole password. That distinction matters: pricing a
// long lowercase run at log2(95) per character just because the password
// ends in "!" credits it with strength it doesn't have. The DP below adds a
// bruteforce edge for every substring, so a mixed stretch is automatically
// split into whichever homogeneous pieces are cheapest.
function alphabetSize(s: string): number {
  let size = 0;
  if (LOWER_RE.test(s)) size += 26;
  if (UPPER_RE.test(s)) size += 26;
  if (DIGIT_RE.test(s)) size += 10;
  if (SYMBOL_RE.test(s)) size += 33;
  // Anything else — accented Czech letters, emoji, other scripts. A real
  // cracker attacking these enumerates a specific extra set rather than all
  // of Unicode, so this is a modest constant rather than 2^20.
  if (/[^\x20-\x7e]/.test(s)) size += 100;
  return Math.max(size, 1);
}

function bruteforceBits(s: string): number {
  return s.length * Math.log2(alphabetSize(s));
}

// ---------------------------------------------------------------------------
// Capitalisation and leet accounting
// ---------------------------------------------------------------------------

function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  const kk = Math.min(k, n - k);
  for (let i = 0; i < kk; i++) result = (result * (n - i)) / (i + 1);
  return result;
}

// Extra guesses an attacker spends on capitalisation once they have the
// lowercase word. All-lowercase is free (it's what the dictionary holds);
// the three conventional shapes (Word, WORD, worD) are one bit; anything
// else costs however many ways that many capitals could have been placed.
function capitalisationBits(token: string): number {
  const letters = token.replace(/[^A-Za-z]/g, "");
  if (letters.length === 0) return 0;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  if (upper === 0) return 0;
  if (upper === letters.length) return 1;
  const firstOnly = /^[A-Z][^A-Z]*$/.test(letters);
  const lastOnly = /^[^A-Z]*[A-Z]$/.test(letters);
  if (firstOnly || lastOnly) return 1;
  let possibilities = 0;
  for (let i = 1; i <= Math.min(upper, letters.length - upper); i++) {
    possibilities += binom(letters.length, i);
  }
  return Math.log2(Math.max(possibilities, 2));
}

// One character can stand in for several letters (1 -> l or i), so undoing
// leet is a search, not a lookup. Values are the plaintext letters each
// substitute could have replaced.
const LEET: Record<string, string[]> = {
  "4": ["a"],
  "@": ["a"],
  "8": ["b"],
  "(": ["c"],
  "{": ["c"],
  "<": ["c"],
  "3": ["e"],
  "6": ["g", "b"],
  "9": ["g"],
  "#": ["h"],
  "1": ["l", "i"],
  "!": ["i", "l"],
  "|": ["i", "l"],
  "0": ["o"],
  "$": ["s"],
  "5": ["s"],
  "7": ["t"],
  "+": ["t"],
  "2": ["z"],
};

// Bounded on purpose: a token full of leetable characters would otherwise
// blow up combinatorially, and this runs per substring per keystroke.
const MAX_LEET_VARIANTS = 32;

interface Variant {
  word: string;
  // How many characters were actually substituted — each one is roughly a
  // binary choice the attacker has to make, so it's a cost.
  subs: number;
}

// Always yields the un-substituted token first: blocklist entries contain
// literal digits ("abc123", "password1"), so de-leeting must be an
// *addition* to the plain lookup, never a replacement for it.
function deleetVariants(lowered: string): Variant[] {
  let variants: Variant[] = [{ word: "", subs: 0 }];
  for (const ch of lowered) {
    const options = LEET[ch];
    const next: Variant[] = [];
    for (const v of variants) {
      next.push({ word: v.word + ch, subs: v.subs });
      if (options) {
        for (const letter of options) {
          if (next.length >= MAX_LEET_VARIANTS) break;
          next.push({ word: v.word + letter, subs: v.subs + 1 });
        }
      }
      if (next.length >= MAX_LEET_VARIANTS) break;
    }
    variants = next;
  }
  return variants;
}

// ---------------------------------------------------------------------------
// Matchers
// ---------------------------------------------------------------------------

// Shortest token worth looking up. Below this, a "match" is noise — every
// password contains some two-letter string that's a prefix of something —
// and pricing it as a dictionary hit would understate real passwords.
const MIN_DICTIONARY_LENGTH = 3;

function dictionaryMatches(password: string): Match[] {
  const matches: Match[] = [];
  const n = password.length;
  for (let start = 0; start < n; start++) {
    const maxEnd = Math.min(n, start + MAX_BLOCKLIST_LENGTH);
    for (let end = start + MIN_DICTIONARY_LENGTH; end <= maxEnd; end++) {
      const token = password.slice(start, end);
      const lowered = token.toLowerCase();
      let bestBits = Infinity;
      for (const variant of deleetVariants(lowered)) {
        const forwardRank = BLOCKLIST.get(variant.word);
        const reversedRank = BLOCKLIST.get([...variant.word].reverse().join(""));
        // A reversed word is one extra bit: the attacker's wordlist pass
        // over reversals is a second pass, not a whole extra dictionary.
        const rank = forwardRank ?? reversedRank;
        if (rank === undefined) continue;
        const reversalBits = forwardRank === undefined ? 1 : 0;
        const leetBits = variant.subs === 0 ? 0 : Math.min(variant.subs, variant.word.length);
        const bits =
          Math.log2(rank) + capitalisationBits(token) + leetBits + reversalBits;
        if (bits < bestBits) bestBits = bits;
      }
      if (bestBits < Infinity) matches.push({ start, end, bits: bestBits, kind: "common" });
    }
  }
  return matches;
}

// Rows are written with leading spaces so column indices line up with the
// physical stagger of a real keyboard: the key below-and-right of 'q' is
// 'a' at the same column index + 1. Only unshifted keys are modelled — the
// input is lowercased before matching and capitalisationBits() accounts for
// the rest, which is enough to catch "QWERTZ" and "Asdf" without carrying a
// second shifted layout.
const LAYOUTS = [
  // qwerty (US)
  ["`1234567890-=", " qwertyuiop[]\\", "  asdfghjkl;'", "   zxcvbnm,./"],
  // qwertz (Czech/German letter block — y and z swapped, which is what most
  // of this app's users actually type on)
  ["`1234567890-=", " qwertzuiop[]\\", "  asdfghjkl;'", "   yxcvbnm,./"],
];

interface Layout {
  adjacency: Map<string, Set<string>>;
  keyCount: number;
  averageDegree: number;
}

function buildLayout(rows: string[]): Layout {
  const adjacency = new Map<string, Set<string>>();
  const at = (r: number, c: number): string | null => {
    const row = rows[r];
    if (row === undefined || c < 0 || c >= row.length) return null;
    const ch = row[c];
    return ch === " " ? null : ch;
  };
  const link = (a: string, b: string | null) => {
    if (b === null) return;
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a)!.add(b);
  };
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      const key = at(r, c);
      if (key === null) continue;
      if (!adjacency.has(key)) adjacency.set(key, new Set());
      link(key, at(r, c - 1));
      link(key, at(r, c + 1));
      // The stagger: directly above/below is offset by roughly half a key,
      // so a key touches the one at the same index and the one after it in
      // each neighbouring row.
      link(key, at(r - 1, c));
      link(key, at(r - 1, c + 1));
      link(key, at(r + 1, c - 1));
      link(key, at(r + 1, c));
    }
  }
  let degreeSum = 0;
  for (const neighbours of adjacency.values()) degreeSum += neighbours.size;
  return {
    adjacency,
    keyCount: adjacency.size,
    averageDegree: degreeSum / Math.max(adjacency.size, 1),
  };
}

const BUILT_LAYOUTS = LAYOUTS.map(buildLayout);

const MIN_KEYBOARD_RUN = 3;

// Lower-case keeping a 1:1 UTF-16 index mapping with the input: a code unit
// whose lower-case form isn't exactly one code unit ("İ" becomes "i" + U+0307)
// stays as is, so match indices stay valid for `password`.
function lowerKeepingLength(password: string): string {
  let out = "";
  for (let i = 0; i < password.length; i++) {
    const ch = password[i];
    const low = ch.toLowerCase();
    out += low.length === 1 ? low : ch;
  }
  return out;
}

function keyboardMatches(password: string): Match[] {
  const matches: Match[] = [];
  const lowered = lowerKeepingLength(password);
  for (const layout of BUILT_LAYOUTS) {
    let start = 0;
    while (start < lowered.length - 1) {
      let end = start + 1;
      let turns = 0;
      let lastDirection: string | null = null;
      while (end < lowered.length) {
        const from = lowered[end - 1];
        const to = lowered[end];
        if (!layout.adjacency.get(from)?.has(to)) break;
        // "Turn" in the zxcvbn sense: the run changing which neighbour
        // direction it moves in. A straight line along one row is one
        // cheap thing to guess; a zig-zag is several.
        const direction = `${from}>${to}`;
        if (lastDirection !== null && direction !== lastDirection) turns++;
        lastDirection = direction;
        end++;
      }
      const length = end - start;
      if (length >= MIN_KEYBOARD_RUN) {
        const token = password.slice(start, end);
        const bits =
          Math.log2(layout.keyCount) +
          (length - 1) * Math.log2(layout.averageDegree) +
          Math.log2(turns + 1) +
          capitalisationBits(token);
        matches.push({ start, end, bits, kind: "keyboard" });
        // Also offer every prefix of the run: the DP may find it cheaper to
        // cover part of it here and part of it with another pattern.
        for (let shorter = start + MIN_KEYBOARD_RUN; shorter < end; shorter++) {
          const subToken = password.slice(start, shorter);
          matches.push({
            start,
            end: shorter,
            bits:
              Math.log2(layout.keyCount) +
              (shorter - start - 1) * Math.log2(layout.averageDegree) +
              capitalisationBits(subToken),
            kind: "keyboard",
          });
        }
        start = start + 1;
      } else {
        start++;
      }
    }
  }
  return matches;
}

const MIN_SEQUENCE_RUN = 3;

// Alphabetical or numeric runs, case-insensitively: "abcd", "DCBA", "3456",
// "9876". Restricted to a single class so "z0" doesn't read as a sequence
// just because the code points happen to be adjacent in some encoding.
function sequenceMatches(password: string): Match[] {
  const matches: Match[] = [];
  const classOf = (ch: string): "digit" | "alpha" | null => {
    if (/[0-9]/.test(ch)) return "digit";
    if (/[a-z]/i.test(ch)) return "alpha";
    return null;
  };
  const codeOf = (ch: string): number => ch.toLowerCase().charCodeAt(0);
  let start = 0;
  while (start < password.length - 1) {
    const cls = classOf(password[start]);
    if (cls === null) {
      start++;
      continue;
    }
    const delta = codeOf(password[start + 1]) - codeOf(password[start]);
    if (delta !== 1 && delta !== -1) {
      start++;
      continue;
    }
    let end = start + 1;
    while (end < password.length) {
      if (classOf(password[end]) !== cls) break;
      if (codeOf(password[end]) - codeOf(password[end - 1]) !== delta) break;
      end++;
    }
    const length = end - start;
    if (length >= MIN_SEQUENCE_RUN) {
      const token = password.slice(start, end);
      const first = token[0].toLowerCase();
      // An "obvious" start ('a', 'z', '0', '1', '9') is the first thing
      // anyone tries, so it costs a couple of bits rather than the full
      // log2 of picking a starting character out of the class.
      const obvious = first === "a" || first === "z" || first === "0" || first === "1" || first === "9";
      const base = obvious ? 2 : Math.log2(cls === "digit" ? 10 : 26);
      const bits =
        base + (delta === -1 ? 1 : 0) + Math.log2(length) + capitalisationBits(token);
      matches.push({ start, end, bits, kind: "sequence" });
      start = end - 1;
    } else {
      start++;
    }
  }
  return matches;
}

// A repeated unit costs whatever the unit itself costs, plus the choice of
// how many times to repeat it. The unit is priced by recursing into the
// whole estimator — "abcabcabc" should not be credited for the "abc" being
// a keyboard-ish/dictionary-ish thing in its own right.
//
// `memo` holds each unit's price for the rest of one estimate. In a string
// that is mostly one repeated run, nearly every (start, unit length) pair is
// a repeat of one of a handful of distinct units, and pricing each pair
// afresh re-ran the whole estimator on the same "aaaa…" thousands of times
// at every recursion level: "a".repeat(96) took ~2s, on the main thread,
// per keystroke in the password field. `solve` is a pure function of the
// unit and the depth, so caching it changes no result.
function repeatMatches(password: string, depth: number, memo: Map<string, number>): Match[] {
  const matches: Match[] = [];
  const n = password.length;
  for (let start = 0; start < n - 1; start++) {
    for (let unitLength = 1; unitLength <= Math.floor((n - start) / 2); unitLength++) {
      const unit = password.slice(start, start + unitLength);
      let count = 1;
      while (
        start + (count + 1) * unitLength <= n &&
        password.slice(start + count * unitLength, start + (count + 1) * unitLength) === unit
      ) {
        count++;
      }
      if (count < 2) continue;
      const end = start + count * unitLength;
      const unitBits = depth >= MAX_RECURSION_DEPTH ? bruteforceBits(unit) : unitCost(unit, depth + 1, memo);
      matches.push({ start, end, bits: unitBits + Math.log2(count), kind: "repeat" });
    }
  }
  return matches;
}

function unitCost(unit: string, depth: number, memo: Map<string, number>): number {
  const key = `${depth}|${unit}`;
  let bits = memo.get(key);
  if (bits === undefined) {
    bits = solve(unit, depth, memo).bits;
    memo.set(key, bits);
  }
  return bits;
}

// Enough to price "abcabc" (one level) and the "abc" inside it (two), which
// is as deep as real passwords go. Beyond it the unit is priced as
// bruteforce, which is only ever an overestimate of its cost — safe.
const MAX_RECURSION_DEPTH = 2;

// A date is a very small space: ~136 plausible years, ~372 day/month
// combinations. Any digit run that reads as one is priced accordingly
// instead of as 4-8 characters of numeric bruteforce.
const YEAR_BITS = Math.log2(136); // 1900..2035
const DAY_MONTH_BITS = Math.log2(372); // 31 * 12, generously
const TWO_DIGIT_YEAR_BITS = Math.log2(100);

function isYear(value: number): boolean {
  return value >= 1900 && value <= 2035;
}

function isDayMonth(a: number, b: number): boolean {
  // Either order — nothing in a bare digit run says which convention was
  // used, and the attacker tries both.
  return (a >= 1 && a <= 31 && b >= 1 && b <= 12) || (a >= 1 && a <= 12 && b >= 1 && b <= 31);
}

function dateMatches(password: string): Match[] {
  const matches: Match[] = [];
  const n = password.length;
  const isDigits = (s: string) => /^[0-9]+$/.test(s);
  for (let start = 0; start < n; start++) {
    for (const length of [4, 6, 8]) {
      const end = start + length;
      if (end > n) continue;
      const token = password.slice(start, end);
      if (!isDigits(token)) continue;
      let bits: number | null = null;
      if (length === 4) {
        const asYear = Number(token);
        if (isYear(asYear)) bits = YEAR_BITS;
        else if (isDayMonth(Number(token.slice(0, 2)), Number(token.slice(2)))) bits = DAY_MONTH_BITS;
      } else if (length === 6) {
        // ddmmyy / yymmdd — both are two-digit-year forms.
        if (
          isDayMonth(Number(token.slice(0, 2)), Number(token.slice(2, 4))) ||
          isDayMonth(Number(token.slice(2, 4)), Number(token.slice(4)))
        ) {
          bits = DAY_MONTH_BITS + TWO_DIGIT_YEAR_BITS;
        }
      } else {
        // ddmmyyyy / yyyymmdd
        const leadingYear = Number(token.slice(0, 4));
        const trailingYear = Number(token.slice(4));
        if (isYear(trailingYear) && isDayMonth(Number(token.slice(0, 2)), Number(token.slice(2, 4)))) {
          bits = DAY_MONTH_BITS + YEAR_BITS;
        } else if (isYear(leadingYear) && isDayMonth(Number(token.slice(4, 6)), Number(token.slice(6)))) {
          bits = DAY_MONTH_BITS + YEAR_BITS;
        }
      }
      if (bits !== null) matches.push({ start, end, bits, kind: "date" });
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Cheapest decomposition
// ---------------------------------------------------------------------------

interface Solution {
  bits: number;
  // The pattern matches actually used by the cheapest decomposition.
  used: Match[];
}

function solve(password: string, depth: number, memo: Map<string, number>): Solution {
  const n = password.length;
  if (n === 0) return { bits: 0, used: [] };

  const matches = [
    ...dictionaryMatches(password),
    ...keyboardMatches(password),
    ...sequenceMatches(password),
    ...dateMatches(password),
    ...repeatMatches(password, depth, memo),
  ];
  // Bucketed by end position so the DP below is a single left-to-right pass
  // rather than a scan over every match at every position.
  const endingAt: Match[][] = Array.from({ length: n + 1 }, () => []);
  for (const m of matches) endingAt[m.end].push(m);

  // best[k] = cheapest bits to explain password[0..k). from[k] = the edge
  // that achieved it (null for a bruteforce edge, whose start is recorded
  // in fromStart).
  const best = new Array<number>(n + 1).fill(Infinity);
  const fromMatch = new Array<Match | null>(n + 1).fill(null);
  const fromStart = new Array<number>(n + 1).fill(0);
  best[0] = 0;

  for (let end = 1; end <= n; end++) {
    // Bruteforce edges for every possible start. Walking `start` downwards
    // lets the alphabet grow monotonically, so this stays cheap; and
    // offering every substring (not just maximal gaps) is what lets a mixed
    // stretch split itself into the homogeneous pieces that are cheapest.
    let hasLower = false;
    let hasUpper = false;
    let hasDigit = false;
    let hasSymbol = false;
    let hasOther = false;
    for (let start = end - 1; start >= 0; start--) {
      const ch = password[start];
      if (LOWER_RE.test(ch)) hasLower = true;
      else if (UPPER_RE.test(ch)) hasUpper = true;
      else if (DIGIT_RE.test(ch)) hasDigit = true;
      else if (SYMBOL_RE.test(ch)) hasSymbol = true;
      else hasOther = true;
      const size =
        (hasLower ? 26 : 0) +
        (hasUpper ? 26 : 0) +
        (hasDigit ? 10 : 0) +
        (hasSymbol ? 33 : 0) +
        (hasOther ? 100 : 0);
      // Splitting a stretch into per-class pieces is only free if the
      // attacker already knows the class layout. They don't: a mask like
      // "Aa#9aa" is itself a choice among four classes at each boundary, so
      // each additional bruteforce segment costs something. Without this
      // term a genuinely random 10-character password-manager string prices
      // out *below* the threshold, because the DP shatters it into six
      // narrow-alphabet pieces and charges log2(26) where log2(95) is
      // closer to the truth. Two bits per boundary is the modest,
      // defensible version of that correction — small enough that it never
      // rescues a password whose weakness is a recognised pattern (those
      // are priced by their match, not by segment count).
      const segmentPenalty = start > 0 ? BRUTEFORCE_SEGMENT_PENALTY_BITS : 0;
      const candidate = best[start] + segmentPenalty + (end - start) * Math.log2(Math.max(size, 1));
      if (candidate < best[end]) {
        best[end] = candidate;
        fromMatch[end] = null;
        fromStart[end] = start;
      }
    }
    for (const m of endingAt[end]) {
      const candidate = best[m.start] + m.bits;
      if (candidate < best[end]) {
        best[end] = candidate;
        fromMatch[end] = m;
        fromStart[end] = m.start;
      }
    }
  }

  const used: Match[] = [];
  for (let k = n; k > 0; k = fromStart[k]) {
    const m = fromMatch[k];
    if (m) used.push(m);
  }
  return { bits: best[n], used };
}

export function estimatePasswordStrength(password: string): PasswordStrength {
  const analysed = password.slice(0, ANALYSIS_MAX_LENGTH);
  if (analysed.length === 0) return { bits: 0, ok: false, weakness: null };
  const { bits, used } = solve(analysed, 0, new Map());
  // The pattern covering the most characters is the one worth naming in a
  // hint — it's what the user would have to change to make a real
  // difference.
  let dominant: Match | null = null;
  for (const m of used) {
    if (!dominant || m.end - m.start > dominant.end - dominant.start) dominant = m;
  }
  // A pattern covering a couple of characters of an otherwise fine password
  // isn't what makes it weak, and naming it would be misleading.
  const covers = dominant ? dominant.end - dominant.start : 0;
  const weakness = dominant && covers >= Math.max(3, analysed.length / 3) ? dominant.kind : null;
  return { bits, ok: bits >= MIN_PASSWORD_BITS, weakness };
}

