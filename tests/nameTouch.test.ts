import { afterEach, describe, expect, it, vi } from "vitest";
import type { WalletClient } from "../src/lib/wallet/bark";
import { NAME_TOUCH_INTERVAL_MS, getCachedName, maybeTouchName, setCachedName, setHasHandle } from "../src/lib/names/nameTouch";

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

const wallet = {
  mailboxIdentifier: async () => "02" + "aa".repeat(32),
  mailboxAuthorization: async () => "02" + "aa".repeat(32) + "00".repeat(8) + "bb".repeat(64),
} as unknown as WalletClient;

function serverSays(status: number, body?: unknown) {
  const f = vi.fn(async () => new Response(JSON.stringify(body ?? {}), { status }));
  vi.stubGlobal("fetch", f);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

describe("maybeTouchName", () => {
  it("does nothing for a wallet that has never had a name", async () => {
    const f = serverSays(200, { name: "pavel", address: "ark1x" });
    await maybeTouchName(wallet, fakeStorage(), 1_000_000);
    expect(f).not.toHaveBeenCalled();
  });

  it("touches the registry when the last touch is more than a week old, and then waits a week", async () => {
    const s = fakeStorage();
    setHasHandle(true, s);
    const f = serverSays(200, { name: "pavel", address: "ark1x" });
    const t0 = 5_000_000_000;
    await maybeTouchName(wallet, s, t0);
    expect(f).toHaveBeenCalledTimes(1);
    await maybeTouchName(wallet, s, t0 + NAME_TOUCH_INTERVAL_MS - 1000);
    expect(f).toHaveBeenCalledTimes(1);
    await maybeTouchName(wallet, s, t0 + NAME_TOUCH_INTERVAL_MS + 1000);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("forgets the flag when the registry says the wallet has no name", async () => {
    const s = fakeStorage();
    setHasHandle(true, s);
    serverSays(404, { error: "No name." });
    await maybeTouchName(wallet, s, 5_000_000_000);
    const f = serverSays(200, { name: "pavel", address: "ark1x" });
    await maybeTouchName(wallet, s, 5_000_000_000 + 10 * NAME_TOUCH_INTERVAL_MS);
    expect(f).not.toHaveBeenCalled();
  });

  it("swallows every failure and tries again next time, without recording a touch", async () => {
    const s = fakeStorage();
    setHasHandle(true, s);
    const t0 = 5_000_000_000;
    serverSays(500);
    await expect(maybeTouchName(wallet, s, t0)).resolves.toBeUndefined();
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    await expect(maybeTouchName(wallet, s, t0)).resolves.toBeUndefined();
    const f = serverSays(200, { name: "pavel", address: "ark1x" });
    await maybeTouchName(wallet, s, t0 + 1);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("survives blocked storage", async () => {
    const s = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    await expect(maybeTouchName(wallet, s, 1)).resolves.toBeUndefined();
    expect(() => setHasHandle(true, s)).not.toThrow();
  });
});

describe("cached name", () => {
  const mine = { name: "pavel", address: "ark1x", lnAddress: true };

  it("is only returned for the wallet it was stored for", () => {
    const s = fakeStorage();
    setCachedName("ark1wallet", mine, s);
    expect(getCachedName("ark1wallet", s)).toEqual(mine);
    expect(getCachedName("ark1other", s)).toBeNull();
  });

  it("is cleared with the has-handle flag and by a null write", () => {
    const s = fakeStorage();
    setCachedName("ark1wallet", mine, s);
    setHasHandle(false, s);
    expect(getCachedName("ark1wallet", s)).toBeNull();
    setCachedName("ark1wallet", mine, s);
    setCachedName("ark1wallet", null, s);
    expect(getCachedName("ark1wallet", s)).toBeNull();
  });

  it("ignores garbage in storage", () => {
    const s = fakeStorage();
    s.setItem("btc-wallet-my-name", "{not json");
    expect(getCachedName("ark1wallet", s)).toBeNull();
    s.setItem("btc-wallet-my-name", JSON.stringify({ wallet: "ark1wallet", name: 5 }));
    expect(getCachedName("ark1wallet", s)).toBeNull();
  });

  it("is refreshed by the weekly touch, and dropped when the name is gone", async () => {
    const s = fakeStorage();
    setHasHandle(true, s);
    setCachedName("ark1wallet", mine, s);
    serverSays(200, { name: "petr", address: "ark1y", lnAddress: false });
    await maybeTouchName(wallet, s, 1_000_000_000_000);
    expect(getCachedName("ark1wallet", s)).toEqual({ name: "petr", address: "ark1y", lnAddress: false });

    serverSays(404, { status: "none" });
    await maybeTouchName(wallet, s, 1_000_000_000_000 + NAME_TOUCH_INTERVAL_MS + 1);
    expect(getCachedName("ark1wallet", s)).toBeNull();
  });
});
