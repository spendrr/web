import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ExitVtxo } from "@secondts/bark";
import {
  CLAIM_GRACE_MS,
  EXIT_EXPIRY_WARN_BLOCKS,
  buildExitOverview,
  classifyBroadcastError,
  pruneClaimRecords,
  type ExitClaimRecord,
} from "../src/lib/exit/exitModel";
import { EXIT_LOCK_HOLDER_ID, planExitLocks, type ExitLockVtxo } from "../src/lib/exit/exitLocks";

const block = (height: number) => ({ height, hash: `h${height}` });

function exit(id: string, state: ExitVtxo["state"], amountSats = 10_000): ExitVtxo {
  return { vtxoId: id, amountSats, state, isClaimable: state.type === "claimable" };
}

const start = (): ExitVtxo["state"] => ({ type: "start", tipHeight: 100 });
const processing = (statuses: string[]): ExitVtxo["state"] => ({
  type: "processing",
  tipHeight: 100,
  transactions: statuses.map((type, i) => {
    const status =
      type === "confirmed"
        ? { type, childTxid: `c${i}`, block: block(90), origin: { type: "mempool" as const } }
        : type === "awaiting-confirmation"
          ? { type, childTxid: `c${i}`, origin: { type: "mempool" as const } }
          : type === "awaiting-input-confirmation"
            ? { type, txids: [] }
            : { type };
    return { txid: `t${i}`, status } as never;
  }),
});
const awaitingDelta = (tip: number, claimableHeight: number): ExitVtxo["state"] => ({
  type: "awaiting-delta",
  tipHeight: tip,
  confirmedBlock: block(tip - 1),
  claimableHeight,
});
const claimable = (): ExitVtxo["state"] => ({ type: "claimable", tipHeight: 200, claimableSince: block(190), lastScannedBlock: undefined });
const claimInProgress = (): ExitVtxo["state"] => ({ type: "claim-in-progress", tipHeight: 200, claimableSince: block(190), claimTxid: "claim1" });
const claimed = (): ExitVtxo["state"] => ({ type: "claimed", tipHeight: 210, txid: "claim1", block: block(205) });

const NOW = 1_000_000_000;

function record(ids: string[], at: number, sent = true): ExitClaimRecord {
  return { vtxoIds: ids, address: "bc1qdest", amountSats: 1, feeSats: 1, txid: sent ? "tx" : null, attemptedAt: at, sentAt: sent ? at : null };
}

describe("buildExitOverview", () => {
  it("is empty without exits", () => {
    const o = buildExitOverview([], [], [], NOW);
    expect(o.stage).toBe("none");
    expect(o.live).toBe(false);
  });

  it("reads tree progress for a coin that is broadcasting", () => {
    const o = buildExitOverview([exit("a", processing(["confirmed", "awaiting-confirmation", "awaiting-input-confirmation"]))], [], [], NOW);
    expect(o.stage).toBe("broadcasting");
    expect(o.coins[0]).toMatchObject({ phase: "broadcasting", txTotal: 3, txConfirmed: 1, waitingFor: "confirmation", currentTxid: "t1" });
    expect(o.broadcastingIds).toEqual(["a"]);
  });

  it("names a missing fee bump as the reason", () => {
    const o = buildExitOverview([exit("a", processing(["awaiting-cpfp-broadcast"]))], [], [], NOW);
    expect(o.coins[0].waitingFor).toBe("fee");
    expect(o.coins[0].cancelable).toBe(true);
  });

  it("is not cancelable once the last transaction went out", () => {
    const o = buildExitOverview([exit("a", processing(["confirmed", "awaiting-confirmation"]))], [], [], NOW);
    expect(o.cancelableIds).toEqual([]);
  });

  it("counts timelock blocks from the claimable height", () => {
    const o = buildExitOverview([exit("a", awaitingDelta(100, 244)), exit("b", awaitingDelta(100, 150))], [], [], NOW);
    expect(o.stage).toBe("timelock");
    expect(o.firstReadyInBlocks).toBe(50);
    expect(o.lastReadyInBlocks).toBe(144);
  });

  it("counts the timelock down from the chain tip, not bark's stale per-exit tip", () => {
    // bark keeps tipHeight at the confirmation height while the coin waits.
    const o = buildExitOverview([exit("a", awaitingDelta(324024, 324036))], [], [], NOW, null, 324028);
    expect(o.firstReadyInBlocks).toBe(8);
    expect(o.coins[0].blocksLeft).toBe(8);
    const past = buildExitOverview([exit("a", awaitingDelta(324024, 324036))], [], [], NOW, null, 324040);
    expect(past.coins[0].blocksLeft).toBe(0);
    // An older chain tip never pushes the count back up.
    const older = buildExitOverview([exit("a", awaitingDelta(324030, 324036))], [], [], NOW, null, 324020);
    expect(older.coins[0].blocksLeft).toBe(6);
  });

  it("offers a claimable coin and prefers 'ready' as the headline", () => {
    const o = buildExitOverview([exit("a", claimable(), 5_000), exit("b", awaitingDelta(100, 150))], ["a"], [], NOW);
    expect(o.stage).toBe("ready");
    expect(o.claimableIds).toEqual(["a"]);
    expect(o.claimableSats).toBe(5_000);
  });

  it("falls back to the state when listClaimableExits failed", () => {
    const o = buildExitOverview([exit("a", claimable())], null, [], NOW);
    expect(o.claimableIds).toEqual(["a"]);
  });

  it("hides a coin from the claim button only while a claim is fresh", () => {
    const exits = [exit("a", claimable())];
    const fresh = buildExitOverview(exits, ["a"], [record(["a"], NOW - 60_000)], NOW);
    expect(fresh.coins[0].phase).toBe("claim-sent");
    expect(fresh.claimableIds).toEqual([]);
    expect(fresh.pendingClaims).toHaveLength(1);
    // The regression the model exists for: a claim that dropped out of the
    // mempool must not keep the coin away from the button forever.
    const stale = buildExitOverview(exits, ["a"], [record(["a"], NOW - CLAIM_GRACE_MS - 1)], NOW);
    expect(stale.coins[0].phase).toBe("claimable");
    expect(stale.claimableIds).toEqual(["a"]);
  });

  it("treats an unknown-outcome claim like a sent one during the grace period", () => {
    const o = buildExitOverview([exit("a", claimable())], ["a"], [record(["a"], NOW - 1_000, false)], NOW);
    expect(o.coins[0].phase).toBe("claim-sent");
  });

  it("reports claim-in-progress and claimed from bark", () => {
    const o = buildExitOverview([exit("a", claimInProgress()), exit("b", claimed())], [], [], NOW);
    expect(o.stage).toBe("claiming");
    expect(o.coins.map((c) => c.phase)).toEqual(["claiming", "claimed"]);
    expect(o.live).toBe(true);
    const done = buildExitOverview([exit("b", claimed(), 7)], [], [], NOW);
    expect(done.stage).toBe("done");
    expect(done.live).toBe(false);
    expect(done.claimedSats).toBe(7);
  });

  it("does not count finished coins as live", () => {
    const o = buildExitOverview(
      [exit("a", { type: "vtxo-already-spent", tipHeight: 1 }), exit("b", { type: "canceled", tipHeight: 1 })],
      [],
      [],
      NOW,
    );
    expect(o.live).toBe(false);
    expect(o.liveSats).toBe(0);
    expect(o.abortedSats).toBe(10_000);
  });

  it("never loses a coin and never counts one twice", () => {
    const states = [start(), processing(["awaiting-cpfp-broadcast"]), awaitingDelta(100, 120), claimable(), claimInProgress(), claimed()];
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 7 }), fc.integer({ min: 0, max: states.length - 1 }), fc.integer({ min: 1, max: 1e8 })), {
          maxLength: 12,
        }),
        (rows) => {
          const exits = rows.map(([id, s, amt]) => exit(`v${id}`, states[s], amt));
          const o = buildExitOverview(exits, null, [], NOW);
          const unique = new Map(exits.map((e) => [e.vtxoId, e]));
          expect(o.coins).toHaveLength(unique.size);
          const total = [...unique.values()].reduce((a, e) => a + e.amountSats, 0);
          expect(o.broadcastingSats + o.timelockSats + o.claimableSats + o.claimingSats + o.claimedSats + o.abortedSats).toBe(total);
        },
      ),
    );
  });
});

describe("pruneClaimRecords", () => {
  it("keeps a record while one of its coins is claimable or being claimed", () => {
    const r = record(["a", "b"], NOW);
    expect(pruneClaimRecords([r], [exit("a", claimed()), exit("b", claimInProgress())], NOW)).toEqual([r]);
  });

  it("drops it once bark says every coin is finished or forgotten", () => {
    const r = record(["a"], NOW);
    expect(pruneClaimRecords([r], [exit("a", claimed())], NOW)).toEqual([]);
    expect(pruneClaimRecords([r], [], NOW)).toEqual([]);
  });

  it("drops very old records", () => {
    const r = record(["a"], NOW - 31 * 24 * 3600_000);
    expect(pruneClaimRecords([r], [exit("a", claimable())], NOW)).toEqual([]);
  });
});

describe("classifyBroadcastError", () => {
  it("reads 'already there' answers as sent", () => {
    for (const m of [
      'sendrawtransaction RPC error: {"code":-27,"message":"Transaction outputs already in utxo set"}',
      "Transaction already in block chain",
      "txn-already-known",
      "txn-already-in-mempool",
    ]) {
      expect(classifyBroadcastError(m), m).toBe("already-sent");
    }
  });

  it("reads a node's refusal as rejected", () => {
    expect(classifyBroadcastError('sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}')).toBe("rejected");
    // Spent by an earlier claim of ours (only the owner can spend them).
    expect(classifyBroadcastError("bad-txns-inputs-missingorspent")).toBe("already-sent");
    expect(classifyBroadcastError('sendrawtransaction RPC error: {"code":-26,"message":"txn-mempool-conflict"}')).toBe("already-sent");
    expect(
      classifyBroadcastError(
        'sendrawtransaction RPC error: {"code":-26,"message":"insufficient fee, rejecting replacement 1a2b; new feerate 0.0001 BTC/kvB <= old feerate 0.0002 BTC/kvB"}',
      ),
    ).toBe("already-sent");
  });

  it("reads anything else as unknown", () => {
    expect(classifyBroadcastError("Počkej chvíli…")).toBe("unknown");
    expect(classifyBroadcastError("Failed to fetch")).toBe("unknown");
  });
});

describe("planExitLocks", () => {
  const ours = { type: "locked" as const, holder: { type: "action", id: EXIT_LOCK_HOLDER_ID } };
  const v = (id: string, state: ExitLockVtxo["state"]): ExitLockVtxo => ({ id, state });

  it("locks spendable coins whose exit hasn't confirmed yet", () => {
    const plan = planExitLocks(
      [v("a", { type: "spendable" }), v("b", { type: "spendable" }), v("c", { type: "spendable" })],
      [
        { vtxoId: "a", state: { type: "start" } },
        { vtxoId: "b", state: { type: "processing" } },
      ],
    );
    expect(plan).toEqual({ lock: ["a", "b"], unlock: [] });
  });

  it("leaves other holders' locks and coins outside an exit alone", () => {
    const plan = planExitLocks(
      [v("a", { type: "locked", holder: { type: "action", id: "spendrr-refresh" } }), v("b", { type: "spendable" })],
      [{ vtxoId: "a", state: { type: "start" } }],
    );
    expect(plan).toEqual({ lock: [], unlock: [] });
  });

  it("releases our lock when the exit was canceled or is gone", () => {
    const plan = planExitLocks(
      [v("a", ours), v("b", ours), v("c", ours)],
      [
        { vtxoId: "a", state: { type: "canceled" } },
        { vtxoId: "c", state: { type: "processing" } },
      ],
    );
    expect(plan).toEqual({ lock: [], unlock: ["a", "b"] });
  });

  it("never plans the same coin twice", () => {
    const plan = planExitLocks([v("a", { type: "spendable" }), v("a", { type: "spendable" })], [{ vtxoId: "a", state: { type: "start" } }]);
    expect(plan.lock).toEqual(["a"]);
  });
});

describe("expiry of coins still getting on-chain", () => {
  it("reports blocks to expiry for broadcasting coins and flags the risky ones", () => {
    const exits = [
      exit("a", processing(["confirmed", "awaiting-confirmation"]), 5_000),
      exit("b", start(), 7_000),
      exit("c", awaitingDelta(100, 150), 9_000),
    ];
    const heights = new Map([
      ["a", 100 + EXIT_EXPIRY_WARN_BLOCKS],
      ["b", 100 + EXIT_EXPIRY_WARN_BLOCKS + 1],
      ["c", 110],
    ]);
    const o = buildExitOverview(exits, [], [], NOW, heights);
    expect(o.firstExpiryInBlocks).toBe(EXIT_EXPIRY_WARN_BLOCKS);
    expect(o.expiryRiskSats).toBe(5_000);
    // Past the last exit transaction expiry no longer matters.
    expect(o.coins.find((c) => c.vtxoId === "c")?.expiresInBlocks).toBeNull();
  });

  it("stays silent without expiry data", () => {
    const o = buildExitOverview([exit("a", start())], [], [], NOW);
    expect(o.firstExpiryInBlocks).toBeNull();
    expect(o.expiryRiskSats).toBe(0);
  });

  it("counts an already expired coin as at risk", () => {
    const o = buildExitOverview([exit("a", start(), 4_000)], [], [], NOW, new Map([["a", 90]]));
    expect(o.firstExpiryInBlocks).toBe(-10);
    expect(o.expiryRiskSats).toBe(4_000);
  });
});

describe("audit fixes 2026-09-27", () => {
  it("counts expiry from the newest tip, not a coin's stale one", () => {
    const o = buildExitOverview(
      [exit("old", { type: "start", tipHeight: 100 }), exit("new", processing(["confirmed"]))].map((e, i) =>
        i === 1 ? { ...e, state: { ...e.state, tipHeight: 400 } as ExitVtxo["state"] } : e,
      ),
      [],
      [],
      NOW,
      new Map([["old", 500]]),
    );
    expect(o.coins.find((c) => c.vtxoId === "old")?.expiresInBlocks).toBe(100);
  });
});

describe("fee stall (bark leaves an unfunded CPFP in awaiting-cpfp-broadcast)", () => {
  it("counts coins whose next transaction waits for its CPFP", () => {
    const o = buildExitOverview(
      [
        exit("stuck", processing(["confirmed", "awaiting-cpfp-broadcast"]), 7_000),
        exit("moving", processing(["confirmed", "awaiting-confirmation"]), 5_000),
      ],
      [],
      [],
      NOW,
    );
    expect(o.feeStalledSats).toBe(7_000);
  });
});
