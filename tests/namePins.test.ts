import { describe, expect, it } from "vitest";
import { checkNamePin, distinctSuggestions, pinName, pinnedAddressFor, pinnedNamesStartingWith } from "../src/lib/names/namePins";

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

describe("name pins", () => {
  it("calls an unseen name new, then same, then changed", () => {
    const s = fakeStorage();
    expect(checkNamePin("pavel", "ark1a", s)).toBe("new");
    pinName("pavel", "ark1a", s);
    expect(checkNamePin("pavel", "ark1a", s)).toBe("same");
    expect(checkNamePin("pavel", "ark1b", s)).toBe("changed");
    expect(checkNamePin("someone_else", "ark1a", s)).toBe("new");
  });

  it("re-pinning after an accepted change makes the new address the trusted one", () => {
    const s = fakeStorage();
    pinName("pavel", "ark1a", s);
    pinName("pavel", "ark1b", s);
    expect(checkNamePin("pavel", "ark1b", s)).toBe("same");
    expect(checkNamePin("pavel", "ark1a", s)).toBe("changed");
  });

  it("survives corrupt or hostile stored data by treating it as empty", () => {
    for (const raw of ["not json", "[]", "null", "42", '{"pavel": 5}', '{"__proto__": "x"}']) {
      const s = fakeStorage();
      s.setItem("btc-wallet-name-pins", raw);
      expect(checkNamePin("pavel", "ark1a", s)).toBe("new");
    }
  });

  it("keeps only the most recently paid names", () => {
    const s = fakeStorage();
    for (let i = 0; i < 600; i++) pinName(`name_${i}`, `ark1${i}`, s);
    expect(checkNamePin("name_0", "ark10", s)).toBe("new");
    expect(checkNamePin("name_599", "ark1599", s)).toBe("same");
  });

  it("does not throw when storage does", () => {
    const s = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(checkNamePin("pavel", "ark1a", s)).toBe("new");
    expect(() => pinName("pavel", "ark1a", s)).not.toThrow();
  });
});

describe("nameForAddress", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    } as unknown as Storage;
  };
  it("reads a pin backwards, newest wins, and misses cleanly", async () => {
    const { pinName, nameForAddress, nameForAny } = await import("../src/lib/names/namePins");
    const s = mem();
    pinName("pavel", "ark1a", s);
    pinName("pavel2", "ark1a", s);
    expect(nameForAddress("ark1a", s)).toBe("pavel2");
    expect(nameForAddress("ark1zzz", s)).toBeNull();
    expect(nameForAny(["ark1x", "ark1a"], s)).toBe("pavel2");
  });
});

describe("nameForPayment", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    } as unknown as Storage;
  };
  it("finds a name by a wrapped address, or by amount and time when the address says nothing", async () => {
    const { pinName, logNamedPayment, nameForPayment } = await import("../src/lib/names/namePins");
    const s = mem();
    pinName("pavel", "ark1abc", s);
    const wrapped = { sentToAddresses: ['{"type":"ark","value":"ARK1ABC"}'], effectiveBalanceSats: -1000, createdAt: 0 };
    expect(nameForPayment(wrapped, s)).toBe("pavel");
    logNamedPayment("eva", 2000, 1_000_000, s);
    const opaque = (sats: number, at: number) => ({ sentToAddresses: ["???"], effectiveBalanceSats: -sats, createdAt: at });
    expect(nameForPayment(opaque(2000, 1_060_000), s)).toBe("eva");
    expect(nameForPayment(opaque(2010, 1_060_000), s)).toBe("eva");
    expect(nameForPayment(opaque(2000, 9_000_000), s)).toBeNull();
    expect(nameForPayment(opaque(5000, 1_060_000), s)).toBeNull();
  });
  it("never lends a logged name to a payment whose record names another destination", async () => {
    const { logNamedPayment, nameForPayment } = await import("../src/lib/names/namePins");
    const s = mem();
    logNamedPayment("eva", 2000, 1_000_000, s);
    const to = (dest: string) => ({ sentToAddresses: [dest], effectiveBalanceSats: -2000, createdAt: 1_060_000 });
    expect(nameForPayment(to("ark1qsomeoneelse"), s)).toBeNull();
    expect(nameForPayment(to('{"type":"ark","address":"ark1qsomeoneelse"}'), s)).toBeNull();
    expect(nameForPayment(to("lnbc20u1pexample"), s)).toBeNull();
    expect(nameForPayment(to("bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"), s)).toBeNull();
    expect(nameForPayment(to("satoshi@example.com"), s)).toBeNull();
    expect(nameForPayment({ ...to(""), sentToAddresses: [] }, s)).toBe("eva");
  });
});

describe("pinnedNamesStartingWith", () => {
  it("suggests paid names by prefix, most recently paid first, never the exact name typed", () => {
    const s = fakeStorage();
    pinName("pavel", "ark1a", s);
    pinName("pavla", "ark1b", s);
    pinName("petr", "ark1c", s);
    pinName("pavel", "ark1a", s); // paid again: most recent now
    expect(pinnedNamesStartingWith("pav", 3, s)).toEqual([
      { name: "pavel", address: "ark1a" },
      { name: "pavla", address: "ark1b" },
    ]);
    expect(pinnedNamesStartingWith("PA", 1, s)).toEqual([{ name: "pavel", address: "ark1a" }]);
    expect(pinnedNamesStartingWith("pavel", 3, s)).toEqual([]);
    expect(pinnedNamesStartingWith("x", 3, s)).toEqual([]);
  });
});


describe("cached reads", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    } as unknown as Storage;
  };

  it("sees a write made behind its back, and its own writes, at once", async () => {
    const { pinName, checkNamePin, nameForAddress, pinnedNamesStartingWith } = await import("../src/lib/names/namePins");
    const s = mem();
    expect(nameForAddress("ark1a", s)).toBeNull();
    pinName("pavel", "ark1a", s);
    expect(nameForAddress("ark1a", s)).toBe("pavel");
    // another tab
    s.setItem("btc-wallet-name-pins", JSON.stringify({ pavel: "ark1a", eva: "ark1b" }));
    expect(checkNamePin("eva", "ark1b", s)).toBe("same");
    expect(nameForAddress("ark1b", s)).toBe("eva");
    expect(pinnedNamesStartingWith("e", 3, s).map((e) => e.name)).toEqual(["eva"]);
    s.setItem("btc-wallet-name-pins", "not json");
    expect(nameForAddress("ark1b", s)).toBeNull();
  });

  it("never lets a caller change what a later read sees", async () => {
    const { pinName, pinnedNamesStartingWith, checkNamePin } = await import("../src/lib/names/namePins");
    const s = mem();
    pinName("pavel", "ark1a", s);
    pinnedNamesStartingWith("p", 3, s).push({ name: "x", address: "y" });
    pinName("eva", "ark1b", s);
    expect(checkNamePin("pavel", "ark1a", s)).toBe("same");
    expect(checkNamePin("eva", "ark1b", s)).toBe("same");
    expect(checkNamePin("x", "y", s)).toBe("new");
  });

  it("keeps matching the payment log after appends and outside writes", async () => {
    const { logNamedPayment, nameForPayment } = await import("../src/lib/names/namePins");
    const s = mem();
    const row = (sats: number, at: number) => ({ sentToAddresses: ["???"], effectiveBalanceSats: -sats, createdAt: at });
    expect(nameForPayment(row(2000, 1_000_000), s)).toBeNull();
    logNamedPayment("eva", 2000, 1_000_000, s);
    expect(nameForPayment(row(2000, 1_000_000), s)).toBe("eva");
    logNamedPayment("jan", 3000, 2_000_000, s);
    expect(nameForPayment(row(2000, 1_000_000), s)).toBe("eva");
    expect(nameForPayment(row(3000, 2_000_000), s)).toBe("jan");
    s.setItem("btc-wallet-name-payments", "garbage");
    expect(nameForPayment(row(2000, 1_000_000), s)).toBeNull();
  });
});

describe("pinnedAddressFor", () => {
  it("returns the pinned address for an exact name only", () => {
    const storage = fakeStorage();
    pinName("pavel", "ark1pavel", storage);
    expect(pinnedAddressFor("pavel", storage)).toBe("ark1pavel");
    expect(pinnedAddressFor("pave", storage)).toBeNull();
  });
});

describe("distinctSuggestions", () => {
  const list = [
    { name: "merry-chive", address: "ark1a" },
    { name: "merry-old", address: "ark1a" },
    { name: "merrick", address: "ark1b" },
  ];

  it("keeps the most recent name per address", () => {
    expect(distinctSuggestions(list, null).map((s) => s.name)).toEqual(["merry-chive", "merrick"]);
  });

  it("drops a pin whose address the typed name already resolved to", () => {
    expect(distinctSuggestions(list, "ark1a").map((s) => s.name)).toEqual(["merrick"]);
  });

  it("leaves unrelated suggestions alone", () => {
    expect(distinctSuggestions(list, "ark1z")).toHaveLength(2);
  });
});
