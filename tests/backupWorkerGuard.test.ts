import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKUP_WORKER_BLOCKED, installBackupNetworkGuards } from "../src/lib/backup/backupWorkerGuard";

const saved = new Map<string, unknown>();
for (const n of BACKUP_WORKER_BLOCKED) saved.set(n, (globalThis as Record<string, unknown>)[n]);
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [n, v] of saved) (globalThis as Record<string, unknown>)[n] = v;
});

describe("backup worker guard", () => {
  it("blocks every network primitive that exists in the realm", () => {
    (globalThis as Record<string, unknown>).fetch ??= () => 0;
    vi.stubGlobal("self", globalThis);
    installBackupNetworkGuards();
    for (const n of BACKUP_WORKER_BLOCKED) {
      if (!(n in globalThis)) continue;
      expect(() => (globalThis as unknown as Record<string, () => void>)[n]()).toThrow(/not used by the backup worker/);
    }
    expect(() => fetch("https://example.com")).toThrow();
  });
});
