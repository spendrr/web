import { beforeEach, describe, expect, it } from "vitest";
import { parseCanonicalArkAddress } from "../src/lib/send/arkAddressShape";
import {
  isKnownValidArkAddress,
  learnArkServerFrom,
  resetValidArkAddressesForTest,
} from "../src/lib/send/validArkAddresses";

// Real mainnet addresses (ark.second.tech). The server pubkey
// 0375b2e4...0b97b5 hashes (sha256) to e6af17ba..., the ark_id both carry.
const A = "ark1pu6h30w3zqqpupfulntdk6sry96mn0ze8wpfzkljxlnmr9hk9le3cxq50qpwy0qpzqyplaf69292snfun4vt68ws8k9u0cncx0ds33v3wh420kgas30vd96gnct82q";
const B = "ark1pu6h30w3zqqpcjz7rsl7f9u9za3t40y8fatgvez3lz0pk9z7l7hxkp5vy0gn3zlfzqyp8esn5vu2y7wmq6m6tq9jqp5s74hjgchdl2wg5gt8k7l2gw2py0dq43n2um";

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

describe("parseCanonicalArkAddress", () => {
  it("reads the ark_id of real addresses", () => {
    expect(parseCanonicalArkAddress(A)).toEqual({ testnet: false, arkId: "e6af17ba" });
    expect(parseCanonicalArkAddress(B)).toEqual({ testnet: false, arkId: "e6af17ba" });
  });

  it("refuses anything that is not that exact shape", () => {
    expect(parseCanonicalArkAddress("")).toBeNull();
    expect(parseCanonicalArkAddress("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).toBeNull();
    // one character changed: checksum fails
    expect(parseCanonicalArkAddress(A.slice(0, -1) + (A.endsWith("m") ? "l" : "m"))).toBeNull();
    // truncated
    expect(parseCanonicalArkAddress(A.slice(0, 60))).toBeNull();
  });
});

describe("server learned from an address", () => {
  beforeEach(() => resetValidArkAddressesForTest());

  it("knows nothing before it has learned a server", () => {
    expect(isKnownValidArkAddress(B, fakeStorage())).toBe(false);
  });

  it("accepts another address of the same server and keeps it across sessions", () => {
    const storage = fakeStorage();
    learnArkServerFrom(A, storage);
    expect(isKnownValidArkAddress(B, storage)).toBe(true);
    resetValidArkAddressesForTest();
    expect(isKnownValidArkAddress(B, storage)).toBe(true);
  });

  it("never learns from a malformed address", () => {
    const storage = fakeStorage();
    learnArkServerFrom("ark1notanaddress", storage);
    expect(isKnownValidArkAddress(B, storage)).toBe(false);
  });
});
