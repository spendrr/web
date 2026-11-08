// How long the send field waits before asking about a typed @handle.
import { describe, expect, it } from "vitest";
import { nameLookupDelayMs } from "../src/lib/names/lookupDelay";
import { pinName, pinnedNamesStartingWith } from "../src/lib/names/namePins";

const PAUSE = 400;
const PREFIX_PAUSE = 1500;

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

describe("nameLookupDelayMs", () => {
  it("answers at once for a name already known locally", () => {
    expect(nameLookupDelayMs({ answeredLocally: true, prefixOfPaidName: false }, PAUSE, PREFIX_PAUSE)).toBe(0);
    expect(nameLookupDelayMs({ answeredLocally: true, prefixOfPaidName: true }, PAUSE, PREFIX_PAUSE)).toBe(0);
  });

  it("waits longer when what is typed starts a name that was paid before", () => {
    expect(nameLookupDelayMs({ answeredLocally: false, prefixOfPaidName: true }, PAUSE, PREFIX_PAUSE)).toBe(1500);
  });

  it("waits the ordinary pause for anything else", () => {
    expect(nameLookupDelayMs({ answeredLocally: false, prefixOfPaidName: false }, PAUSE, PREFIX_PAUSE)).toBe(400);
  });
});

describe("the prefix check the send field uses", () => {
  it("finds a paid name from its first letters, and not for the full name or an unrelated one", () => {
    const storage = memoryStorage();
    pinName("goat", "ark1goat", storage);
    expect(pinnedNamesStartingWith("goa", 1, storage).map((p) => p.name)).toEqual(["goat"]);
    expect(pinnedNamesStartingWith("go", 1, storage).map((p) => p.name)).toEqual(["goat"]);
    expect(pinnedNamesStartingWith("goat", 1, storage)).toEqual([]); // the exact name is not a prefix of itself
    expect(pinnedNamesStartingWith("cow", 1, storage)).toEqual([]);
  });
});
