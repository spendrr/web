// Regression coverage for clearSelfInflictedConflictLatch (src/lib/backup/backup.ts).
// Real incident (2026-09-19): the post-open one-shot upload and the debounced
// uploader overlapped, both read the same server version, one committed and
// the other got a 409, latching uploads off as if another device had written.
// Uploads are serialized now; this covers the way out for an existing latch,
// and that it never lifts a latch it shouldn't.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/wallet/bark", () => ({ maintenanceWithDeadline: vi.fn() }));
vi.mock("../src/lib/maintenance/maintenanceSuppress", () => ({ isMaintenanceSuppressed: () => false }));

const { clearSelfInflictedConflictLatch, isRestoreFailureLatched, recordRestoreFailure } = await import(
  "../src/lib/backup/backup"
);

const LOOKUP = "abc123";
const keys = { lookupKey: LOOKUP, writeToken: "b".repeat(64), encryptionKey: {} as CryptoKey };

function latchConflict(knownVersion: number) {
  localStorage.setItem("btc-wallet-backup-restore-failed", "BackupVersionConflictError: commit rejected");
  localStorage.setItem("btc-wallet-backup-conflict-latched", "1");
  localStorage.setItem(`btc-wallet-backup-known-version:${LOOKUP}`, String(knownVersion));
}

function serverAt(version: number | "error", sha256: string | null = null) {
  const fetchMock = vi.fn(async () =>
    version === "error" ? new Response("", { status: 500 }) : Response.json({ version, sha256 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("clearSelfInflictedConflictLatch", () => {
  it("lifts a conflict latch when the server holds exactly this device's last version", async () => {
    latchConflict(7);
    serverAt(7);
    expect(await clearSelfInflictedConflictLatch(keys)).toBe(true);
    expect(isRestoreFailureLatched()).toBe(false);
  });

  it("keeps the latch when another device has committed since", async () => {
    latchConflict(7);
    serverAt(8);
    expect(await clearSelfInflictedConflictLatch(keys)).toBe(false);
    expect(isRestoreFailureLatched()).toBe(true);
  });

  it("keeps the latch when the server has no versioned backup", async () => {
    latchConflict(0);
    serverAt(0);
    expect(await clearSelfInflictedConflictLatch(keys)).toBe(false);
    expect(isRestoreFailureLatched()).toBe(true);
  });

  it("keeps the latch when the meta check fails", async () => {
    latchConflict(7);
    serverAt("error");
    expect(await clearSelfInflictedConflictLatch(keys)).toBe(false);
    expect(isRestoreFailureLatched()).toBe(true);
  });

  it("lifts a pre-marker conflict latch recognised by its message", async () => {
    latchConflict(7);
    localStorage.removeItem("btc-wallet-backup-conflict-latched");
    serverAt(7);
    expect(await clearSelfInflictedConflictLatch(keys)).toBe(true);
    expect(isRestoreFailureLatched()).toBe(false);
  });

  it("keeps the latch when the meta request hangs past the timeout", async () => {
    latchConflict(7);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_: unknown, init: RequestInit) =>
          new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
      ),
    );
    vi.useFakeTimers();
    const p = clearSelfInflictedConflictLatch(keys);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe(false);
    vi.useRealTimers();
    expect(isRestoreFailureLatched()).toBe(true);
  });

  it("never lifts a real restore-failure latch, even with matching versions", async () => {
    latchConflict(7);
    recordRestoreFailure(new Error("backup fetch failed: 500"));
    const fetchMock = serverAt(7);
    expect(await clearSelfInflictedConflictLatch(keys)).toBe(false);
    expect(isRestoreFailureLatched()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The latch seen 2026-09-21 (server at 86, device knew 85) most likely came
  // from a commit that reached the server while its reply never reached the
  // device.
  describe("lost commit reply", () => {
    const pending = (base: number, sha256: string) =>
      localStorage.setItem(`btc-wallet-backup-pending-commit:${LOOKUP}`, JSON.stringify({ base, sha256 }));

    it("lifts the latch when the server holds exactly the commit this device sent", async () => {
      latchConflict(85);
      pending(85, "aa");
      serverAt(86, "aa");
      expect(await clearSelfInflictedConflictLatch(keys)).toBe(true);
      expect(isRestoreFailureLatched()).toBe(false);
      expect(localStorage.getItem(`btc-wallet-backup-known-version:${LOOKUP}`)).toBe("86");
      expect(localStorage.getItem(`btc-wallet-backup-last-hash:${LOOKUP}`)).toBe("aa");
      expect(localStorage.getItem(`btc-wallet-backup-pending-commit:${LOOKUP}`)).toBeNull();
    });

    it("keeps the latch when the next version holds other bytes (another device)", async () => {
      latchConflict(85);
      pending(85, "aa");
      serverAt(86, "bb");
      expect(await clearSelfInflictedConflictLatch(keys)).toBe(false);
      expect(isRestoreFailureLatched()).toBe(true);
    });

    it("keeps the latch when another device committed on top of the lost one", async () => {
      latchConflict(85);
      pending(85, "aa");
      serverAt(87, "aa");
      expect(await clearSelfInflictedConflictLatch(keys)).toBe(false);
      expect(isRestoreFailureLatched()).toBe(true);
    });

    it("keeps the latch without a pending marker (latched before this fix)", async () => {
      latchConflict(85);
      serverAt(86, "aa");
      expect(await clearSelfInflictedConflictLatch(keys)).toBe(false);
      expect(isRestoreFailureLatched()).toBe(true);
    });
  });
});
