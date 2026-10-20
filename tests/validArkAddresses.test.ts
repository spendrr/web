import { beforeEach, describe, expect, it } from "vitest";
import {
  isKnownValidArkAddress,
  rememberValidArkAddress,
  resetValidArkAddressesForTest,
} from "../src/lib/send/validArkAddresses";

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

const DAY = 24 * 3600 * 1000;

describe("valid ark address memory", () => {
  beforeEach(() => resetValidArkAddressesForTest());

  it("knows nothing until an address was accepted", () => {
    expect(isKnownValidArkAddress("ark1a", fakeStorage(), 1000)).toBe(false);
  });

  it("survives a reload through storage", () => {
    const s = fakeStorage();
    rememberValidArkAddress("ark1a", s, 1000);
    resetValidArkAddressesForTest();
    expect(isKnownValidArkAddress("ark1a", s, 2000)).toBe(true);
    expect(isKnownValidArkAddress("ark1b", s, 2000)).toBe(false);
  });

  it("forgets an entry after 30 days", () => {
    const s = fakeStorage();
    rememberValidArkAddress("ark1a", s, 0);
    expect(isKnownValidArkAddress("ark1a", s, 29 * DAY)).toBe(true);
    expect(isKnownValidArkAddress("ark1a", s, 31 * DAY)).toBe(false);
    resetValidArkAddressesForTest();
    expect(isKnownValidArkAddress("ark1a", s, 31 * DAY)).toBe(false);
  });

  it("keeps at most 300 and drops the oldest first", () => {
    const s = fakeStorage();
    for (let i = 0; i < 305; i++) rememberValidArkAddress(`ark1addr${i}`, s, 1000 + i);
    resetValidArkAddressesForTest();
    expect(isKnownValidArkAddress("ark1addr0", s, 5000)).toBe(false);
    expect(isKnownValidArkAddress("ark1addr4", s, 5000)).toBe(false);
    expect(isKnownValidArkAddress("ark1addr5", s, 5000)).toBe(true);
    expect(isKnownValidArkAddress("ark1addr304", s, 5000)).toBe(true);
  });

  it("ignores corrupt or hostile storage content", () => {
    for (const raw of ["not json", "[]", "null", '{"ark1a":"yes"}', '{"ark1a":-5e99}']) {
      resetValidArkAddressesForTest();
      const s = fakeStorage();
      s.setItem("btc-wallet-valid-ark-addrs-v1:bitcoin", raw);
      expect(isKnownValidArkAddress("ark1a", s, 1000)).toBe(false);
    }
  });

  it("still works when storage throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    rememberValidArkAddress("ark1a", broken, 1000);
    expect(isKnownValidArkAddress("ark1a", broken, 2000)).toBe(true);
  });
});
