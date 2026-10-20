import { describe, expect, it, vi } from "vitest";
import { createWalletTabLock } from "../src/lib/wallet/walletTabLock";

// A minimal in-memory LockManager shared by several "tabs": exclusive locks,
// ifAvailable only (the one mode walletTabLock uses), held until the
// callback's returned promise settles, like the real API.
function fakeLocks() {
  const held = new Set<string>();
  const manager = {
    request(name: string, _opts: { ifAvailable: boolean }, cb: (lock: { name: string } | null) => unknown) {
      if (held.has(name)) return Promise.resolve(cb(null));
      held.add(name);
      return Promise.resolve(cb({ name })).finally(() => held.delete(name));
    },
    query() {
      return Promise.resolve({ held: [...held].map((name) => ({ name })), pending: [] });
    },
  };
  return { manager: manager as unknown as Pick<LockManager, "request" | "query">, held };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("walletTabLock", () => {
  it("lets only one tab hold the wallet", async () => {
    const { manager } = fakeLocks();
    const tabA = createWalletTabLock(manager);
    const tabB = createWalletTabLock(manager);
    expect(await tabA.acquire()).toBe(true);
    expect(await tabB.acquire()).toBe(false);
    expect(await tabB.heldElsewhere()).toBe(true);
    // The holder never reports its own lock as "elsewhere".
    expect(await tabA.heldElsewhere()).toBe(false);
  });

  it("hands the wallet over once the holder releases", async () => {
    const { manager, held } = fakeLocks();
    const tabA = createWalletTabLock(manager);
    const tabB = createWalletTabLock(manager);
    await tabA.acquire();
    tabA.release();
    await flush();
    expect(held.size).toBe(0);
    expect(await tabB.heldElsewhere()).toBe(false);
    expect(await tabB.acquire()).toBe(true);
    expect(await tabA.acquire()).toBe(false);
  });

  it("is re-entrant within one tab, including concurrent callers", async () => {
    const { manager } = fakeLocks();
    const tab = createWalletTabLock(manager);
    const [a, b] = await Promise.all([tab.acquire(), tab.acquire()]);
    expect([a, b]).toEqual([true, true]);
    expect(await tab.acquire()).toBe(true);
  });

  it("release without holding is a no-op", async () => {
    const { manager } = fakeLocks();
    const tabA = createWalletTabLock(manager);
    const tabB = createWalletTabLock(manager);
    await tabA.acquire();
    tabB.release();
    await flush();
    expect(await tabB.acquire()).toBe(false);
  });

  it("fails open without Web Locks, or when the request throws", async () => {
    expect(await createWalletTabLock(undefined).acquire()).toBe(true);
    expect(await createWalletTabLock(undefined).heldElsewhere()).toBe(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = {
      request: () => Promise.reject(new Error("SecurityError")),
      query: () => Promise.reject(new Error("SecurityError")),
    } as unknown as Pick<LockManager, "request" | "query">;
    const tab = createWalletTabLock(broken);
    expect(await tab.acquire()).toBe(true);
    expect(await tab.heldElsewhere()).toBe(false);
    warn.mockRestore();
  });
});

describe("walletTabLock beta gate", () => {
  it("neither takes nor reports the lock while disabled", async () => {
    const { manager, held } = fakeLocks();
    let on = false;
    const tabA = createWalletTabLock(manager, undefined, () => on);
    const tabB = createWalletTabLock(manager);
    expect(await tabA.acquire()).toBe(true);
    expect(held.size).toBe(0);
    expect(await tabB.acquire()).toBe(true);
    expect(await tabA.heldElsewhere()).toBe(false);
    on = true;
    expect(await tabA.heldElsewhere()).toBe(true);
    expect(await tabA.acquire()).toBe(false);
  });
});
