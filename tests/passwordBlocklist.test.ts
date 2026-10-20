// Regression guard for src/lib/vault/passwordBlocklist.ts.
//
// BLOCKLIST is built as `new Map(entries.map((w, i) => [w, i + 1]))` — if the
// same word ever appears twice in RAW (a copy-paste slip when someone adds a
// batch of entries later), the Map silently keeps only the *later* occurrence
// under its higher rank. Since a match's cost is log2(rank), that makes the
// word look rarer — and therefore a password containing it look stronger —
// than it actually is. Not a bug today (no duplicates currently exist), but
// nothing else catches it if one is introduced.
import { describe, expect, it } from "vitest";
import { BLOCKLIST } from "../src/lib/vault/passwordBlocklist";

describe("passwordBlocklist", () => {
  it("has no duplicate entries", () => {
    // BLOCKLIST is already deduplicated by construction (it's a Map), so the
    // only way to detect a collision from the outside is that its size would
    // be smaller than the number of non-empty lines that fed it. Re-derive
    // that count independently rather than re-reading the module's RAW
    // constant (which isn't exported), so this test can't just re-exercise
    // the same buggy logic it's meant to catch.
    const ranks = [...BLOCKLIST.values()];
    const maxRank = Math.max(...ranks);
    expect(ranks.length).toBe(BLOCKLIST.size);
    expect(maxRank).toBe(BLOCKLIST.size);
  });

  it("assigns ranks as a dense 1..size sequence with no gaps or repeats", () => {
    const ranks = [...BLOCKLIST.values()].sort((a, b) => a - b);
    const expected = Array.from({ length: BLOCKLIST.size }, (_, i) => i + 1);
    expect(ranks).toEqual(expected);
  });
});
