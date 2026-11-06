// A wallet reset must drop the restore-failure latch: it is one browser-wide
// flag, and the next wallet would otherwise start with uploads switched off.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/wallet/bark", () => ({ maintenanceWithDeadline: vi.fn() }));
vi.mock("../src/lib/maintenance/maintenanceSuppress", () => ({ isMaintenanceSuppressed: () => false }));
vi.mock("../src/lib/vault/crypto", () => ({ clearVault: vi.fn() }));
vi.mock("../src/lib/vault/deviceVault", () => ({ clearDeviceVault: vi.fn(async () => {}) }));
vi.mock("../src/lib/gift/giftStore", () => ({
  GIFTS_DB_NAME: "gifts",
  clearNeedsSeedBackup: vi.fn(),
  clearPendingGiftPassword: vi.fn(),
}));
vi.mock("../src/lib/vault/webauthn", () => ({ clearBiometricUnlock: vi.fn() }));
vi.mock("../src/lib/exit/emergencyExit", () => ({ clearAllExitState: vi.fn() }));
vi.mock("../src/lib/notifications", () => ({ clearPushHeightToken: vi.fn(), disableNotifications: vi.fn(async () => {}) }));
vi.mock("../src/lib/wallet/onchainReceiveAddress", () => ({ clearStoredReceiveAddress: vi.fn() }));
vi.mock("../src/lib/refreshEngine/runner", () => ({ clearEngineStates: vi.fn() }));
vi.mock("../src/lib/chat/pushSlots", () => ({ clearPushSlots: vi.fn(async () => {}) }));
vi.mock("../src/lib/chat/chatEnabled", () => ({ setChatPushSettings: vi.fn() }));

const { clearAllLocalWalletState } = await import("../src/lib/vault/resetLocalState");
const { isRestoreFailureLatched, recordRestoreFailure } = await import("../src/lib/backup/backup");

beforeEach(() => localStorage.clear());

describe("clearAllLocalWalletState", () => {
  it("drops a restore-failure latch", async () => {
    recordRestoreFailure(new Error("restore failed"));
    expect(isRestoreFailureLatched()).toBe(true);
    await clearAllLocalWalletState();
    expect(isRestoreFailureLatched()).toBe(false);
  });
});
