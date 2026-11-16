import { describe, expect, it } from "vitest";
import { refreshAndRelease, type RefreshSubmitWallet } from "../src/lib/wallet/refreshSubmit";
import { REFRESH_INPUTS_UNAVAILABLE, REFRESH_LIMIT_EXCEEDED } from "../src/lib/wallet/walletSession";

type State = { type: "spendable" } | { type: "spent" } | { type: "locked"; holder: { type: string; id: string | number } };

// bark-ffi's lock/unlock rules: lock only from Spendable (or the same holder),
// atomic; unlock with an expected holder fails as a whole on a coin locked by
// anyone else, and is a no-op on a Spendable one.
function fake(coins: Record<string, State>, submit: (ids: string[]) => Promise<{ id: number } | undefined> = async () => ({ id: 1 })) {
  const calls: string[] = [];
  const w: RefreshSubmitWallet = {
    async lockVtxos({ vtxoIds, holder }) {
      calls.push("lock");
      for (const id of vtxoIds) {
        const s = coins[id];
        const same = s.type === "locked" && s.holder.id === holder.id;
        if (s.type !== "spendable" && !same) throw new Error(`Lock VTXOs failed: ${id} is ${s.type}`);
      }
      for (const id of vtxoIds) coins[id] = { type: "locked", holder };
    },
    async unlockVtxos({ vtxoIds, expectedHolder }) {
      calls.push("unlock");
      if (vtxoIds.some((id) => coins[id].type !== "spendable" && !(coins[id].type === "locked" && (coins[id] as { holder: { id: unknown } }).holder.id === expectedHolder.id))) {
        throw new Error("refusing to unlock");
      }
      for (const id of vtxoIds) coins[id] = { type: "spendable" };
    },
    async refreshVtxosDelegated(ids) {
      calls.push("submit");
      // bark 0.8 refuses a participation over a coin that is not Spendable.
      for (const id of ids) expect(coins[id]).toEqual({ type: "spendable" });
      return submit(ids);
    },
  };
  return { w, coins, calls };
}

describe("refreshAndRelease (the worker's refreshVtxosDelegatedAndLock)", () => {
  it("probes with a lock, releases it, then submits", async () => {
    const f = fake({ a: { type: "spendable" }, b: { type: "spendable" } });
    const r = await refreshAndRelease(f.w, ["a", "b"], "spendrr-refresh", () => true);
    expect(r.round?.id).toBe(1);
    expect(f.coins).toEqual({ a: { type: "spendable" }, b: { type: "spendable" } });
    expect(f.calls).toEqual(["unlock", "unlock", "lock", "unlock", "submit"]);
  });

  it("a failed submit leaves the coins spendable too", async () => {
    const f = fake({ a: { type: "spendable" } }, async () => {
      throw new Error("server said no");
    });
    await expect(refreshAndRelease(f.w, ["a"], "spendrr-refresh", () => true)).rejects.toThrow("server said no");
    expect(f.coins.a).toEqual({ type: "spendable" });
  });

  it("a coin a payment took: nothing submitted, nothing charged", async () => {
    const f = fake({ a: { type: "spendable" }, b: { type: "spent" } });
    let charged = false;
    await expect(
      refreshAndRelease(f.w, ["a", "b"], "spendrr-refresh", () => (charged = true)),
    ).rejects.toThrow(REFRESH_INPUTS_UNAVAILABLE);
    expect(f.calls).not.toContain("submit");
    expect(charged).toBe(false);
  });

  it("over the daily cap: nothing submitted, the probe lock released", async () => {
    const f = fake({ a: { type: "spendable" } });
    await expect(refreshAndRelease(f.w, ["a"], "spendrr-refresh", () => false)).rejects.toThrow(REFRESH_LIMIT_EXCEEDED);
    expect(f.calls).not.toContain("submit");
    expect(f.coins.a).toEqual({ type: "spendable" });
  });

  it("takes over a lock of ours an older version left, and leaves none", async () => {
    const f = fake({ a: { type: "locked", holder: { type: "action", id: "spendrr-refresh" } }, b: { type: "spendable" } });
    await refreshAndRelease(f.w, ["a", "b"], "spendrr-refresh", () => true);
    expect(f.coins).toEqual({ a: { type: "spendable" }, b: { type: "spendable" } });
  });

  it("never touches a coin bark's round holds", async () => {
    const held: State = { type: "locked", holder: { type: "movement", id: 7 } };
    const f = fake({ a: held });
    await expect(refreshAndRelease(f.w, ["a"], "spendrr-refresh", () => true)).rejects.toThrow(REFRESH_INPUTS_UNAVAILABLE);
    expect(f.coins.a).toEqual(held);
  });

  it("a probe lock that will not release stops the submit", async () => {
    const f = fake({ a: { type: "spendable" } });
    let locked = false;
    const w = {
      ...f.w,
      async lockVtxos(a: Parameters<RefreshSubmitWallet["lockVtxos"]>[0]) {
        await f.w.lockVtxos(a);
        locked = true;
      },
      async unlockVtxos(a: Parameters<RefreshSubmitWallet["unlockVtxos"]>[0]) {
        if (locked) throw new Error("unlock failed");
        return f.w.unlockVtxos(a);
      },
    };
    await expect(refreshAndRelease(w, ["a"], "spendrr-refresh", () => true)).rejects.toThrow("unlock failed");
    expect(f.calls).not.toContain("submit");
  });
});
