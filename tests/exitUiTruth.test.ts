// What the exit screens say about progress, fees and the finished exit
// (signet run 2026-10-06/07: "9 z 12" became "6 z 8", "chybí ~28 sats" with
// 51k sats unconfirmed, "355 203 sats je na tvé adrese" when 73 166 arrived).
import { beforeEach, describe, expect, it } from "vitest";
import type { ExitVtxo } from "@secondts/bark";
import {
  FEE_PENDING_GRACE_BLOCKS,
  buildExitOverview,
  feesStalled,
  mergeExitTxs,
  type ExitClaimRecord,
} from "../src/lib/exit/exitModel";
import { completionArrivedSats, getExitCompletion, recordExitCompletions } from "../src/lib/exit/emergencyExit";

const block = (height: number) => ({ height, hash: `h${height}` });

function processing(txs: [string, boolean][]): ExitVtxo["state"] {
  return {
    type: "processing",
    tipHeight: 100,
    transactions: txs.map(([txid, confirmed]) => ({
      txid,
      status: confirmed
        ? { type: "confirmed", childTxid: `c-${txid}`, block: block(90), origin: { type: "mempool" } }
        : { type: "awaiting-confirmation", childTxid: `c-${txid}`, origin: { type: "mempool" } },
    })) as never,
  };
}

const exit = (id: string, state: ExitVtxo["state"], amountSats = 10_000): ExitVtxo => ({
  vtxoId: id,
  amountSats,
  state,
  isClaimable: state.type === "claimable",
});

describe("exit transaction progress", () => {
  it("counts transactions shared by sibling coins once", () => {
    // Three coins from one arkoor payment: same round leaf and split tx.
    const exits = ["a", "b", "c"].map((id) =>
      exit(id, processing([["leaf", true], ["split", true], [`own-${id}`, false]])),
    );
    const o = buildExitOverview(exits, [], [], 0);
    expect(o.txProgress).toEqual({ confirmed: 2, total: 5 });
  });

  it("never drops when a coin moves on to the timelock", () => {
    const before = buildExitOverview(
      [exit("a", processing([["leaf", true], ["a1", true]])), exit("b", processing([["leaf", true], ["b1", false]]))],
      [],
      [],
      0,
    );
    const seen = mergeExitTxs({}, before.coins);
    const after = buildExitOverview(
      [
        exit("a", { type: "awaiting-delta", tipHeight: 101, confirmedBlock: block(100), claimableHeight: 110 }),
        exit("b", processing([["leaf", true], ["b1", true]])),
      ],
      [],
      [],
      0,
      null,
      null,
      seen,
    );
    expect(before.txProgress).toEqual({ confirmed: 2, total: 3 });
    expect(after.txProgress).toEqual({ confirmed: 3, total: 3 });
  });

  it("a confirmed transaction stays confirmed", () => {
    const seen = mergeExitTxs({ t: true }, buildExitOverview([exit("a", processing([["t", false]]))], [], [], 0).coins);
    expect(seen).toEqual({ t: true });
  });
});

describe("feesStalled", () => {
  const base = {
    broadcasting: true,
    fundable: false,
    feeStalled: true,
    neededSats: 1_000,
    onchain: { confirmedSats: 0, pendingSats: 51_206 },
    coveredSinceTip: 100,
    tip: 100,
  };

  it("unconfirmed money covering the rest is a wait, not a stall", () => {
    expect(feesStalled(base)).toBe(false);
    expect(feesStalled({ ...base, tip: 100 + FEE_PENDING_GRACE_BLOCKS - 1 })).toBe(false);
  });

  it("stalls after the grace blocks (a payment stuck in the mempool)", () => {
    expect(feesStalled({ ...base, tip: 100 + FEE_PENDING_GRACE_BLOCKS })).toBe(true);
  });

  it("stalls at once when even the unconfirmed money is short", () => {
    expect(feesStalled({ ...base, onchain: { confirmedSats: 200, pendingSats: 700 } })).toBe(true);
    expect(feesStalled({ ...base, onchain: { confirmedSats: 0, pendingSats: 0 } })).toBe(true);
    expect(feesStalled({ ...base, onchain: null })).toBe(true);
  });

  it("is never stalled when bark can fund it or nothing is left to broadcast", () => {
    expect(feesStalled({ ...base, fundable: true, onchain: null })).toBe(false);
    expect(feesStalled({ ...base, broadcasting: false, onchain: null })).toBe(false);
  });

  it("without a budget yet, bark's own stuck state decides", () => {
    expect(feesStalled({ ...base, fundable: null, neededSats: null, onchain: null })).toBe(true);
    expect(feesStalled({ ...base, fundable: null, feeStalled: false, neededSats: null, onchain: null })).toBe(false);
  });
});

describe("exit completion", () => {
  beforeEach(() => localStorage.clear());

  const claimed = (id: string, amountSats: number, claimTxid: string) =>
    buildExitOverview(
      [exit(id, { type: "claimed", tipHeight: 120, txid: claimTxid, block: block(120) }, amountSats)],
      [],
      [],
      0,
    ).coins[0];

  const ours: ExitClaimRecord = {
    vtxoIds: ["x", "y", "z"],
    address: "tb1pours",
    amountSats: 137_627,
    feeSats: 64_461,
    txid: "8c42",
    attemptedAt: 5,
    sentAt: 6,
  };

  it("shows only claims this device sent, with what arrived", () => {
    const coins = [
      claimed("x", 68_314, "8c42"),
      claimed("y", 68_313, "8c42"),
      claimed("z", 1_000, "8c42"),
      // A months-old exit bark finds again after a restore from seed.
      claimed("old", 79_949, "201f"),
      // The arkoor parent bark reports "claimed" by the split transaction.
      claimed("parent", 137_627, "1bc4"),
    ];
    const c = recordExitCompletions(coins, [ours], 10)!;
    expect(Object.values(c.claims)).toEqual([
      { txid: "8c42", address: "tb1pours", vtxoIds: ["x", "y", "z"], arrivedSats: 73_166, feeSats: 64_461 },
    ]);
    expect(completionArrivedSats(c)).toBe(73_166);
    expect(recordExitCompletions(coins, [ours], 11)).toBeNull();
  });

  it("records nothing for claims it didn't send", () => {
    expect(recordExitCompletions([claimed("old", 79_949, "201f")], [], 10)).toBeNull();
    expect(getExitCompletion()).toBeNull();
  });

  it("no amount when the fee isn't known", () => {
    const c = recordExitCompletions([claimed("x", 1_000, "aa")], [{ ...ours, vtxoIds: ["x"], feeSats: null }], 10)!;
    expect(completionArrivedSats(c)).toBeNull();
  });

  it("ignores a value stored in the old per-coin shape", () => {
    localStorage.setItem(
      "btc-wallet-exit-completion",
      JSON.stringify({ coins: { a: { amountSats: 355_203, txid: "x", address: null } }, dismissed: false, updatedAt: 0 }),
    );
    expect(getExitCompletion()).toBeNull();
  });
});
