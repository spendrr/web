import { afterEach, describe, expect, it } from "vitest";
import { clearEngineStates } from "../../src/lib/refreshEngine/runner";

class MemStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

describe("clearEngineStates (wallet reset)", () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("removes every wallet's engine state and keeps the mode setting and everything else", () => {
    const ls = new MemStorage();
    (globalThis as { localStorage?: unknown }).localStorage = ls;
    ls.setItem("btc-wallet-refresh-engine:aaaa", "{}");
    ls.setItem("btc-wallet-refresh-engine:bbbb", "{}");
    ls.setItem("btc-wallet-refresh-engine-mode", "live");
    ls.setItem("btc-wallet-vault", "v");
    clearEngineStates();
    expect(ls.getItem("btc-wallet-refresh-engine:aaaa")).toBeNull();
    expect(ls.getItem("btc-wallet-refresh-engine:bbbb")).toBeNull();
    expect(ls.getItem("btc-wallet-refresh-engine-mode")).toBe("live");
    expect(ls.getItem("btc-wallet-vault")).toBe("v");
  });
});
