import { describe, expect, it, vi } from "vitest";
import { dropVtxoSnapshot, readVtxosShared, recordVtxoRead, VTXO_SNAPSHOT_TTL_MS } from "../src/lib/wallet/vtxoSnapshot";
import type { WalletClient } from "../src/lib/wallet/bark";

let n = 0;
function fakeWallet(read: () => Promise<unknown[]>) {
  const allVtxos = vi.fn(read);
  return { wallet: { fingerprint: `fp${n++}`, vtxos: allVtxos } as unknown as WalletClient, allVtxos };
}

describe("readVtxosShared", () => {
  it("reads once for readers that overlap", async () => {
    const { wallet, allVtxos } = fakeWallet(async () => [{ id: "a" }]);
    const [x, y] = await Promise.all([readVtxosShared(wallet), readVtxosShared(wallet)]);
    expect(x).toBe(y);
    expect(allVtxos).toHaveBeenCalledTimes(1);
  });

  it("reuses a result inside the TTL, reads again after it", async () => {
    const { wallet, allVtxos } = fakeWallet(async () => []);
    await readVtxosShared(wallet, 1_000);
    await readVtxosShared(wallet, 1_000 + 100);
    expect(allVtxos).toHaveBeenCalledTimes(1);
    await readVtxosShared(wallet, Date.now() + VTXO_SNAPSHOT_TTL_MS + 1);
    expect(allVtxos).toHaveBeenCalledTimes(2);
  });

  it("a drop forces a fresh read, and a read in flight at the drop is not kept", async () => {
    let release!: (v: unknown[]) => void;
    const first = new Promise<unknown[]>((r) => (release = r));
    const { wallet, allVtxos } = fakeWallet(() => (allVtxosCalls++ === 0 ? first : Promise.resolve([{ id: "new" }])));
    let allVtxosCalls = 0;
    const p = readVtxosShared(wallet);
    dropVtxoSnapshot(wallet.fingerprint);
    release([{ id: "old" }]);
    await p;
    const again = await readVtxosShared(wallet);
    expect(allVtxos).toHaveBeenCalledTimes(2);
    expect(again).toEqual([{ id: "new" }]);
  });

  it("a failed read is not cached", async () => {
    let fail = true;
    const { wallet, allVtxos } = fakeWallet(async () => {
      if (fail) throw new Error("x");
      return [];
    });
    await expect(readVtxosShared(wallet)).rejects.toThrow("x");
    fail = false;
    await expect(readVtxosShared(wallet)).resolves.toEqual([]);
    expect(allVtxos).toHaveBeenCalledTimes(2);
  });

  it("serves a recorded fresh read", async () => {
    const { wallet, allVtxos } = fakeWallet(async () => []);
    recordVtxoRead(wallet.fingerprint, [{ id: "t" }] as never);
    expect(await readVtxosShared(wallet)).toEqual([{ id: "t" }]);
    expect(allVtxos).not.toHaveBeenCalled();
  });
});
