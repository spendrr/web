import { describe, expect, it } from "vitest";
import {
  classifySubmitError,
  EMPTY_STATE,
  ENGINE,
  memoryStore,
  parseState,
  previewManual,
  releaseBatch,
  releaseQuarantine,
  releaseStranded,
  refreshNoteSafe,
  resetBreaker,
  sweepEngineLocks,
  tick,
  vtxoIdsInError,
  type EngineDeps,
  type EngineState,
} from "../../src/lib/refreshEngine/engine";
import { FakeWallet } from "./fakeWallet";
import { BREAKER } from "../../src/lib/refreshEngine/breaker";

const TIP = 900_000;
const T0 = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

function setup(state: EngineState = EMPTY_STATE) {
  const wallet = new FakeWallet();
  const store = memoryStore(state);
  let now = T0;
  let tip = TIP;
  wallet.clock = () => now;
  const deps: EngineDeps = {
    wallet,
    store,
    getTipHeight: async () => tip,
    now: () => now,
    appVersion: "v1",
  };
  return {
    wallet,
    store,
    deps,
    advance: (ms: number) => (now += ms),
    setTip: (h: number) => (tip = h),
    state: () => store.peek(),
    kinds: () => store.peek().log.map((e) => e.kind),
  };
}

describe("the normal life of a refresh", () => {
  it("submits, hands the coins to bark's round, completes, and leaves nothing behind", async () => {
    const t = setup();
    const due = t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    const small = t.wallet.add({ amountSats: 2_000, expiryHeight: TIP + 900, exitDepth: 1 });
    const healthy = t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 3000, exitDepth: 1 });

    const r = await tick(t.deps);
    expect(r.outcome).toBe("submitted");
    expect(t.wallet.submits).toEqual([[due.id, small.id]]);
    // The lock was only a check: the coins stay spendable until the round is issued.
    expect(t.wallet.lockedBy(ENGINE.HOLDER_REFRESH)).toEqual([]);
    expect(t.wallet.vtxos.get(due.id)?.state.type).toBe("spendable");
    expect(r.status.lockedInRefreshSats).toBe(0);
    expect(t.state().batches[0].locked).toBe(false);

    // Next ticks while the round waits: nothing new, nothing resubmitted.
    t.advance(15 * MIN);
    expect((await tick(t.deps)).outcome).toBe("idle");
    expect(t.wallet.submits).toHaveLength(1);

    // The server issues the round, bark takes the inputs.
    const id = t.wallet.rounds[0].id;
    expect(t.wallet.issueRound(id)).toBe(true);
    t.advance(MIN);
    const held = await tick(t.deps);
    expect(t.state().batches[0].locked).toBe(true);
    expect(held.status.lockedInRefreshSats).toBe(52_000);
    expect(t.wallet.vtxos.get(due.id)?.state).toEqual({ type: "locked", holder: { type: "movement", id } });
    expect(t.wallet.vtxos.get(healthy.id)?.state.type).toBe("spendable");

    t.wallet.finishRound(id, TIP + 4032);
    t.advance(MIN);
    const done = await tick(t.deps);
    expect(t.kinds()).toContain("completed");
    expect(done.status.inRefresh).toEqual([]);
    expect(done.status.lockedInRefreshSats).toBe(0);
    expect(t.wallet.lockedBy(ENGINE.HOLDER_REFRESH)).toEqual([]);
    expect(t.wallet.violations).toEqual([]);
  });

  it("a failed round's coins are offered again after the backoff", async () => {
    const t = setup();
    const due = t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    await tick(t.deps);
    t.wallet.failRound(t.wallet.rounds[0].id);
    t.advance(MIN);
    const r = await tick(t.deps);
    expect(t.kinds()).toContain("round-failed");
    expect(t.wallet.vtxos.get(due.id)?.state.type).toBe("spendable");
    expect(r.outcome).toBe("skip-backoff");
    t.advance(10 * MIN);
    expect((await tick(t.deps)).outcome).toBe("submitted");
    expect(t.wallet.submits).toHaveLength(2);
  });

  it("does nothing at all for a wallet with nothing due", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 200, expiryHeight: TIP + 500, exitDepth: 1 });
    t.wallet.add({ amountSats: 5_000, expiryHeight: TIP + 300, exitDepth: 70 });
    expect((await tick(t.deps)).outcome).toBe("idle");
    expect(t.wallet.submits).toEqual([]);
    expect(t.state().breaker.attempts).toEqual([]);
  });

  it("a payment before the round is issued takes the coin: the participation is dropped, neither success nor failure", async () => {
    const t = setup();
    const due = t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    t.wallet.betweenCalls = () => {
      t.wallet.betweenCalls = null;
      expect(t.wallet.spend(due.id)).toBe(true);
    };
    await tick(t.deps);
    expect(t.wallet.server).toHaveLength(0);
    const before = structuredClone(t.state().breaker);
    t.wallet.runRound(TIP + 4032);
    t.advance(MIN);
    await tick(t.deps);
    expect(t.kinds()).toContain("ended-unseen");
    expect(t.kinds()).not.toContain("completed");
    expect(t.kinds()).not.toContain("round-failed");
    expect(t.state().breaker.consecutiveFailures).toBe(before.consecutiveFailures);
    expect(t.state().batches).toEqual([]);
    expect(t.wallet.violations).toEqual([]);
  });

  it("a send once the round is issued can't take its coins", async () => {
    const t = setup();
    const due = t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    const free = t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 3000, exitDepth: 1 });
    await tick(t.deps);
    expect(t.wallet.issueRound(t.wallet.rounds[0].id)).toBe(true);
    expect(t.wallet.spend(due.id)).toBe(false);
    expect(t.wallet.spend(free.id)).toBe(true);
    expect(t.wallet.server).toHaveLength(1); // participation survived
  });

  it("splits over the server cap and submits every batch in one tick", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 6_000_000, expiryHeight: TIP + 10, exitDepth: 1 });
    t.wallet.add({ amountSats: 6_000_000, expiryHeight: TIP + 20, exitDepth: 1 });
    await tick(t.deps);
    expect(t.wallet.submits).toHaveLength(2);
    expect(t.state().batches).toHaveLength(2);
    expect(t.wallet.violations).toEqual([]);
  });

  it("logs a paid refresh but still does it", async () => {
    const t = setup();
    t.wallet.feePpm = 2000;
    t.wallet.add({ amountSats: 100_000, expiryHeight: TIP + 100, exitDepth: 1 });
    await tick(t.deps);
    expect(t.wallet.submits).toHaveLength(1);
    expect(t.state().log.find((e) => e.kind === "fee")?.feeSats).toBe(200);
  });

  it("skips a batch whose output would be dust after the fee, without spending an attempt", async () => {
    const t = setup();
    t.wallet.feePpm = 200_000;
    t.wallet.add({ amountSats: 400, expiryHeight: TIP + 100, exitDepth: 1 });
    await tick(t.deps);
    expect(t.wallet.submits).toEqual([]);
    expect(t.state().breaker.attempts).toEqual([]);
  });
});

describe("rejections and quarantine", () => {
  it("quarantines a named coin on its second rejection (not locked: reason unknown), and the companions stay put", async () => {
    const t = setup();
    const bad = t.wallet.add({ amountSats: 1111, expiryHeight: TIP - 50, exitDepth: 1 });
    t.wallet.add({ amountSats: 3_000, expiryHeight: TIP + 800, exitDepth: 1 });
    t.wallet.faults.push({ kind: "reject", message: `bad user input: vtxo ${bad.id} is not spendable` });
    expect((await tick(t.deps)).outcome).toBe("failed");
    // First rejection: a second chance, not quarantine.
    expect(t.state().quarantine).toEqual({});
    expect(t.state().aloneRejects[bad.id]).toBe(1);
    t.advance(BREAKER.BASE_BACKOFF_MS);
    t.wallet.faults.push({ kind: "reject", message: `bad user input: vtxo ${bad.id} is not spendable` });
    expect((await tick(t.deps)).outcome).toBe("failed");
    expect(Object.keys(t.state().quarantine)).toEqual([bad.id]);
    expect(t.state().quarantine[bad.id].reason).toBe("unknown");
    expect(t.wallet.lockedBy(ENGINE.HOLDER_QUARANTINE)).toEqual([]);
    expect((await tick(t.deps)).status.quarantinedSats).toBe(1111);

    t.advance(HOUR);
    expect((await tick(t.deps)).outcome).toBe("idle");
    expect(t.wallet.submits).toHaveLength(2);
  });

  it("an unknown-reason quarantine is retried after 7 days, a 'spent' one never by itself", async () => {
    const t = setup();
    const a = t.wallet.add({ amountSats: 5_000, expiryHeight: TIP - 5, exitDepth: 1 });
    const b = t.wallet.add({ amountSats: 5_000, expiryHeight: TIP - 5, exitDepth: 1 });
    t.wallet.faults.push({ kind: "reject", message: `rejected: ${a.id} unknown` });
    await tick(t.deps);
    t.advance(HOUR);
    t.wallet.faults.push({ kind: "reject", message: `rejected: ${a.id} unknown` });
    await tick(t.deps);
    expect(t.state().quarantine[a.id]?.reason).toBe("unknown");
    t.advance(HOUR);
    t.wallet.faults.push({ kind: "reject", message: `vtxo ${b.id} already spent` });
    await tick(t.deps);
    expect(t.state().quarantine[b.id].reason).toBe("spent");

    t.advance(ENGINE.QUARANTINE_RETRY_MS);
    await tick(t.deps);
    expect(t.state().quarantine[a.id]).toBeUndefined();
    expect(t.state().quarantine[b.id]).toBeDefined();
    expect(t.wallet.lockedBy(ENGINE.HOLDER_QUARANTINE)).toEqual([b.id]);

    await releaseQuarantine(t.deps, b.id);
    expect(t.state().quarantine[b.id]).toBeUndefined();
    expect(t.wallet.lockedBy(ENGINE.HOLDER_QUARANTINE)).toEqual([]);
  });

  it("an id in the error we didn't offer is ignored", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 5_000, expiryHeight: TIP + 5, exitDepth: 1 });
    t.wallet.faults.push({ kind: "reject", message: `bad user input: ${"f".repeat(64)}:3` });
    await tick(t.deps);
    expect(t.state().quarantine).toEqual({});
  });
});

describe("uncertain submits", () => {
  it("lost before local store (orphan on the server): resubmits the same inputs, server supersedes", async () => {
    const t = setup();
    const a = t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    t.wallet.add({ amountSats: 1_000, expiryHeight: TIP + 280, exitDepth: 1 });
    t.wallet.faults.push({ kind: "lost-before-store", message: "worker request timed out" });
    expect((await tick(t.deps)).outcome).toBe("failed");
    expect(t.state().submitting?.ids).toHaveLength(2);

    // Meanwhile another coin becomes due: nothing else may start.
    t.wallet.add({ amountSats: 70_000, expiryHeight: TIP + 50, exitDepth: 1 });
    t.advance(MIN);
    await tick(t.deps);
    expect(t.wallet.submits).toHaveLength(2);
    expect(t.wallet.submits[1]).toEqual(t.wallet.submits[0]);
    expect(t.wallet.server).toHaveLength(1);
    expect(t.state().submitting).toBeNull();
    expect(t.kinds()).toContain("resubmitted");
    // Spendable until the server issues the round (bark locks it then).
    expect(t.wallet.vtxos.get(a.id)?.state.type).toBe("spendable");
    expect(t.wallet.violations).toEqual([]);
  });

  it("lost after local store: adopts the round state, no second submit", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    t.wallet.faults.push({ kind: "lost-after-store", message: "worker lost" });
    await tick(t.deps);
    t.advance(MIN);
    await tick(t.deps);
    expect(t.wallet.submits).toHaveLength(1);
    expect(t.kinds()).toContain("adopted");
    expect(t.state().batches).toHaveLength(1);
    // Adopting doesn't lock: bark does once the round is issued.
    expect(t.wallet.lockedBy(ENGINE.HOLDER_REFRESH)).toEqual([]);
    expect(t.wallet.issueRound(t.wallet.rounds[0].id)).toBe(true);
    t.advance(MIN);
    await tick(t.deps);
    expect(t.state().batches[0].locked).toBe(true);
    expect(t.wallet.violations).toEqual([]);
  });

  it("drops the uncertain record when an input got spent meanwhile", async () => {
    const t = setup();
    const a = t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    t.wallet.faults.push({ kind: "throw-before-server", message: "network error" });
    await tick(t.deps);
    t.wallet.spend(a.id);
    t.advance(MIN);
    await tick(t.deps);
    expect(t.state().submitting).toBeNull();
    expect(t.kinds()).toContain("uncertain-dropped");
  });

  it("the resubmit skips the backoff but not the breaker", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    // A failure first, so a backoff is running.
    t.wallet.faults.push({ kind: "reject", message: "bad user input: round closed" });
    await tick(t.deps);
    t.advance(10 * MIN);
    t.wallet.faults.push({ kind: "throw-before-server", message: "network error" });
    await tick(t.deps);
    expect(t.wallet.submits).toHaveLength(2);
    // One minute later, deep inside the 20 min backoff: resubmitted anyway.
    t.advance(MIN);
    await tick(t.deps);
    expect(t.wallet.submits).toHaveLength(3);
    // A tripped breaker stops even a resubmit.
    const t2 = setup({ ...EMPTY_STATE, breaker: { ...EMPTY_STATE.breaker, tripped: { reason: "failures", at: T0, appVersion: "v1" } } });
    t2.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    t2.store.save({ ...t2.state(), submitting: { ids: [[...t2.wallet.vtxos.keys()][0]], at: T0, lastAt: T0, resubmits: 0, afterRoundId: -1 } });
    await tick(t2.deps);
    expect(t2.wallet.submits).toEqual([]);
  });
});

describe("gates", () => {
  it("a delegated participation we don't track: its inputs are left alone, the rest goes", async () => {
    const t = setup();
    const theirs = t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    const mine = t.wallet.add({ amountSats: 60_000, expiryHeight: TIP + 110, exitDepth: 1 });
    t.wallet.rounds.push({ id: 99, state: "delegated-pending", inputs: [theirs.id] });
    expect((await tick(t.deps)).outcome).toBe("submitted");
    expect(t.wallet.submits).toEqual([[mine.id]]);
  });

  it("…and when its inputs can't be read, it still blocks (fail closed)", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    t.wallet.rounds.push({ id: 99, state: "delegated-pending", inputs: [] });
    t.wallet.pendingRoundInputs = async () => {
      throw new Error("unknown round input VTXO");
    };
    expect((await tick(t.deps)).outcome).toBe("skip-foreign-pending");
    expect(t.wallet.submits).toEqual([]);
  });

  it("a foreign round pending over 24 h raises the island", async () => {
    const t = setup();
    t.wallet.rounds.push({ id: 99, state: "delegated-pending", inputs: [] });
    expect((await tick(t.deps)).status.needsAttention).toBeNull();
    t.advance(ENGINE.STUCK_MS + MIN);
    expect((await tick(t.deps)).status.needsAttention).toBe("stuck");
  });

  it("an unknown round kind blocks (fail closed)", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    t.wallet.rounds.push({ id: 99, state: "something-new", inputs: [] });
    expect((await tick(t.deps)).outcome).toBe("skip-unknown-round");
  });

  it("5 rejections in a row stop it; 'Zkusit znovu' and a new version resume", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    for (let i = 0; i < 5; i++) t.wallet.faults.push({ kind: "reject", message: "bad user input: round closed" });
    for (let i = 0; i < 5; i++) {
      await tick(t.deps);
      t.advance(7 * HOUR);
    }
    expect(t.state().breaker.tripped?.reason).toBe("failures");
    expect((await tick(t.deps)).outcome).toBe("skip-breaker");

    await resetBreaker(t.deps);
    expect((await tick(t.deps)).outcome).toBe("submitted");

    const t2 = setup(t.state());
    t2.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    const tripped = { ...t.state(), batches: [], breaker: { ...t.state().breaker, tripped: { reason: "failures" as const, at: T0, appVersion: "v0" } } };
    const t3 = setup(tripped);
    t3.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    expect((await tick(t3.deps)).outcome).not.toBe("skip-breaker");
  });

  it("island: breaker stopped and a coin under 144 blocks", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    for (let i = 0; i < 5; i++) t.wallet.faults.push({ kind: "reject", message: "bad user input: nope" });
    let r;
    for (let i = 0; i < 6; i++) {
      r = await tick(t.deps);
      t.advance(7 * HOUR);
    }
    expect(r!.status.needsAttention).toBe("breaker-urgent");
  });

  it("a refresh stuck over 24 h lets its coins go, and they can go out again", async () => {
    const t = setup();
    const c = t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    await tick(t.deps);
    t.advance(ENGINE.STUCK_MS + MIN);
    const r = await tick(t.deps);
    expect(t.state().log.some((e) => e.kind === "unlocked" && e.note === "stuck")).toBe(true);
    // Released and (being due) submitted again right away: the server drops
    // the stuck participation for the new one.
    expect(t.wallet.submits).toEqual([[c.id], [c.id]]);
    expect(t.state().batches.filter((b) => !b.released).map((b) => b.ids)).toEqual([[c.id]]);
    expect(r.status.needsAttention).toBeNull();
    // The old one ends (superseded), the new one completes: nothing unlocked by mistake.
    const oldId = t.state().batches.find((b) => b.released)!.roundId!;
    t.wallet.failRound(oldId);
    t.advance(MIN);
    await tick(t.deps);
    expect(t.wallet.lockedBy(ENGINE.HOLDER_REFRESH)).toEqual([]);
    expect(t.state().batches.map((b) => b.released ?? false)).toEqual([false]);
    expect(t.wallet.violations).toEqual([]);
  });

  it("an exit taking a pending batch's coins releases it (releaseBatch)", async () => {
    const t = setup();
    const c = t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 3000, exitDepth: 1 });
    t.wallet.add({ amountSats: 40_000, expiryHeight: TIP + 100, exitDepth: 1 });
    await tick(t.deps, "manual");
    const at = t.state().batches[0].at;
    await releaseBatch(t.deps, at);
    expect(t.wallet.lockedBy(ENGINE.HOLDER_REFRESH)).toEqual([]);
    expect(t.state().batches[0].released).toBe(true);
    // Spendable again: a send can take it.
    expect(t.wallet.spend(c.id)).toBe(true);
    t.advance(MIN);
    await tick(t.deps);
    expect(t.wallet.lockedBy(ENGINE.HOLDER_REFRESH)).not.toContain(c.id);
  });

  it("releaseBatch leaves a batch alone once the server issued its round", async () => {
    const t = setup();
    const c = t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    await tick(t.deps);
    const id = t.wallet.rounds[0].id;
    t.wallet.issueRound(id);
    t.advance(MIN);
    await tick(t.deps);
    await releaseBatch(t.deps, t.state().batches[0].at);
    expect(t.state().batches[0].released).toBeUndefined();
    expect(t.wallet.vtxos.get(c.id)?.state).toEqual({ type: "locked", holder: { type: "movement", id } });
    t.wallet.finishRound(id, TIP + 4032);
    t.advance(MIN);
    await tick(t.deps);
    expect(t.kinds()).toContain("completed");
    expect(t.wallet.violations).toEqual([]);
  });
});

describe("lock failures", () => {
  it("a lock that fails before the submit sends nothing and refunds the attempt", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    t.wallet.lockFaults = 1;
    const r = await tick(t.deps);
    expect(r.status.lockedInRefreshSats).toBe(0);
    expect(t.wallet.submits).toHaveLength(0);
    expect(t.state().breaker.attempts).toHaveLength(0);
    expect(t.state().breaker.consecutiveFailures).toBe(0);
    expect(t.state().submitting).toBeNull();
    expect(t.state().log.filter((e) => e.kind !== "check").at(-1)?.note).toBe("inputs-changed");
    t.advance(MIN);
    await tick(t.deps);
    expect(t.wallet.submits).toHaveLength(1);
  });

  it("a coin a payment spent after the plan is never submitted (audit 2026-09-26: no isolation, no key index)", async () => {
    const t = setup();
    const coins = [1, 2, 3, 4].map((i) => t.wallet.add({ amountSats: 20_000 * i, expiryHeight: TIP + 100 + i, exitDepth: 1 }));
    const victim = coins[2];
    const origFee = t.wallet.estimateRefreshFee.bind(t.wallet);
    let spent = false;
    t.wallet.estimateRefreshFee = async (ids) => {
      if (!spent) {
        spent = true;
        t.wallet.spend(victim.id);
        t.wallet.unusableCoins.add(victim.id);
      }
      return origFee(ids);
    };
    await tick(t.deps);
    expect(t.wallet.submits).toHaveLength(0);
    expect(t.state().quarantine).toEqual({});
    expect(t.wallet.lockedBy(ENGINE.HOLDER_REFRESH)).toEqual([]);
    t.advance(MIN);
    await tick(t.deps);
    expect(t.wallet.submits).toEqual([coins.filter((c) => c !== victim).map((c) => c.id)]);
  });
});

describe("manual and dry run", () => {
  it("manual refreshes every coin, preview first changes nothing", async () => {
    const t = setup();
    t.wallet.feePpm = 5000;
    t.wallet.add({ amountSats: 100_000, expiryHeight: TIP + 3000, exitDepth: 1 });
    t.wallet.add({ amountSats: 20_000, expiryHeight: TIP + 3000, exitDepth: 1 });
    const pre = await previewManual(t.deps);
    expect(pre.fees.map((f) => f.feeSats)).toEqual([600]);
    expect(t.wallet.submits).toEqual([]);
    expect((await tick(t.deps, "manual")).outcome).toBe("submitted");
    expect(t.wallet.submits[0]).toHaveLength(2);
  });

  it("dry run submits and locks nothing, logs each distinct plan once", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    t.wallet.rounds.push({ id: 7, state: "delegated-pending", inputs: [] }); // SDK's own
    for (let i = 0; i < 5; i++) await tick(t.deps, "dry-run");
    expect(t.wallet.submits).toEqual([]);
    expect(t.wallet.lockedBy(ENGINE.HOLDER_REFRESH)).toEqual([]);
    const dry = t.state().log.filter((e) => e.kind === "dry-run");
    expect(dry).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("vtxoIdsInError finds distinct outpoints", () => {
    const a = `${"1".repeat(64)}:0`;
    const b = `${"2".repeat(64)}:12`;
    expect(vtxoIdsInError(`${a} x ${b} y ${a}`)).toEqual([a, b]);
  });

  it("classifySubmitError", () => {
    const id = `${"1".repeat(64)}:0`;
    expect(classifySubmitError(`vtxo ${id} bad`, [id])).toBe("definite");
    expect(classifySubmitError("bad user input: x", [])).toBe("definite");
    expect(classifySubmitError("worker request timed out", [])).toBe("uncertain");
    expect(classifySubmitError("transport error", [])).toBe("uncertain");
  });

  it("parseState tolerates garbage", () => {
    expect(parseState(null)).toEqual(EMPTY_STATE);
    expect(parseState({ v: 2 })).toEqual(EMPTY_STATE);
    expect(parseState({ v: 1, batches: "x" }).batches).toEqual([]);
  });
});

describe("orphaned locks (every open, every mode)", () => {
  // A pending batch as an older version left it: our lock on its inputs for
  // the whole round.
  async function liveBatch() {
    const t = setup();
    const due = t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    await tick(t.deps);
    await t.wallet.lockVtxos([due.id], ENGINE.HOLDER_REFRESH);
    return { t, due };
  }

  it("an older version's lock on a pending batch is let go in every mode, so bark can take the round", async () => {
    const { t, due } = await liveBatch();
    const ev = await sweepEngineLocks(t.deps, false);
    expect(ev.find((e) => e.kind === "unlocked")?.note).toBe("handover");
    expect(t.wallet.lockedBy(ENGINE.HOLDER_REFRESH)).toEqual([]);
    const id = t.wallet.rounds[0].id;
    expect(t.wallet.issueRound(id)).toBe(true);
    await sweepEngineLocks(t.deps, false);
    expect(t.state().batches[0].locked).toBe(true);
    t.wallet.finishRound(id, TIP + 4032);
    const done = await sweepEngineLocks(t.deps, false);
    expect(done.map((e) => e.kind)).toContain("completed");
    expect(t.state().batches).toEqual([]);
    expect(t.wallet.vtxos.get(due.id)?.state.type).toBe("spent");
    expect(t.wallet.violations).toEqual([]);
  });

  it("an older version's lock left on a round the server already issued: bark takes it once the lock goes", async () => {
    const { t } = await liveBatch();
    const id = t.wallet.rounds[0].id;
    expect(t.wallet.issueRound(id)).toBe(false);
    t.wallet.violations = [];
    await sweepEngineLocks(t.deps, true);
    expect(t.wallet.issueRound(id)).toBe(true);
    expect(t.wallet.violations).toEqual([]);
  });

  it("live -> off: a failed round's coins come back spendable", async () => {
    const { t, due } = await liveBatch();
    t.wallet.failRound(t.wallet.rounds[0].id);
    await sweepEngineLocks(t.deps, false);
    expect(t.wallet.vtxos.get(due.id)?.state.type).toBe("spendable");
    expect(t.state().batches).toEqual([]);
  });

  it("localStorage wiped (ITP, Home Screen install): every refresh lock is released", async () => {
    const { t, due } = await liveBatch();
    t.store.save(structuredClone(EMPTY_STATE));
    for (const live of [false, true]) {
      await sweepEngineLocks(t.deps, live);
      expect(t.wallet.vtxos.get(due.id)?.state.type).toBe("spendable");
    }
  });

  it("restored on another device (locks in the backup, no engine state), round still pending: released", async () => {
    const { t, due } = await liveBatch();
    const other = setup();
    other.wallet.vtxos = new Map([[due.id, structuredClone(t.wallet.vtxos.get(due.id)!)]]);
    other.wallet.rounds = structuredClone(t.wallet.rounds);
    const ev = await sweepEngineLocks(other.deps, false);
    expect(ev.find((e) => e.kind === "unlocked")?.note).toBe("orphan");
    expect(other.wallet.vtxos.get(due.id)?.state.type).toBe("spendable");
  });

  it("quarantine locks (spent only): released outside live, restored in live", async () => {
    const t = setup();
    const bad = t.wallet.add({ amountSats: 1111, expiryHeight: TIP - 5, exitDepth: 1 });
    t.wallet.faults.push({ kind: "reject", message: `bad user input: vtxo ${bad.id} is already spent` });
    await tick(t.deps);
    expect(t.state().quarantine[bad.id].reason).toBe("spent");
    expect(t.wallet.lockedBy(ENGINE.HOLDER_QUARANTINE)).toEqual([bad.id]);
    await sweepEngineLocks(t.deps, false);
    expect(t.wallet.lockedBy(ENGINE.HOLDER_QUARANTINE)).toEqual([]);
    expect(t.state().quarantine[bad.id]).toBeDefined();
    await sweepEngineLocks(t.deps, true);
    expect(t.wallet.lockedBy(ENGINE.HOLDER_QUARANTINE)).toEqual([bad.id]);
    // A quarantine lock whose entry is gone is released even in live.
    t.store.save({ ...t.state(), quarantine: {} });
    await sweepEngineLocks(t.deps, true);
    expect(t.wallet.lockedBy(ENGINE.HOLDER_QUARANTINE)).toEqual([]);
  });

  it("an 'unknown' quarantine lock an older version left is released, the entry stays", async () => {
    const t = setup();
    const c = t.wallet.add({ amountSats: 5_000, expiryHeight: TIP + 3000, exitDepth: 1 });
    await t.wallet.lockVtxos([c.id], ENGINE.HOLDER_QUARANTINE);
    t.store.save({ ...t.state(), quarantine: { [c.id]: { at: T0, reason: "unknown", error: "x" } } });
    await sweepEngineLocks(t.deps, true);
    expect(t.wallet.lockedBy(ENGINE.HOLDER_QUARANTINE)).toEqual([]);
    expect(t.state().quarantine[c.id]).toBeDefined();
  });

  it("a dry-run tick releases what a live session left behind", async () => {
    const { t, due } = await liveBatch();
    t.wallet.failRound(t.wallet.rounds[0].id);
    t.advance(MIN);
    await tick(t.deps, "dry-run");
    expect(t.wallet.vtxos.get(due.id)?.state.type).toBe("spendable");
  });

  it("a wallet the engine never touched: one allVtxos(), nothing else", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    let rounds = 0;
    const orig = t.wallet.pendingRoundStates.bind(t.wallet);
    t.wallet.pendingRoundStates = async () => {
      rounds++;
      return orig();
    };
    expect(await sweepEngineLocks(t.deps, false)).toEqual([]);
    expect(rounds).toBe(0);
    expect(t.state()).toEqual(EMPTY_STATE);
  });

  it("never touches someone else's locks", async () => {
    const t = setup();
    const ln = t.wallet.add({
      amountSats: 50_000,
      expiryHeight: TIP + 100,
      exitDepth: 1,
      state: { type: "locked", holder: { type: "action", id: "lightning-send-1" } },
    });
    await sweepEngineLocks(t.deps, false);
    await sweepEngineLocks(t.deps, true);
    expect(t.wallet.vtxos.get(ln.id)?.state).toEqual({ type: "locked", holder: { type: "action", id: "lightning-send-1" } });
  });
});

describe("rejections that don't name the coin (how the real server's reach the browser)", () => {
  it("phantom: an expired coin the server calls unusable is found and quarantined; the small coins stay put", async () => {
    const t = setup();
    const phantom = t.wallet.add({ amountSats: 1111, expiryHeight: TIP - 50, exitDepth: 1 });
    const small1 = t.wallet.add({ amountSats: 3_000, expiryHeight: TIP + 800, exitDepth: 1 });
    const small2 = t.wallet.add({ amountSats: 1_000, expiryHeight: TIP + 900, exitDepth: 1 });
    t.wallet.unusableCoins.add(phantom.id);
    await tick(t.deps);
    // Full batch, then the due coin alone: one rejection alone is not enough.
    expect(t.wallet.submits).toEqual([[phantom.id, small1.id, small2.id], [phantom.id]]);
    expect(t.state().quarantine).toEqual({});
    t.advance(HOUR);
    await tick(t.deps);
    // The second time alone: quarantined, not locked (reason unknown).
    expect(Object.keys(t.state().quarantine)).toEqual([phantom.id]);
    expect(t.wallet.lockedBy(ENGINE.HOLDER_QUARANTINE)).toEqual([]);
    expect(t.wallet.submits).toEqual([[phantom.id, small1.id, small2.id], [phantom.id], [phantom.id]]);
    expect(t.wallet.server).toEqual([]);
    expect(t.state().breaker.consecutiveFailures).toBe(0);
    t.advance(HOUR);
    expect((await tick(t.deps)).outcome).toBe("idle");
    expect(t.wallet.submits).toHaveLength(3);
  });

  it("a bad companion: the due coins go without it, companions are only suspected", async () => {
    const t = setup();
    const due = t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    const bad = t.wallet.add({ amountSats: 2_000, expiryHeight: TIP + 900, exitDepth: 1 });
    const good = t.wallet.add({ amountSats: 3_000, expiryHeight: TIP + 280, exitDepth: 1 });
    t.wallet.unusableCoins.add(bad.id);
    expect((await tick(t.deps)).outcome).toBe("submitted");
    expect(t.wallet.server.map((p) => p.inputs)).toEqual([[due.id]]);
    expect(t.state().quarantine).toEqual({});
    expect(Object.keys(t.state().suspects).sort()).toEqual([bad.id, good.id].sort());
    // The pass without companions is a success: no streak left.
    expect(t.state().breaker.consecutiveFailures).toBe(0);
    t.wallet.runRound(TIP + 4032);
    t.advance(HOUR);
    await tick(t.deps);

    // Later `good` becomes due on its own and goes; `bad` too, and is caught.
    t.setTip(TIP + 800);
    t.advance(HOUR);
    await tick(t.deps);
    // Its second rejection alone waits for a free isolation slot (soft
    // budget), so a day later.
    t.advance(24 * HOUR);
    await tick(t.deps);
    expect(t.state().quarantine[bad.id]).toBeDefined();
    expect(t.wallet.server.flatMap((p) => p.inputs)).toContain(good.id);
    expect(t.state().breaker.tripped).toBeNull();
  });

  it("one bad coin among many due ones: bisected, only it is quarantined, the rest is refreshed", async () => {
    const t = setup();
    const due = Array.from({ length: 6 }, (_, i) => t.wallet.add({ amountSats: 40_000 + i, expiryHeight: TIP + 10 + i, exitDepth: 1 }));
    t.wallet.missingCoins.add(due[4].id);
    // Paced by the breaker's window: isolation waits instead of tripping it.
    const refreshed = new Set<string>();
    for (let i = 0; i < 12 && (!t.state().quarantine[due[4].id] || t.state().groups.length > 0); i++) {
      await tick(t.deps);
      // Rounds run about hourly: whatever went out gets refreshed.
      for (const p of t.wallet.server) p.inputs.forEach((id) => refreshed.add(id));
      t.wallet.runRound(TIP + 4032);
      t.advance(25 * HOUR);
    }
    expect(Object.keys(t.state().quarantine)).toEqual([due[4].id]);
    expect([...refreshed].sort()).toEqual(due.filter((_, i) => i !== 4).map((v) => v.id).sort());
    expect(t.state().breaker.tripped).toBeNull();
    expect(t.state().breaker.consecutiveFailures).toBe(0);
    expect(t.state().groups).toEqual([]);
    expect(t.wallet.violations).toEqual([]);
  });

  it("two bad coins: both found (across ticks if the daily cap runs out)", async () => {
    const t = setup();
    const due = Array.from({ length: 4 }, (_, i) => t.wallet.add({ amountSats: 40_000, expiryHeight: TIP + 10 + i, exitDepth: 1 }));
    t.wallet.unusableCoins.add(due[0].id);
    t.wallet.unusableCoins.add(due[3].id);
    const refreshed = new Set<string>();
    for (let i = 0; i < 10 && Object.keys(t.state().quarantine).length < 2; i++) {
      await tick(t.deps);
      for (const p of t.wallet.server) p.inputs.forEach((id) => refreshed.add(id));
      t.wallet.runRound(TIP + 4032);
      t.advance(25 * HOUR);
    }
    expect(Object.keys(t.state().quarantine).sort()).toEqual([due[0].id, due[3].id].sort());
    expect([...refreshed].sort()).toEqual([due[1].id, due[2].id].sort());
    expect(t.state().breaker.tripped).toBeNull();
  });

  it("NotFound is a definite rejection, never an 'uncertain' resubmit loop", () => {
    expect(
      classifySubmitError(`code: 'Some requested entity was not found', message: "not found: input vtxo does not exist"`, []),
    ).toBe("definite");
  });

  it("a coin that keeps failing at round time: alone after 2, quarantined after 3, the others go", async () => {
    const t = setup();
    const bad = t.wallet.add({ amountSats: 40_000, expiryHeight: TIP + 20, exitDepth: 1 });
    const ok = t.wallet.add({ amountSats: 40_000, expiryHeight: TIP + 30, exitDepth: 1 });
    t.wallet.roundBadCoins.add(bad.id);
    for (let i = 0; i < 8 && !t.state().quarantine[bad.id]; i++) {
      await tick(t.deps);
      t.wallet.runRound(TIP + 4032);
      t.advance(2 * HOUR);
      await tick(t.deps);
    }
    expect(t.state().quarantine[bad.id]).toBeDefined();
    expect(t.wallet.vtxos.get(ok.id)?.state.type).toBe("spent");
    expect(t.state().breaker.tripped).toBeNull();
  });
});

describe("property: one silently bad coin never stops the engine", () => {
  it("it ends in quarantine, the breaker never trips, every other due coin is refreshed", async () => {
    let seed = Number(process.env.SEED ?? 11);
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let run = 0; run < 150; run++) {
      const t = setup();
      const n = 1 + Math.floor(rnd() * 9);
      const coins = Array.from({ length: n }, () =>
        t.wallet.add({
          amountSats: Math.floor(rnd() * 200_000) + 400,
          expiryHeight: TIP + Math.floor(rnd() * 1100) - 20,
          exitDepth: Math.floor(rnd() * 70),
        }),
      );
      // The bad one is due, so it has to be dealt with.
      const bad = t.wallet.add({ amountSats: 5_000 + Math.floor(rnd() * 50_000), expiryHeight: TIP + Math.floor(rnd() * 240) - 10, exitDepth: 1 });
      const kind = rnd();
      if (kind < 0.4) t.wallet.unusableCoins.add(bad.id);
      else if (kind < 0.7) t.wallet.missingCoins.add(bad.id);
      else t.wallet.roundBadCoins.add(bad.id);
      const dueIds = coins.filter((v) => v.expiryHeight - TIP < 250).map((v) => v.id);

      const done = () =>
        t.state().quarantine[bad.id] !== undefined &&
        t.state().groups.length === 0 &&
        dueIds.every((id) => t.wallet.vtxos.get(id)?.state.type === "spent");
      for (let step = 0; step < 60 && !done(); step++) {
        await tick(t.deps);
        t.wallet.runRound(TIP + 4032);
        t.advance(3 * HOUR);
        if (t.state().breaker.tripped && process.env.DUMP) {
          console.log(JSON.stringify({ run, kind, n, bad: bad.id.slice(-4), coins: coins.map((c) => [c.id.slice(-4), c.amountSats, c.expiryHeight - TIP, c.exitDepth]), log: t.state().log.map((e) => [e.kind, e.ids?.map((i) => i.slice(-4)), e.note, (e.at - 1_800_000_000_000) / 60000]) }));
        }
        expect(t.state().breaker.tripped, `run ${run} step ${step}`).toBeNull();
      }
      await tick(t.deps);
      expect(t.state().quarantine[bad.id], `run ${run}`).toBeDefined();
      for (const id of dueIds) expect(t.wallet.vtxos.get(id)?.state.type, `run ${run}`).toBe("spent");
      expect(t.wallet.violations).toEqual([]);
    }
  }, 60_000);
});

describe("review 2026-09-26: timeouts, adoption, manual confirm, balance note", () => {
  it("a 7th submission in 24 h waits for a free slot instead of tripping the breaker", async () => {
    const t = setup();
    // 7 batches of just under 10 M sats each: 7 submissions wanted at once.
    for (let i = 0; i < 7; i++) t.wallet.add({ amountSats: 9_000_000, expiryHeight: TIP + 10 + i, exitDepth: 1 });
    await tick(t.deps);
    expect(t.wallet.submits).toHaveLength(6);
    expect(t.state().breaker.tripped).toBeNull();
    t.advance(HOUR);
    const r = await tick(t.deps);
    expect(r.outcome).toBe("skip-rate");
    expect(r.status.backoffUntil).toBe(T0 + 24 * HOUR);
    t.advance(23 * HOUR);
    await tick(t.deps);
    expect(t.wallet.submits).toHaveLength(7);
    expect(t.state().breaker.tripped).toBeNull();
  });

  it("an uncertain submit is resubmitted with a backoff, leaving room in the window, and given up after 2 h", async () => {
    const t = setup();
    const a = t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    for (let i = 0; i < 20; i++) t.wallet.faults.push({ kind: "throw-before-server", message: "network error" });
    const at: number[] = [];
    const orig = t.wallet.refreshVtxosDelegated.bind(t.wallet);
    t.wallet.refreshVtxosDelegated = async (ids: string[], lockedBy?: string) => {
      at.push((t.wallet.clock() - T0) / MIN);
      return orig(ids, lockedBy);
    };
    for (let m = 0; m <= 130; m++) {
      await tick(t.deps);
      t.advance(MIN);
    }
    // First at 0, then 1, 2 and 5 minutes after each previous attempt, until
    // only RESUBMIT_RESERVE slots of the 24 h window are left.
    expect(at).toEqual([0, 1, 3, 8]);
    expect(at.length).toBe(BREAKER.MAX_ATTEMPTS_PER_WINDOW - ENGINE.RESUBMIT_RESERVE);
    expect(t.state().submitting).toBeNull();
    expect(t.state().log.some((e) => e.kind === "uncertain-dropped" && e.note === "gave-up")).toBe(true);
    // Held out of new participations for ORPHAN_HOLD_MS, then offered again.
    t.advance(ENGINE.ORPHAN_HOLD_MS);
    t.wallet.faults = [];
    await tick(t.deps);
    expect(t.wallet.submits.at(-1)).toEqual([a.id]);
    expect(t.wallet.submits).toHaveLength(5);
  });

  it("a resubmit that finds the coin unusable: the orphan landed, the coin is stranded", async () => {
    const t = setup();
    const a = t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    t.wallet.faults.push({ kind: "lost-before-store", message: "network error" });
    await tick(t.deps);
    // A round took the orphan: the server has spent the coin.
    t.wallet.unusableCoins.add(a.id);
    t.advance(MIN);
    const r = await tick(t.deps);
    expect(t.state().stranded[a.id]).toBeDefined();
    expect(t.state().quarantine).toEqual({});
    expect(t.state().breaker.consecutiveFailures).toBe(0);
    expect(r.status.strandedSats).toBe(50_000);
    expect(r.status.unrefreshableSats).toBe(50_000);
    // Never planned again by itself.
    t.advance(3 * 60 * MIN);
    await tick(t.deps);
    expect(t.wallet.submits).toHaveLength(2);
    // Released by hand: planned again.
    await releaseStranded(t.deps, a.id);
    t.wallet.unusableCoins.delete(a.id);
    t.advance(MIN);
    await tick(t.deps);
    expect(t.wallet.submits).toHaveLength(3);
  });

  it("nothing goes out while the app is hidden or the network is down", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    let ok = false;
    const deps = { ...t.deps, canSubmit: () => ok };
    for (let i = 0; i < 5; i++) {
      await tick(deps);
      t.advance(MIN);
    }
    expect(t.wallet.submits).toEqual([]);
    expect(t.state().breaker.attempts).toEqual([]);
    expect(t.state().log.filter((e) => e.note === "waits-network")).toHaveLength(1);
    ok = true;
    expect((await tick(deps)).outcome).toBe("submitted");
  });

  it("never adopts a round state that existed before the submit (e.g. one the SDK path left)", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    // A leftover the engine doesn't track, not delegated-pending, so no gate.
    t.wallet.rounds.push({ id: 5, state: "awaiting-confirmations", inputs: [] });
    t.wallet.faults.push({ kind: "lost-before-store", message: "worker lost" });
    await tick(t.deps);
    expect(t.state().submitting?.afterRoundId).toBe(5);
    t.advance(MIN);
    await tick(t.deps);
    expect(t.state().log.map((e) => e.kind)).not.toContain("adopted");
    expect(t.state().log.map((e) => e.kind)).toContain("resubmitted");
    expect(t.state().batches[0].roundId).toBeGreaterThan(5);
  });

  it("adopts the round state its own submit created", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    t.wallet.rounds.push({ id: 5, state: "awaiting-confirmations", inputs: [] });
    t.wallet.faults.push({ kind: "lost-after-store", message: "worker lost" });
    await tick(t.deps);
    t.advance(MIN);
    await tick(t.deps);
    const adopted = t.state().log.find((e) => e.kind === "adopted");
    expect(adopted?.roundId).toBe(6);
    expect(t.wallet.submits).toHaveLength(1);
  });

  it("manual: submits exactly what was confirmed, or nothing", async () => {
    const t = setup();
    t.wallet.feePpm = 5000;
    t.wallet.add({ amountSats: 100_000, expiryHeight: TIP + 3000, exitDepth: 1 });
    const pre = await previewManual(t.deps);
    const expectation = { batches: pre.plan.batches.map((b) => b.ids), feeSats: pre.fees.reduce((a, f) => a + f.feeSats, 0) };

    // A coin arrived after the preview: the plan differs, nothing goes.
    const late = t.wallet.add({ amountSats: 30_000, expiryHeight: TIP + 3000, exitDepth: 1 });
    expect((await tick(t.deps, "manual", { expect: expectation })).outcome).toBe("plan-changed");
    expect(t.wallet.submits).toEqual([]);

    // The fee went up since the preview: nothing goes either.
    t.wallet.spend(late.id);
    t.wallet.feePpm = 9000;
    expect((await tick(t.deps, "manual", { expect: expectation })).outcome).toBe("plan-changed");
    expect(t.wallet.submits).toEqual([]);

    t.wallet.feePpm = 5000;
    expect((await tick(t.deps, "manual", { expect: expectation })).outcome).toBe("submitted");
    expect(t.wallet.submits).toEqual(expectation.batches);
  });

  it("manual: an earlier uncertain submit going out again is not reported as the manual refresh", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    t.wallet.faults.push({ kind: "throw-before-server", message: "network error" });
    await tick(t.deps);
    t.advance(MIN);
    const pre = await previewManual(t.deps);
    const r = await tick(t.deps, "manual", {
      expect: { batches: pre.plan.batches.map((b) => b.ids), feeSats: 0 },
    });
    expect(r.outcome).toBe("resubmitted");
  });

  it("refreshNoteSafe: every pending round ours and locked, nothing else", () => {
    const batch = (roundId: number | null, locked: boolean) => ({ ids: ["a"], amountSats: 1, feeSats: 0, roundId, at: 0, manual: false, locked });
    const st = (batches: ReturnType<typeof batch>[]) => ({ ...EMPTY_STATE, batches });
    const pend = (id: number, state = "delegated-pending") => ({ id, state });
    expect(refreshNoteSafe(st([batch(1, true)]), [pend(1)])).toBe(true);
    expect(refreshNoteSafe(st([batch(1, true), batch(2, false)]), [pend(1), pend(2)])).toBe(false);
    expect(refreshNoteSafe(st([batch(1, true)]), [pend(1), pend(9)])).toBe(false);
    expect(refreshNoteSafe(st([batch(1, true)]), [pend(1), pend(9, "failed")])).toBe(true);
    expect(refreshNoteSafe(st([batch(null, true)]), [pend(3)])).toBe(false);
    expect(refreshNoteSafe(st([]), [])).toBe(false);
  });
});

describe("fault injection: random sequences", () => {
  it("invariants hold over thousands of random events", async () => {
    let seed = Number(process.env.SEED ?? 7);
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const faults = ["reject", "lost-before-store", "lost-after-store", "throw-before-server"] as const;

    for (let run = 0; run < 200; run++) {
      const t = setup();
      let tip = TIP;
      for (let i = 0; i < 6; i++) {
        t.wallet.add({
          amountSats: Math.floor(rnd() * (rnd() < 0.3 ? 15_000 : 4_000_000)) + 1,
          expiryHeight: tip + Math.floor(rnd() * 1200) - 50,
          exitDepth: Math.floor(rnd() * 105),
        });
      }
      // Known limit, not fixable locally: an orphaned participation (server
      // accepted, no local round state) is only known through the engine's
      // `submitting` record. Wipe localStorage while one is live and the next
      // submit can overlap it until its round has run. Tolerated here only
      // for that window after a wipe; any other overlap still fails.
      let wipedAt = -Infinity;
      const now = () => t.deps.now();
      for (let step = 0; step < 150; step++) {
        const x = rnd();
        if (x < 0.15) {
          const ids = [...t.wallet.vtxos.keys()];
          const target = ids.find(() => rnd() < 0.3);
          const f = faults[Math.floor(rnd() * faults.length)];
          t.wallet.faults.push({ kind: f, message: f === "reject" ? `bad user input: ${target ?? "?"}` : "worker lost" });
        } else if (x < 0.25 && t.wallet.rounds.length > 0) {
          const r = t.wallet.rounds[Math.floor(rnd() * t.wallet.rounds.length)];
          const z = rnd();
          if (z < 0.4) t.wallet.runRound(tip + 4032);
          else if (z < 0.8) t.wallet.finishRound(r.id, tip + 4032);
          else t.wallet.failRound(r.id);
        } else if (x < 0.27) {
          // A coin the server starts refusing without saying so.
          const ids = [...t.wallet.vtxos.keys()];
          const id = ids[Math.floor(rnd() * ids.length)];
          const w = rnd();
          if (w < 0.4) t.wallet.unusableCoins.add(id);
          else if (w < 0.6) t.wallet.missingCoins.add(id);
          else t.wallet.roundBadCoins.add(id);
        } else if (x < 0.3) {
          const ids = [...t.wallet.vtxos.keys()];
          t.wallet.spend(ids[Math.floor(rnd() * ids.length)]);
        } else if (x < 0.33) {
          t.wallet.lockFaults = 1;
        } else if (x < 0.36) {
          t.wallet.add({ amountSats: Math.floor(rnd() * 200_000) + 1, expiryHeight: tip + Math.floor(rnd() * 600), exitDepth: 1 });
        }
        tip += Math.floor(rnd() * 8);
        t.setTip(tip);
        t.advance(Math.floor(rnd() * 40) * MIN);
        // Sessions: sometimes the engine isn't live (dry-run tick, or just
        // the on-open sweep of an "off"/V1 session), sometimes its
        // localStorage is gone.
        const y = rnd();
        if (y < 0.03) {
          t.store.save(structuredClone(EMPTY_STATE));
          wipedAt = now();
        }
        let passive = false;
        if (y < 0.1) {
          passive = true;
          await sweepEngineLocks(t.deps, false);
          if (rnd() < 0.5) await tick(t.deps, "dry-run");
        } else {
          await tick(t.deps, rnd() < 0.03 ? "manual" : "auto");
        }
        if (passive) {
          // Outside live the engine holds no quarantine lock and no refresh
          // lock beyond a batch whose round is still pending.
          expect(t.wallet.lockedBy(ENGINE.HOLDER_QUARANTINE)).toEqual([]);
          const pending = new Set(t.wallet.rounds.map((r) => r.id));
          const live = new Set(t.state().batches.filter((b) => b.roundId === null || pending.has(b.roundId)).flatMap((b) => b.ids));
          for (const id of t.wallet.lockedBy(ENGINE.HOLDER_REFRESH)) expect(live.has(id)).toBe(true);
        }

        const s = t.state();
        if (now() - wipedAt < FakeWallet.ORPHAN_LIFETIME_MS) {
          t.wallet.violations = t.wallet.violations.filter((v) => !v.startsWith("overlapping live participations"));
        }
        if (t.wallet.violations.length && process.env.DUMP) {
          console.log(JSON.stringify({ run, step, v: t.wallet.violations, log: s.log.map((e) => [e.kind, e.ids?.map((i) => i.slice(-4)), e.roundId, e.note, e.error?.slice(0, 40)]), server: t.wallet.server.map((p) => [p.id, p.inputs.map((i) => i.slice(-4))]), rounds: t.wallet.rounds.map((p) => [p.id, p.state]), batches: s.batches.map((b) => [b.roundId, b.ids.map((i) => i.slice(-4))]), sub: s.submitting }));
        }
        // Never two live participations on one input (checked in the fake),
        // never a non-spendable input, never over the cap.
        expect(t.wallet.violations).toEqual([]);
        // At most 6 submissions in any 24 h window.
        const times = s.breaker.attempts;
        expect(times.length).toBeLessThanOrEqual(6);
        // Our refresh lock only on coins of a batch we still track.
        const tracked = new Set(s.batches.flatMap((b) => b.ids));
        for (const id of t.wallet.lockedBy(ENGINE.HOLDER_REFRESH)) expect(tracked.has(id)).toBe(true);
        // Quarantine lock only on quarantined coins.
        for (const id of t.wallet.lockedBy(ENGINE.HOLDER_QUARANTINE)) expect(s.quarantine[id]).toBeDefined();
        // A tracked batch's coins are never quarantined.
        for (const id of tracked) expect(s.quarantine[id]).toBeUndefined();
        expect(s.log.length).toBeLessThanOrEqual(ENGINE.LOG_MAX);
      }
    }
    // ~30 000 ticks: well past vitest's 5 s default on a busy machine.
  }, 60_000);
});

describe("audit 2026-09-26", () => {
  it("the open-time lock sweep can't save over a batch a concurrent tick just submitted", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    await tick(t.deps);
    const b = t.wallet.add({ amountSats: 60_000, expiryHeight: TIP + 120, exitDepth: 1 });
    t.advance(HOUR);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const origRounds = t.wallet.pendingRoundStates.bind(t.wallet);
    let first = true;
    t.wallet.pendingRoundStates = async () => {
      if (first) {
        first = false; // the sweep's read, held back like a slow sync() ahead of it
        await gate;
      }
      return origRounds();
    };
    const sweep = sweepEngineLocks(t.deps, true);
    const ticked = tick(t.deps);
    release();
    await Promise.all([sweep, ticked]);
    expect(t.state().batches.some((x) => x.ids.includes(b.id))).toBe(true);
    expect(t.wallet.lockedBy(ENGINE.HOLDER_REFRESH)).toEqual([]);
    t.advance(HOUR);
    expect((await tick(t.deps)).outcome).not.toBe("skip-foreign-pending");
  });

  it("dry run: a plan of two batches is logged once, not every tick", async () => {
    const t = setup();
    t.wallet.maxVtxoAmountSats = 100_000;
    t.wallet.add({ amountSats: 90_000, expiryHeight: TIP + 100, exitDepth: 1 });
    t.wallet.add({ amountSats: 80_000, expiryHeight: TIP + 110, exitDepth: 1 });
    for (let i = 0; i < 60; i++) {
      t.advance(MIN);
      await tick(t.deps, "dry-run");
    }
    expect(t.state().log.filter((e) => e.kind === "dry-run")).toHaveLength(2);
  });

  it("a batch too small after its fee is logged once", async () => {
    const t = setup();
    t.wallet.feePpm = 300_000;
    t.wallet.add({ amountSats: 450, expiryHeight: TIP + 100, exitDepth: 1 });
    for (let i = 0; i < 60; i++) {
      t.advance(MIN);
      await tick(t.deps);
    }
    expect(t.state().log.filter((e) => e.note === "below-dust-after-fee")).toHaveLength(1);
  });

  it("the stored state stays small with hundreds of coins", async () => {
    const t = setup();
    t.wallet.maxVtxoAmountSats = 1_000_000;
    for (let i = 0; i < 200; i++) t.wallet.add({ amountSats: 9_000 + i, expiryHeight: TIP + 100 + i, exitDepth: 2 });
    for (let i = 0; i < 40; i++) {
      t.advance(MIN);
      t.setTip(TIP + i);
      await tick(t.deps, "dry-run");
    }
    for (let i = 0; i < 20; i++) {
      t.advance(HOUR);
      await tick(t.deps);
      t.wallet.runRound(TIP + 4032);
    }
    const log = JSON.stringify(t.state().log).length;
    expect(log).toBeLessThanOrEqual(ENGINE.LOG_MAX_CHARS + 2);
    expect(JSON.stringify(t.state()).length).toBeLessThan(400_000);
    const withCoins = t.state().log.find((e) => (e.coinCount ?? 0) > ENGINE.LOG_COIN_DETAIL_MAX);
    expect(withCoins?.coins?.length).toBe(ENGINE.LOG_COIN_DETAIL_MAX);
    expect(withCoins?.ids).toBeUndefined();
  });

  it("parseState drops malformed nested values instead of breaking every tick", async () => {
    const bad = parseState({
      ...EMPTY_STATE,
      breaker: { attempts: "x", consecutiveFailures: "y", tripped: { reason: "rate" } },
      batches: [{ amountSats: 1 }, null, { ids: ["a"], amountSats: 1, at: 1, roundId: 3 }],
      submitting: { ids: ["b"], at: 5, afterRoundId: null },
      quarantine: { q: { at: 1, reason: "weird" }, r: "nope" },
      held: [{ ids: "x" }],
      log: [null, { at: 1, kind: "submitted" }],
    });
    expect(bad.batches).toHaveLength(1);
    expect(bad.breaker).toEqual({ attempts: [], consecutiveFailures: 0, lastFailureAt: null, tripped: null });
    expect(bad.submitting?.afterRoundId).toBe(Number.POSITIVE_INFINITY);
    expect(bad.quarantine).toEqual({ q: { at: 1, reason: "unknown", error: "" } });
    expect(bad.held).toEqual([]);
    expect(bad.log).toHaveLength(1);
    const t = setup(parseState({ ...EMPTY_STATE, batches: [{ amountSats: 1 }], breaker: { attempts: "x" } }));
    t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    expect((await tick(t.deps)).outcome).toBe("submitted");
  });
});

describe("audit 2026-09-26: a server that keeps answering Internal", () => {
  it("trips the breaker instead of submitting 6 times a day forever", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 200, exitDepth: 1 });
    const internal = `error submitting round participation to server: code: 'Internal error', message: "internal error"`;
    const orig = t.wallet.refreshVtxosDelegated.bind(t.wallet);
    t.wallet.refreshVtxosDelegated = async (ids: string[], lockedBy?: string) => {
      t.wallet.faults.push({ kind: "reject", message: internal });
      return orig(ids, lockedBy);
    };
    for (let m = 0; m < 10 * 24 * 60; m += 1) {
      t.advance(MIN);
      await tick(t.deps);
    }
    expect(t.state().breaker.tripped?.reason).toBe("failures");
    // 5 unanswered episodes of at most (window - reserve) submissions each.
    expect(t.wallet.submits.length).toBeLessThanOrEqual(5 * (BREAKER.MAX_ATTEMPTS_PER_WINDOW - ENGINE.RESUBMIT_RESERVE));
  }, 60_000);
});

describe("audit 2026-09-26: worker killed between the lock and the submit's reply", () => {
  it("the stray lock is released and the same inputs go out again (orphan superseded)", async () => {
    const t = setup();
    const due = t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    const orig = t.wallet.refreshAndLock.bind(t.wallet);
    t.wallet.refreshAndLock = async (ids: string[], holderId: string) => {
      // Killed: locked, the server stored it, nothing local, no unlock.
      await t.wallet.lockVtxos(ids, holderId);
      t.wallet.faults.push({ kind: "lost-before-store", message: "worker lost" });
      await t.wallet.refreshVtxosDelegated(ids, holderId).catch(() => {});
      throw new Error("worker lost");
    };
    await tick(t.deps);
    expect(t.state().submitting?.ids).toEqual([due.id]);
    expect(t.wallet.server).toHaveLength(1);
    t.wallet.refreshAndLock = orig;
    t.advance(MIN);
    expect((await tick(t.deps)).outcome).toBe("resubmitted");
    // The resubmit superseded the orphan: one live participation, tracked,
    // and the killed worker's lock is gone (bark could not take the round with it).
    expect(t.wallet.server).toHaveLength(1);
    expect(t.state().batches.map((b) => b.ids)).toEqual([[due.id]]);
    expect(t.wallet.lockedBy(ENGINE.HOLDER_REFRESH)).toEqual([]);
  });
});

describe("audit 2026-09-26: coins no refresh will take", () => {
  it("a coin over the server's cap is counted and raises the island near expiry", async () => {
    const t = setup();
    t.wallet.maxVtxoAmountSats = 1_000_000;
    t.wallet.add({ amountSats: 3_000_000, expiryHeight: TIP + 1000, exitDepth: 1 });
    let r = await tick(t.deps);
    expect(r.status.overCapSats).toBe(3_000_000);
    expect(r.status.unrefreshableSats).toBe(3_000_000);
    expect(r.status.needsAttention).toBeNull();
    t.setTip(TIP + 1000 - 100);
    t.advance(HOUR);
    r = await tick(t.deps);
    expect(r.status.needsAttention).toBe("unrefreshable-urgent");
    expect(t.wallet.submits).toHaveLength(0);
  });
});

describe("review 2026-09-26: rejected resubmits and released batches", () => {
  it("a resubmit rejected because of ONE bad coin doesn't strand the good ones", async () => {
    const t = setup();
    const coins = [100, 110, 120, 130, 140].map((d) => t.wallet.add({ amountSats: 20_000, expiryHeight: TIP + d, exitDepth: 1 }));
    const bad = coins[2];
    t.wallet.faults.push({ kind: "throw-before-server", message: "network error" });
    await tick(t.deps);
    // No orphan exists; the server just never accepted the bad coin.
    t.wallet.unusableCoins.add(bad.id);
    // Isolation of the rest goes at the pace of the 24 h window.
    for (let m = 0; m < 3 * 24 * 6; m++) {
      t.advance(10 * MIN);
      await tick(t.deps);
    }
    expect(t.state().stranded).toEqual({});
    expect(t.state().log.some((e) => e.kind === "strand-check" && e.note === "passed")).toBe(true);
    // Every good coin went out again, the bad one didn't (it ends in quarantine).
    const submitted = new Set(t.state().log.filter((e) => e.kind === "submitted").flatMap((e) => e.coins?.map((c) => c.id) ?? []));
    for (const c of coins) if (c !== bad) expect(submitted.has(c.id)).toBe(true);
    expect(submitted.has(bad.id)).toBe(false);
    expect(t.state().quarantine[bad.id]).toBeDefined();
  });

  it("a resubmit rejected because the orphan landed strands the whole set after two coins fail alone", async () => {
    const t = setup();
    const coins = [100, 110, 120].map((d) => t.wallet.add({ amountSats: 20_000, expiryHeight: TIP + d, exitDepth: 1 }));
    t.wallet.faults.push({ kind: "lost-before-store", message: "network error" });
    await tick(t.deps);
    // A round took the orphan: every input is spent server-side.
    for (const c of coins) t.wallet.unusableCoins.add(c.id);
    for (let m = 0; m < 5; m++) {
      t.advance(MIN);
      await tick(t.deps);
    }
    expect(Object.keys(t.state().stranded).sort()).toEqual(coins.map((c) => c.id).sort());
    expect(t.state().strandCheck).toBeNull();
    // First submit, the resubmit, then two coins alone.
    expect(t.wallet.submits).toHaveLength(4);
    expect(t.state().breaker.consecutiveFailures).toBe(0);
  });

  it("a released batch's leftover lock doesn't keep a dead submit's lock alive", async () => {
    const t = setup();
    const c = t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    await tick(t.deps);
    // Stuck: released after 24 h, and the resubmit's worker dies after the lock.
    t.wallet.refreshAndLock = async (ids: string[], holderId: string) => {
      await t.wallet.lockVtxos(ids, holderId);
      throw new Error("worker lost");
    };
    t.advance(ENGINE.STUCK_MS + MIN);
    await tick(t.deps);
    expect(t.state().batches[0].released).toBe(true);
    expect(t.state().submitting?.ids).toEqual([c.id]);
    expect(t.wallet.lockedBy(ENGINE.HOLDER_REFRESH)).toEqual([c.id]);
    // Next tick: the stray lock goes and the same input is resubmitted, not dropped.
    t.wallet.refreshAndLock = FakeWallet.prototype.refreshAndLock.bind(t.wallet);
    t.advance(MIN);
    expect((await tick(t.deps)).outcome).toBe("resubmitted");
    expect(t.state().log.some((e) => e.kind === "uncertain-dropped")).toBe(false);
    expect(t.state().batches.filter((b) => !b.released).map((b) => b.ids)).toEqual([[c.id]]);
  });

  it("a released batch whose coins a payment spent is not a completed refresh and doesn't lift the breaker", async () => {
    const t = setup();
    const c = t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 3000, exitDepth: 1 });
    await tick(t.deps, "manual");
    const b = t.state().batches[0];
    await releaseBatch(t.deps, b.at);
    t.store.save({ ...t.state(), breaker: { ...t.state().breaker, consecutiveFailures: 5, tripped: { reason: "failures", at: T0, appVersion: "v1" } } });
    // A payment takes the coin; the server drops the participation, the round state fails.
    expect(t.wallet.spend(c.id)).toBe(true);
    t.wallet.failRound(b.roundId!);
    t.advance(MIN);
    await tick(t.deps);
    const kinds = t.kinds();
    expect(kinds).not.toContain("completed");
    expect(kinds).toContain("released-ended");
    expect(t.state().breaker.tripped).not.toBeNull();
    expect(t.state().batches).toEqual([]);
  });
});

describe("a lock in the middle of a tick", () => {
  it("a read that finds the wallet closed leaves no log entry", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 3000, exitDepth: 1 });
    t.wallet.allVtxos = async () => {
      throw new Error("Wallet not open (wallet.allVtxos)");
    };
    const r = await tick(t.deps);
    expect(r.outcome).toBe("error");
    expect(t.state().log).toEqual([]);
  });

  it("a submit that finds the wallet closed counts as never sent", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 100, exitDepth: 1 });
    const real = t.wallet.refreshAndLock.bind(t.wallet);
    t.wallet.refreshAndLock = async () => {
      throw new Error("Wallet not open (wallet.refreshVtxosDelegatedAndLock)");
    };
    await tick(t.deps);
    expect(t.state().submitting).toBeNull();
    expect(t.state().breaker.attempts).toHaveLength(0);
    expect(t.state().breaker.consecutiveFailures).toBe(0);
    expect(t.kinds()).not.toContain("uncertain");
    t.wallet.refreshAndLock = real;
    t.advance(MIN);
    expect((await tick(t.deps)).outcome).toBe("submitted");
  });
});

describe("checks in the log", () => {
  it("every tick is logged, repeats of the same outcome as one entry", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 50_000, expiryHeight: TIP + 3000, exitDepth: 1 });
    await tick(t.deps);
    t.advance(MIN);
    await tick(t.deps);
    t.advance(MIN);
    await tick(t.deps);
    const checks = t.state().log.filter((e) => e.kind === "check");
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ note: "idle", count: 3, at: T0, until: T0 + 2 * MIN });

    t.wallet.add({ amountSats: 40_000, expiryHeight: TIP + 100, exitDepth: 1 });
    t.advance(MIN);
    await tick(t.deps);
    expect(t.kinds().slice(-2)).toEqual(["submitted", "check"]);
    expect(t.state().log.at(-1)?.note).toBe("submitted");
  });
});

describe("a batch the user released", () => {
  it("is not submitted again while its round is pending, and is once the round is over", async () => {
    const t = setup();
    const c = t.wallet.add({ amountSats: 40_000, expiryHeight: TIP + 100, exitDepth: 1 });
    await tick(t.deps);
    expect(t.wallet.submits).toHaveLength(1);
    await releaseBatch(t.deps, t.state().batches[0].at);
    expect(t.wallet.vtxos.get(c.id)?.state.type).toBe("spendable");

    // Within the pending round: nothing goes out, nothing is locked again.
    for (let i = 0; i < 3; i++) {
      t.advance(MIN);
      await tick(t.deps);
    }
    expect(t.wallet.submits).toHaveLength(1);
    expect(t.wallet.lockedBy(ENGINE.HOLDER_REFRESH)).toEqual([]);
    expect(t.kinds()).not.toContain("quarantined");

    // The round fails: the coin is still due and goes out again.
    t.wallet.failRound(t.wallet.rounds[0].id);
    t.advance(MIN);
    await tick(t.deps);
    expect(t.kinds()).toContain("released-ended");
    t.advance(MIN);
    await tick(t.deps);
    expect(t.wallet.submits).toHaveLength(2);
    expect(t.wallet.violations).toEqual([]);
  });
});

describe("isolation groups under dust", () => {
  it("are dissolved, so their coins can ride along again", async () => {
    const small = "c".repeat(64) + ":0";
    const t = setup({ ...EMPTY_STATE, groups: [[small]] });
    t.wallet.add({ id: small, amountSats: 200, expiryHeight: TIP + 3000, exitDepth: 1 });
    const due = t.wallet.add({ amountSats: 40_000, expiryHeight: TIP + 100, exitDepth: 1 });
    await tick(t.deps);
    expect(t.state().groups).toEqual([]);
    expect(t.wallet.submits).toEqual([[due.id, small]]);
  });
});

describe("a user release whose round never ends", () => {
  it("keeps the coins out for at most a day, and raises the island when one nears expiry", async () => {
    const t = setup();
    const c = t.wallet.add({ amountSats: 40_000, expiryHeight: TIP + 245, exitDepth: 1 });
    await tick(t.deps);
    await releaseBatch(t.deps, t.state().batches[0].at);
    // The coin drifts toward expiry while the round stays pending.
    t.setTip(TIP + 110);
    t.advance(HOUR);
    const r = await tick(t.deps);
    expect(t.wallet.submits).toHaveLength(1);
    expect(r.status.needsAttention).toBe("unrefreshable-urgent");
    // A day after the release: planned again (the new submit replaces the
    // participation the server never issued).
    t.advance(ENGINE.STUCK_MS);
    await tick(t.deps);
    expect(t.wallet.submits).toHaveLength(2);
    expect(t.wallet.submits[1]).toEqual([c.id]);
  });
});

describe("manual refresh while an isolation group exists", () => {
  it("submits what the preview showed, not plan-changed", async () => {
    const a = "d".repeat(64) + ":0";
    const b = "e".repeat(64) + ":0";
    const t = setup({ ...EMPTY_STATE, groups: [[a]] });
    t.wallet.add({ id: a, amountSats: 20_000, expiryHeight: TIP + 3000, exitDepth: 1 });
    t.wallet.add({ id: b, amountSats: 30_000, expiryHeight: TIP + 3000, exitDepth: 1 });
    const { plan, fees } = await previewManual(t.deps);
    expect(plan.batches.map((x) => x.ids)).toEqual([[a], [b]]);
    const r = await tick(t.deps, "manual", {
      expect: { batches: plan.batches.map((x) => x.ids), feeSats: fees.reduce((s, f) => s + f.feeSats, 0) },
    });
    expect(r.outcome).toBe("submitted");
  });
});

describe("a round that finishes in the middle of a tick's reads", () => {
  it("is never taken for a failure", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 40_000, expiryHeight: TIP + 100, exitDepth: 1 });
    await tick(t.deps);
    const roundId = t.wallet.rounds[0].id;
    t.wallet.issueRound(roundId);
    t.advance(MIN);
    await tick(t.deps);
    // A sync() elsewhere finishes the round right after a coin read, before
    // anything reads the round states again.
    const read = t.wallet.allVtxos.bind(t.wallet);
    t.wallet.allVtxos = async () => {
      const v = await read();
      if (t.wallet.rounds.some((x) => x.id === roundId)) t.wallet.finishRound(roundId, TIP + 4032);
      return v;
    };
    t.advance(MIN);
    await tick(t.deps);
    t.advance(MIN);
    await tick(t.deps);
    expect(t.kinds()).not.toContain("round-failed");
    expect(t.kinds()).toContain("completed");
    expect(t.state().breaker.consecutiveFailures).toBe(0);
  });
});

describe("a resubmit rejected with named coins", () => {
  const ids = ["a", "b", "c"].map((ch) => ch.repeat(64) + ":0");
  const unusable = (named: string[]) =>
    `error submitting round participation to server: code: 'Client specified an invalid argument', message: "unusable inputs: [${named.join(", ")}]: bad user input: input vtxo(s) unusable"`;
  function uncertain() {
    const t = setup({
      ...EMPTY_STATE,
      submitting: { ids, at: T0 - 2 * MIN, lastAt: T0 - 2 * MIN, resubmits: 0, afterRoundId: 99 },
    });
    ids.forEach((id, i) => t.wallet.add({ id, amountSats: 10_000 + i, expiryHeight: TIP + 100 + i, exitDepth: 1 }));
    return t;
  }

  it("all of them named: the orphan landed, all stranded", async () => {
    const t = uncertain();
    t.wallet.faults.push({ kind: "reject", message: unusable(ids) });
    await tick(t.deps);
    expect(Object.keys(t.state().stranded).sort()).toEqual([...ids].sort());
    expect(t.state().strandCheck).toBeNull();
    expect(t.wallet.submits).toHaveLength(1);
  });

  it("only some named: no orphan landed, just those are bad", async () => {
    const t = uncertain();
    t.wallet.faults.push({ kind: "reject", message: unusable([ids[0]]) });
    await tick(t.deps);
    expect(t.state().stranded).toEqual({});
    expect(t.state().strandCheck).toBeNull();
    expect(t.state().aloneRejects[ids[0]]).toBe(1);
  });

  it("none named: the strand check counts named rejections alone", async () => {
    const t = uncertain();
    t.wallet.faults.push({ kind: "reject", message: unusable([]).replace("unusable inputs: []: ", "") });
    await tick(t.deps);
    expect(t.state().strandCheck).not.toBeNull();
    // Tried alone, soonest expiry first, within one tick; each rejection names its coin.
    t.advance(BREAKER.MAX_BACKOFF_MS);
    t.wallet.faults.push({ kind: "reject", message: unusable([ids[0]]) }, { kind: "reject", message: unusable([ids[1]]) });
    await tick(t.deps);
    expect(t.state().strandCheck).toBeNull();
    expect(Object.keys(t.state().stranded).sort()).toEqual([...ids].sort());
    expect(t.state().quarantine).toEqual({});
    // One resubmit and two coins tried alone.
    expect(t.wallet.submits).toHaveLength(3);
  });
});

describe("an uncertain submit whose lock survived (worker killed after the lock)", () => {
  it("adopts the round and lets the lock go, so bark can take the round", async () => {
    const id = "f".repeat(64) + ":0";
    const t = setup({
      ...EMPTY_STATE,
      submitting: { ids: [id], at: T0 - 2 * MIN, lastAt: T0 - 2 * MIN, resubmits: 0, afterRoundId: 1 },
    });
    t.wallet.add({ id, amountSats: 40_000, expiryHeight: TIP + 100, exitDepth: 1, state: { type: "locked", holder: { type: "action", id: ENGINE.HOLDER_REFRESH } } });
    // bark stored the participation, the reply never arrived.
    t.wallet.rounds.push({ id: 5, state: "delegated-pending", inputs: [id] });
    t.wallet.server.push({ id: 5, inputs: [id], at: T0 - 2 * MIN });
    await tick(t.deps);
    expect(t.kinds()).toContain("adopted");
    expect(t.state().batches.map((b) => [b.roundId, b.locked])).toEqual([[5, false]]);
    expect(t.wallet.lockedBy(ENGINE.HOLDER_REFRESH)).toEqual([]);
    expect(t.wallet.issueRound(5)).toBe(true);
    expect(t.wallet.violations).toEqual([]);
  });

  it("resubmits (taking the lock over) when nothing was stored", async () => {
    const id = "9".repeat(64) + ":0";
    const t = setup({
      ...EMPTY_STATE,
      submitting: { ids: [id], at: T0 - 2 * MIN, lastAt: T0 - 2 * MIN, resubmits: 0, afterRoundId: 1 },
    });
    t.wallet.add({ id, amountSats: 40_000, expiryHeight: TIP + 100, exitDepth: 1, state: { type: "locked", holder: { type: "action", id: ENGINE.HOLDER_REFRESH } } });
    await tick(t.deps);
    expect(t.wallet.submits).toEqual([[id]]);
    expect(t.state().submitting).toBeNull();
    expect(t.wallet.lockedBy(ENGINE.HOLDER_REFRESH)).toEqual([]);
    expect(t.wallet.violations).toEqual([]);
  });
});

describe("what a tick reports", () => {
  it("partial: one batch went out, a later one didn't", async () => {
    const t = setup();
    t.wallet.maxVtxoAmountSats = 50_000;
    t.wallet.add({ amountSats: 40_000, expiryHeight: TIP + 100, exitDepth: 1 });
    const b = t.wallet.add({ amountSats: 40_000, expiryHeight: TIP + 120, exitDepth: 1 });
    t.wallet.unusableCoins.add(b.id);
    expect((await tick(t.deps)).outcome).toBe("partial");
  });

  it("the worker's own 24 h cap waits, it is no failure", async () => {
    const t = setup();
    t.wallet.add({ amountSats: 40_000, expiryHeight: TIP + 100, exitDepth: 1 });
    t.wallet.faults.push({ kind: "reject", message: "REFRESH_LIMIT_EXCEEDED" });
    expect((await tick(t.deps)).outcome).toBe("skip-rate");
    expect(t.state().breaker.consecutiveFailures).toBe(0);
    expect(t.state().breaker.attempts).toEqual([]);
    expect(t.state().submitting).toBeNull();
  });

  it("a resubmit that was rejected is not reported as resubmitted", async () => {
    const id = "8".repeat(64) + ":0";
    const t = setup({
      ...EMPTY_STATE,
      submitting: { ids: [id], at: T0 - 2 * MIN, lastAt: T0 - 2 * MIN, resubmits: 0, afterRoundId: 1 },
    });
    t.wallet.add({ id, amountSats: 40_000, expiryHeight: TIP + 100, exitDepth: 1 });
    t.wallet.faults.push({ kind: "reject", message: "bad user input: fee too low" });
    expect((await tick(t.deps)).outcome).toBe("failed");
  });
});
