// Regression coverage for src/lib/backup/backup.ts's waitForLocalStateToSettle —
// the fix for a real production incident (2026-09-13): a brand-new wallet
// received two Arkoor payments back to back, uploadBackupNow() fired on the
// very next tick after Wallet.open() resolved, and only caught the first
// VTXO. Every later restore (even to a fresh browser) then re-applied that
// incomplete snapshot before the SDK's own open-time recovery scan could
// ever run again, permanently hiding the second VTXO. See waitForLocalStateToSettle's
// own comment in backup.ts for the full mechanism.
//
// waitForLocalStateToSettle also calls the module-level maintenanceWithDeadline()
// (bark.ts) and isMaintenanceSuppressed() (maintenanceSuppress.ts) — not a
// method on the wallet object passed in — so both are mocked here rather
// than stubbed on the fake `wallet`. This replaces an earlier version of
// this file that mocked a nonexistent `wallet.maintenance()` method: after
// backup.ts was refactored (commit b80d474) to call maintenanceWithDeadline()
// directly, that mock became dead code and the real, unmocked
// maintenanceWithDeadline() (which talks to the wallet worker) threw
// immediately in this test environment — silently passing every test
// (0 calls to allVtxos ever observed) while actually proving nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const maintenanceWithDeadline = vi.fn();
vi.mock("../src/lib/wallet/bark", () => ({ maintenanceWithDeadline: (...a: unknown[]) => maintenanceWithDeadline(...a) }));

let maintenanceSuppressed = false;
vi.mock("../src/lib/maintenance/maintenanceSuppress", () => ({
  isMaintenanceSuppressed: () => maintenanceSuppressed,
}));

const { waitForLocalStateToSettle } = await import("../src/lib/backup/backup");

beforeEach(() => {
  vi.useFakeTimers();
  maintenanceSuppressed = false;
  maintenanceWithDeadline.mockReset();
  maintenanceWithDeadline.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// Drives the fake-timer poll loop: flushes microtasks (so the awaited
// promise inside the loop settles) then advances real+fake time so the next
// setTimeout fires, repeated enough times to cover the whole bounded wait
// (SETTLE_MAX_WAIT_MS / SETTLE_POLL_MS in backup.ts, kept in sync here).
async function runSettleLoop() {
  for (let i = 0; i < 65; i++) {
    await vi.advanceTimersByTimeAsync(3000);
  }
}

describe("waitForLocalStateToSettle", () => {
  it("resolves once two consecutive allVtxos() reads agree", async () => {
    let call = 0;
    const wallet = {
      // First read: one vtxo. Second and onward: two vtxos (settled) —
      // mirrors the real incident where a second VTXO's local write landed
      // slightly after the first.
      allVtxos: vi.fn().mockImplementation(async () => {
        call++;
        return call === 1 ? [{ id: "a" }] : [{ id: "a" }, { id: "b" }];
      }),
    };
    const settled = waitForLocalStateToSettle(wallet);
    await runSettleLoop();
    await settled;
    // Three reads: [a] (first, no comparison yet) -> [a,b] (differs, becomes
    // new baseline) -> [a,b] again (matches baseline, resolves).
    expect(wallet.allVtxos).toHaveBeenCalledTimes(3);
  });

  it("resolves immediately-ish when the first two reads already agree (an empty or already-settled wallet)", async () => {
    const wallet = { allVtxos: vi.fn().mockResolvedValue([]) };
    const settled = waitForLocalStateToSettle(wallet);
    await runSettleLoop();
    await settled;
    expect(wallet.allVtxos).toHaveBeenCalledTimes(2);
  });

  it("gives up after the bounded max wait if the vtxo set never stabilizes", async () => {
    let call = 0;
    const wallet = {
      // Never stabilizes: a different vtxo id set on every read.
      allVtxos: vi.fn().mockImplementation(async () => {
        call++;
        return [{ id: `vtxo-${call}` }];
      }),
    };
    const settled = waitForLocalStateToSettle(wallet);
    await runSettleLoop();
    await settled; // must not hang forever
    // Bounded by SETTLE_MAX_WAIT_MS (3min) / SETTLE_POLL_MS (3s) — ~60 reads,
    // not unbounded.
    expect(wallet.allVtxos.mock.calls.length).toBeGreaterThan(1);
    expect(wallet.allVtxos.mock.calls.length).toBeLessThan(65);
  });

  it("does not throw and returns promptly if allVtxos() itself errors", async () => {
    const wallet = { allVtxos: vi.fn().mockRejectedValue(new Error("worker lost")) };
    await expect(waitForLocalStateToSettle(wallet)).resolves.toBeUndefined();
    expect(wallet.allVtxos).toHaveBeenCalledTimes(1);
  });

  it("a maintenance() failure skips just that attempt, not the whole settle wait — the regression this test file exists to catch", async () => {
    // maintenanceWithDeadline() is documented (bark.ts) to hang/timeout
    // against a stalled Ark round-coordinator — a real, previously-observed
    // failure mode, not a hypothetical one. Before the fix, catching this
    // inside the same try as allVtxos() meant a single failed maintenance
    // attempt aborted the entire settle loop via `return`, before ever
    // calling allVtxos() even once — silently reintroducing the exact
    // 2026-09-13 premature-backup incident this function exists to prevent.
    maintenanceWithDeadline.mockRejectedValue(new Error("round-coordinator stalled"));
    let call = 0;
    const wallet = {
      allVtxos: vi.fn().mockImplementation(async () => {
        call++;
        return call === 1 ? [{ id: "a" }] : [{ id: "a" }, { id: "b" }];
      }),
    };
    const settled = waitForLocalStateToSettle(wallet);
    await runSettleLoop();
    await settled;
    // Must still reach the same settle result as the happy path above —
    // maintenance failing on every attempt must not prevent allVtxos() from
    // ever running or from being allowed to settle.
    expect(wallet.allVtxos).toHaveBeenCalledTimes(3);
    expect(maintenanceWithDeadline).toHaveBeenCalledTimes(3);
  });

  it("skips maintenanceWithDeadline() entirely when suppressed, but still settles via allVtxos()", async () => {
    maintenanceSuppressed = true;
    const wallet = { allVtxos: vi.fn().mockResolvedValue([]) };
    const settled = waitForLocalStateToSettle(wallet);
    await runSettleLoop();
    await settled;
    expect(maintenanceWithDeadline).not.toHaveBeenCalled();
    expect(wallet.allVtxos).toHaveBeenCalledTimes(2);
  });
});
