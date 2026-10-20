import { describe, expect, it, vi } from "vitest";
import {
  blocksDelegatedSchedule,
  createDelegatedMaintenanceScheduler,
  createSettleMaintenance,
  SCHEDULE_COOLDOWN_MS,
  type AttemptLog,
  type PendingRoundState,
} from "../src/lib/maintenance/delegatedMaintenance";

// Fake clock + attempt store, so no test depends on a real localStorage or
// on wall-clock time.
function fakeAttempts(startAt = 1_000_000): AttemptLog & { advance(ms: number): void } {
  let clock = startAt;
  const store = new Map<string, number>();
  return {
    now: () => clock,
    lastAt: (key) => store.get(key) ?? null,
    record: (key, at) => void store.set(key, at),
    advance: (ms) => void (clock += ms),
  };
}

// Every scheduler test injects the fake log; the cooldown is exercised
// explicitly in its own block below.
const scheduler = (schedule: () => Promise<void>, attempts: AttemptLog = fakeAttempts()) =>
  createDelegatedMaintenanceScheduler(schedule, attempts);

const wallet = (pending: PendingRoundState[]) => ({
  pendingRoundStates: vi.fn().mockResolvedValue(pending),
});

const delegated: PendingRoundState = { state: "delegated-pending" };

describe("blocksDelegatedSchedule", () => {
  it("blocks only on a delegated participation", () => {
    expect(blocksDelegatedSchedule(delegated)).toBe(true);
  });

  // The interactive kinds lock their input VTXOs, so those VTXOs are not
  // Spendable and can't be handed to a second participation. Blocking on
  // them is what left V2 with no refresh at all behind a stale one.
  it.each(["pending", "ongoing", "awaiting-confirmations", "failed", "canceled"] as const)(
    "does not block on %s",
    (state) => {
      expect(blocksDelegatedSchedule({ state })).toBe(false);
    },
  );

  it("fails closed on a missing or unrecognised kind", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(blocksDelegatedSchedule({})).toBe(true);
    expect(blocksDelegatedSchedule(null)).toBe(true);
    expect(blocksDelegatedSchedule({ state: "something-new" } as unknown as PendingRoundState)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

describe("createDelegatedMaintenanceScheduler", () => {
  it("schedules when no round state is pending", async () => {
    const schedule = vi.fn().mockResolvedValue(undefined);
    const run = scheduler(schedule);
    await expect(run(wallet([]))).resolves.toBe(true);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("does not schedule while a delegated round state is pending", async () => {
    const schedule = vi.fn().mockResolvedValue(undefined);
    const run = scheduler(schedule);
    await expect(run(wallet([delegated]))).resolves.toBe(false);
    expect(schedule).not.toHaveBeenCalled();
  });

  // The regression this gate's first version caused: one stuck interactive
  // state switched delegated refresh off for the whole session, and nothing
  // on our side could clear it (sync() skips ongoing participations).
  it("still schedules behind a stuck interactive round state", async () => {
    const schedule = vi.fn().mockResolvedValue(undefined);
    const run = scheduler(schedule);
    await expect(run(wallet([{ state: "ongoing" }, { state: "awaiting-confirmations" }]))).resolves.toBe(true);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("blocks when a delegated state sits among non-blocking ones", async () => {
    const schedule = vi.fn().mockResolvedValue(undefined);
    const run = scheduler(schedule);
    await expect(run(wallet([{ state: "ongoing" }, delegated]))).resolves.toBe(false);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("serializes concurrent callers so only one passes the check", async () => {
    const pending: PendingRoundState[] = [];
    const w = { pendingRoundStates: vi.fn(async () => [...pending]) };
    const schedule = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      pending.push(delegated);
    });
    const run = scheduler(schedule);
    const results = await Promise.all([run(w), run(w), run(w)]);
    expect(results).toEqual([true, false, false]);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  // A rejected schedule must not wedge the serialization chain. (It does
  // spend the cooldown, which the cooldown block below covers, so this
  // steps past it to isolate the chain behaviour.)
  it("keeps working after a failed schedule", async () => {
    const attempts = fakeAttempts();
    const schedule = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const run = scheduler(schedule, attempts);
    await expect(run(wallet([]))).rejects.toThrow("boom");
    attempts.advance(SCHEDULE_COOLDOWN_MS);
    await expect(run(wallet([]))).resolves.toBe(true);
  });

  it("propagates an error from the pending check", async () => {
    const schedule = vi.fn();
    const run = scheduler(schedule);
    const w = { pendingRoundStates: vi.fn().mockRejectedValue(new Error("worker gone")) };
    await expect(run(w)).rejects.toThrow("worker gone");
    expect(schedule).not.toHaveBeenCalled();
  });
});

describe("createSettleMaintenance", () => {
  const settleWallet = (pending: PendingRoundState[]) => ({
    ...wallet(pending),
    sync: vi.fn().mockResolvedValue(undefined),
  });

  it("does not sync when the schedule went through", async () => {
    const w = settleWallet([]);
    const settle = createSettleMaintenance(vi.fn().mockResolvedValue(true));
    await settle(w);
    expect(w.sync).not.toHaveBeenCalled();
  });

  // Without this the settle loop would have no server round-trip at all
  // while a delegated round is pending, and would call "settled" on two
  // identical allVtxos() reads 3s apart.
  it("falls back to sync() when the schedule was skipped", async () => {
    const w = settleWallet([delegated]);
    const settle = createSettleMaintenance(vi.fn().mockResolvedValue(false));
    await settle(w);
    expect(w.sync).toHaveBeenCalledTimes(1);
  });

  it("propagates a schedule failure without syncing", async () => {
    const w = settleWallet([]);
    const settle = createSettleMaintenance(vi.fn().mockRejectedValue(new Error("nope")));
    await expect(settle(w)).rejects.toThrow("nope");
    expect(w.sync).not.toHaveBeenCalled();
  });

  it("wires through the real scheduler end to end", async () => {
    const schedule = vi.fn().mockResolvedValue(undefined);
    const settle = createSettleMaintenance(scheduler(schedule));
    const blocked = settleWallet([delegated]);
    await settle(blocked);
    expect(schedule).not.toHaveBeenCalled();
    expect(blocked.sync).toHaveBeenCalledTimes(1);

    const free = settleWallet([]);
    await settle(free);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(free.sync).not.toHaveBeenCalled();
  });
});

describe("delegated schedule cooldown", () => {
  const free = (fingerprint = "fp") => ({ fingerprint, pendingRoundStates: vi.fn().mockResolvedValue([]) });

  it("submits the first attempt", async () => {
    const schedule = vi.fn().mockResolvedValue(undefined);
    await expect(scheduler(schedule, fakeAttempts())(free())).resolves.toBe(true);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("suppresses a second attempt inside the cooldown, without a wallet call", async () => {
    const attempts = fakeAttempts();
    const schedule = vi.fn().mockResolvedValue(undefined);
    const run = scheduler(schedule, attempts);
    const w = free();
    await run(w);
    attempts.advance(SCHEDULE_COOLDOWN_MS - 1);
    await expect(run(w)).resolves.toBe(false);
    expect(schedule).toHaveBeenCalledTimes(1);
    // The cooldown is checked first, so the cooled-down cycle costs nothing.
    expect(w.pendingRoundStates).toHaveBeenCalledTimes(1);
  });

  it("allows another attempt once the cooldown elapses", async () => {
    const attempts = fakeAttempts();
    const schedule = vi.fn().mockResolvedValue(undefined);
    const run = scheduler(schedule, attempts);
    await run(free());
    attempts.advance(SCHEDULE_COOLDOWN_MS);
    await expect(run(free())).resolves.toBe(true);
    expect(schedule).toHaveBeenCalledTimes(2);
  });

  // The window the pending-state gate cannot see: the submission reached the
  // server but the worker died before the local round state was stored, so
  // there is nothing to gate on. The record is written before the call for
  // exactly this reason.
  it("still counts an attempt that never returned", async () => {
    const attempts = fakeAttempts();
    const never = vi.fn(() => new Promise<void>(() => {}));
    const run = scheduler(never, attempts);
    void run(free());
    await Promise.resolve();
    await Promise.resolve();
    // A fresh scheduler stands in for the reload after the worker was killed.
    const afterReload = vi.fn().mockResolvedValue(undefined);
    await expect(scheduler(afterReload, attempts)(free())).resolves.toBe(false);
    expect(afterReload).not.toHaveBeenCalled();
  });

  it("counts a failed attempt too", async () => {
    const attempts = fakeAttempts();
    const schedule = vi.fn().mockRejectedValue(new Error("no VTXOs to refresh after excluding"));
    const run = scheduler(schedule, attempts);
    await expect(run(free())).rejects.toThrow("no VTXOs");
    await expect(run(free())).resolves.toBe(false);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("does not spend the cooldown when the pending-state gate blocked", async () => {
    const attempts = fakeAttempts();
    const schedule = vi.fn().mockResolvedValue(undefined);
    const run = scheduler(schedule, attempts);
    const blocked = { fingerprint: "fp", pendingRoundStates: vi.fn().mockResolvedValue([delegated]) };
    await expect(run(blocked)).resolves.toBe(false);
    await expect(run(free())).resolves.toBe(true);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("keeps separate cooldowns per wallet", async () => {
    const attempts = fakeAttempts();
    const schedule = vi.fn().mockResolvedValue(undefined);
    const run = scheduler(schedule, attempts);
    await expect(run(free("wallet-a"))).resolves.toBe(true);
    await expect(run(free("wallet-b"))).resolves.toBe(true);
    await expect(run(free("wallet-a"))).resolves.toBe(false);
  });
});
