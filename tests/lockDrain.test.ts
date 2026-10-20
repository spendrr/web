import { describe, expect, it } from "vitest";
import {
  CUTTABLE_ONCHAIN_METHODS,
  CUTTABLE_WALLET_METHODS,
  canTerminateOnLock,
  mustFinishBeforeLock,
} from "../src/lib/wallet/lockDrain";
import {
  ONCHAIN_READ_METHODS,
  WALLET_ALWAYS_AUTH_METHODS,
  WALLET_LOCK_METHODS,
  WALLET_OWN_FUNDS_METHODS,
  WALLET_READ_METHODS,
  WALLET_SEND_METHODS,
} from "../src/lib/wallet/walletSpendPolicy";

const call = (target: string, method: string) => ({ type: "call", target, method });

describe("lock may terminate the worker", () => {
  it("lets pure reads and sync go", () => {
    for (const m of ["sync", "history", "allVtxos", "vtxos", "balance", "pendingRoundStates"]) {
      expect(mustFinishBeforeLock(call("wallet", m)), m).toBe(false);
    }
    expect(mustFinishBeforeLock(call("onchain", "sync"))).toBe(false);
  });

  it("waits for reads that write: a round submit, CPFP broadcast, locks, key indices", () => {
    for (const m of [
      "maintenance",
      "maintenanceDelegated",
      "progressPendingRounds",
      "cancelPendingRound",
      "cancelAllPendingRounds",
      "progressExits",
      "syncExitLocks",
      "newAddress",
      "bolt11Invoice",
      "cancelLightningReceive",
      "refreshServer",
    ]) {
      expect(mustFinishBeforeLock(call("wallet", m)), m).toBe(true);
    }
    expect(mustFinishBeforeLock(call("onchain", "newAddress"))).toBe(true);
  });

  it("waits for everything that moves money or changes locks", () => {
    for (const set of [WALLET_SEND_METHODS, WALLET_ALWAYS_AUTH_METHODS, WALLET_OWN_FUNDS_METHODS, WALLET_LOCK_METHODS]) {
      for (const m of set) expect(mustFinishBeforeLock(call("wallet", m)), m).toBe(true);
    }
    expect(mustFinishBeforeLock(call("wallet", "refreshVtxosDelegatedAndLock"))).toBe(true);
  });

  it("treats an unclassified method, target or request type as not cuttable", () => {
    expect(mustFinishBeforeLock(call("wallet", "someFutureMethod"))).toBe(true);
    expect(mustFinishBeforeLock(call("onchain", "send"))).toBe(true);
    expect(mustFinishBeforeLock(call("gift", "sync"))).toBe(true);
    expect(mustFinishBeforeLock({ type: "somethingNew" })).toBe(true);
    expect(mustFinishBeforeLock({ type: "call" })).toBe(true);
  });

  it("lets the plain lifecycle requests go", () => {
    for (const type of ["ensureWasm", "chatKey", "close", "prepareSession", "openHeld"]) {
      expect(mustFinishBeforeLock({ type }), type).toBe(false);
    }
  });

  it("every cuttable method is a classified read, never a money method", () => {
    for (const m of CUTTABLE_WALLET_METHODS) expect(WALLET_READ_METHODS.has(m), m).toBe(true);
    for (const m of CUTTABLE_ONCHAIN_METHODS) expect(ONCHAIN_READ_METHODS.has(m), m).toBe(true);
    for (const set of [WALLET_SEND_METHODS, WALLET_ALWAYS_AUTH_METHODS, WALLET_OWN_FUNDS_METHODS, WALLET_LOCK_METHODS]) {
      for (const m of set) expect(CUTTABLE_WALLET_METHODS.has(m), m).toBe(false);
    }
  });

  it("a single in-flight send keeps the whole queue from being dropped", () => {
    const reads = [{ payload: call("wallet", "sync") }, { payload: call("wallet", "history") }];
    expect(canTerminateOnLock(reads)).toBe(true);
    expect(canTerminateOnLock([...reads, { payload: call("wallet", "sendArkoorPayment") }])).toBe(false);
    expect(canTerminateOnLock([])).toBe(true);
  });
});
