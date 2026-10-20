// Tests for src/lib/wallet/onchainReceiveAddress.ts — the logic that decides
// whether a cached onchain receive address has actually been paid to yet
// (see the module's own doc comment for why an outpoint-set diff, not the
// balance or the address itself, is what answers that).
import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { OnchainUtxo } from "@secondts/bark";
import {
  clearStoredReceiveAddress,
  evaluateReceiveAddressUsage,
  hasNewOutpoint,
  loadStoredReceiveAddress,
  saveReceiveAddress,
  snapshotOutpoints,
} from "../src/lib/wallet/onchainReceiveAddress";

const local = (txid: string, vout: number, amountSats = 1000): OnchainUtxo => ({
  type: "local",
  outpoint: { txid, vout },
  amountSats,
  confirmationHeight: undefined,
});

const exitUtxo = (vtxoId: string): OnchainUtxo => ({ type: "exit", vtxoId, amountSats: 1000, height: 1 });

describe("snapshotOutpoints / hasNewOutpoint", () => {
  it("is not used when the baseline already contains every current outpoint", () => {
    const utxos = [local("aa", 0), local("bb", 1)];
    const baseline = snapshotOutpoints(utxos);
    expect(hasNewOutpoint(utxos, baseline)).toBe(false);
  });

  it("is used once a new local outpoint appears that wasn't in the baseline", () => {
    const baseline = snapshotOutpoints([local("aa", 0)]);
    expect(hasNewOutpoint([local("aa", 0), local("bb", 1)], baseline)).toBe(true);
  });

  it("ignores exit-type utxos — they aren't payments to the receive address", () => {
    const baseline = snapshotOutpoints([]);
    expect(hasNewOutpoint([exitUtxo("v1")], baseline)).toBe(false);
  });

  it("treats a spent-then-gone outpoint as still not 'new' (fewer utxos, no new ones)", () => {
    const baseline = snapshotOutpoints([local("aa", 0), local("bb", 1)]);
    expect(hasNewOutpoint([local("aa", 0)], baseline)).toBe(false);
  });

  it("distinguishes outpoints by both txid and vout", () => {
    const baseline = snapshotOutpoints([local("aa", 0)]);
    // Same txid, different vout — a genuinely different outpoint.
    expect(hasNewOutpoint([local("aa", 1)], baseline)).toBe(true);
  });

  it("never reports a false 'used' for any baseline that is a superset of the current utxos", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.string({ minLength: 2, maxLength: 8 }), fc.nat(10)), { maxLength: 20 }),
        fc.array(fc.tuple(fc.string({ minLength: 2, maxLength: 8 }), fc.nat(10)), { maxLength: 20 }),
        (baselinePairs, extraPairs) => {
          const baselineUtxos = baselinePairs.map(([txid, vout]) => local(txid, vout));
          const baseline = snapshotOutpoints(baselineUtxos);
          // Current utxos are a subset of baseline plus possibly-new ones —
          // "subset only" case must never flag as used.
          const subset = baselineUtxos.slice(0, Math.max(0, baselineUtxos.length - 1));
          expect(hasNewOutpoint(subset, baseline)).toBe(false);
          // Adding any outpoint not already in the baseline set must flag it,
          // unless every "extra" outpoint happens to collide with baseline.
          const extraUtxos = extraPairs.map(([txid, vout]) => local(txid, vout));
          const combined = [...subset, ...extraUtxos];
          const known = new Set(baseline);
          const genuinelyNew = extraUtxos.some((u) => !known.has(`${u.outpoint.txid}:${u.outpoint.vout}`));
          expect(hasNewOutpoint(combined, baseline)).toBe(genuinelyNew);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("evaluateReceiveAddressUsage", () => {
  const SCANNED_KEY = "btc-wallet-onchain-scanned";
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  it("never rotates while the initial onchain scan hasn't completed yet, even with a brand new outpoint", () => {
    // Real scenario this guards: an imported wallet with years of prior
    // onchain history. App.tsx's background initialScan() hasn't resolved
    // yet, so a historical UTXO it's in the middle of discovering would
    // otherwise look exactly like hasNewOutpoint() as a payment that just
    // arrived on the address the user may have only just shared.
    const result = evaluateReceiveAddressUsage([local("historical", 0)], []);
    expect(result.rotate).toBe(false);
    // The baseline widens to include it, so it's never mistaken for new
    // again once the scan flag does flip.
    expect(result.baseline).toEqual(["historical:0"]);
  });

  it("keeps widening the baseline every tick until the scan flag flips", () => {
    let baseline: string[] = [];
    ({ baseline } = evaluateReceiveAddressUsage([local("a", 0)], baseline));
    ({ baseline } = evaluateReceiveAddressUsage([local("a", 0), local("b", 0)], baseline));
    expect(baseline.sort()).toEqual(["a:0", "b:0"]);
  });

  it("defers to hasNewOutpoint() once the scan is marked done", () => {
    store.set(SCANNED_KEY, "1");
    const baseline = snapshotOutpoints([local("a", 0)]);
    expect(evaluateReceiveAddressUsage([local("a", 0)], baseline).rotate).toBe(false);
    expect(evaluateReceiveAddressUsage([local("a", 0), local("b", 0)], baseline).rotate).toBe(true);
  });

  it("treats inaccessible storage as 'scan done' rather than as 'never done'", () => {
    // A caller stuck permanently in widen-mode would never rotate a used
    // address — the worse failure mode of the two — so an unreadable flag
    // must fall the other way, matching isInitialOnchainScanDone()'s doc
    // comment.
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    const baseline = snapshotOutpoints([local("a", 0)]);
    expect(evaluateReceiveAddressUsage([local("a", 0), local("b", 0)], baseline).rotate).toBe(true);
  });
});

describe("loadStoredReceiveAddress / saveReceiveAddress / clearStoredReceiveAddress", () => {
  const KEY = "btc-wallet-onchain-receive-address";
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  it("returns null when nothing is stored", () => {
    expect(loadStoredReceiveAddress()).toBeNull();
  });

  it("round-trips an address and its baseline", () => {
    saveReceiveAddress("bc1qexample", ["aa:0", "bb:1"]);
    expect(loadStoredReceiveAddress()).toEqual({ address: "bc1qexample", baseline: ["aa:0", "bb:1"] });
  });

  it("clears what was stored", () => {
    saveReceiveAddress("bc1qexample", []);
    clearStoredReceiveAddress();
    expect(loadStoredReceiveAddress()).toBeNull();
  });

  it("returns null rather than throwing on corrupted json", () => {
    store.set(KEY, "{not json");
    expect(loadStoredReceiveAddress()).toBeNull();
  });

  it("returns null on a malformed shape (e.g. baseline not an array of strings)", () => {
    store.set(KEY, JSON.stringify({ address: "bc1q", baseline: [1, 2] }));
    expect(loadStoredReceiveAddress()).toBeNull();
    store.set(KEY, JSON.stringify({ address: 5, baseline: [] }));
    expect(loadStoredReceiveAddress()).toBeNull();
  });
});
