// The V1 (four-request) upload flow; the beta put flow is in tests/backupPerformUpload.test.ts.
// One backup cycle end to end with a fake engine: which engine runs, what the fallback repeats, and that a retired
// uploader never reaches the commit. The engine's own behaviour is in backupEngine.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupEngine } from "../src/lib/backup/backupEngine";

vi.mock("../src/lib/wallet/bark", () => ({ maintenanceWithDeadline: vi.fn() }));
vi.mock("../src/lib/maintenance/maintenanceSuppress", () => ({ isMaintenanceSuppressed: () => false }));
vi.mock("../src/lib/backup/backupStore", () => ({
  ARK_DB_NAME: "ark",
  ONCHAIN_DB_NAME: "onchain",
  dumpDatabase: async () => null,
  hasAnyLocalWalletData: async () => true,
  restoreDatabase: vi.fn(),
}));

const cfg: { worker: boolean; makeWorker: () => BackupEngine; makeInline: () => BackupEngine } = {
  worker: true,
  makeWorker: () => {
    throw new Error("unset");
  },
  makeInline: () => {
    throw new Error("unset");
  },
};
vi.mock("../src/lib/backup/backupEngine", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/backup/backupEngine")>("../src/lib/backup/backupEngine");
  return {
    ...actual,
    wantsBackupWorker: () => cfg.worker,
    createWorkerEngine: () => cfg.makeWorker(),
    createInlineEngine: () => cfg.makeInline(),
  };
});

const { uploadBackupNow, createBackupUploader, getBackupEngineNote, getLastBackupStatus } = await import("../src/lib/backup/backup");
const { BackupWorkerFailure } = await import("../src/lib/backup/backupEngine");

const keys = { lookupKey: "abc", writeToken: "b".repeat(64), encryptionKey: {} as CryptoKey };

interface Fake extends BackupEngine {
  steps: string[];
}
function engine(over: Partial<BackupEngine> = {}): Fake {
  const steps: string[] = [];
  return {
    steps,
    prepare: async () => {
      steps.push("prepare");
      return { kind: "ready", expectedHash: "h", fingerprint: "f" };
    },
    encrypt: async () => {
      steps.push("encrypt");
      return { ivHex: "00", cipherB64: "AA==" };
    },
    verify: async () => {
      steps.push("verify");
      return "h";
    },
    dispose: () => {
      steps.push("dispose");
    },
    ...over,
  };
}

let paths: string[];
beforeEach(() => {
  localStorage.clear();
  paths = [];
  cfg.worker = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      paths.push(path);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (path === "/api/backup/meta") return Response.json({ version: 0, sha256: null });
      if (path === "/api/backup/fetch-tmp") return Response.json({ iv: "00", ciphertext: "AA==" });
      if (path === "/api/backup/commit") return Response.json({ version: (body.baseVersion as number) + 1 });
      return new Response(null, { status: 204 });
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const commits = () => paths.filter((p) => p === "/api/backup/commit").length;

describe("one backup cycle", () => {
  it("runs on the worker engine and records the path", async () => {
    const w = engine();
    cfg.makeWorker = () => w;
    expect(await uploadBackupNow(keys)).toBe(true);
    expect(w.steps).toEqual(["prepare", "encrypt", "verify", "dispose"]);
    expect(commits()).toBe(1);
    expect(getBackupEngineNote()).toMatch(/^worker, \d+ ms/);
  });

  it("repeats the whole cycle on the main thread when the worker fails the dump", async () => {
    const w = engine({
      prepare: async () => {
        throw new BackupWorkerFailure("no indexeddb here");
      },
    });
    const inline = engine();
    cfg.makeWorker = () => w;
    cfg.makeInline = () => inline;
    expect(await uploadBackupNow(keys)).toBe(true);
    expect(w.steps).toContain("dispose");
    expect(inline.steps).toEqual(["prepare", "encrypt", "verify", "dispose"]);
    expect(commits()).toBe(1);
    expect(getBackupEngineNote()).toMatch(/^inline, .*worker given up .*no indexeddb here/);
  });

  it("a worker that dies after encrypt still gives exactly one commit, from the main thread", async () => {
    const w = engine({
      verify: async () => {
        throw new BackupWorkerFailure("terminated");
      },
    });
    const inline = engine();
    cfg.makeWorker = () => w;
    cfg.makeInline = () => inline;
    expect(await uploadBackupNow(keys)).toBe(true);
    expect(commits()).toBe(1);
    expect(paths.filter((p) => p === "/api/backup/upload-tmp").length).toBe(2);
  });

  it("an ordinary error from the worker is not repeated on the main thread", async () => {
    const w = engine({
      verify: async () => {
        throw new Error("OperationError");
      },
    });
    const inline = engine();
    cfg.makeWorker = () => w;
    cfg.makeInline = () => inline;
    expect(await uploadBackupNow(keys)).toBe(false);
    expect(inline.steps).toEqual([]);
    expect(commits()).toBe(0);
    expect(getLastBackupStatus().lastError).toContain("OperationError");
  });

  it("a verify hash that differs stops before the commit", async () => {
    cfg.makeWorker = () => engine({ verify: async () => "other" });
    expect(await uploadBackupNow(keys)).toBe(false);
    expect(commits()).toBe(0);
  });

  it("uses the main thread engine when workers do not exist", async () => {
    cfg.worker = false;
    const inline = engine();
    cfg.makeInline = () => inline;
    cfg.makeWorker = () => {
      throw new Error("must not be created");
    };
    expect(await uploadBackupNow(keys)).toBe(true);
    expect(getBackupEngineNote()).toMatch(/^inline, /);
  });
});

describe("a retired uploader", () => {
  it("cancel while the dump runs ends the engine and sends nothing", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = engine({
      prepare: async () => {
        await gate;
        return { kind: "ready", expectedHash: "h", fingerprint: "f" };
      },
    });
    cfg.makeWorker = () => w;
    const up = createBackupUploader(keys);
    up.trigger();
    await vi.advanceTimersByTimeAsync(30_000);
    up.cancel();
    expect(w.steps).toContain("dispose");
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(paths).toEqual([]);
    expect(w.steps).not.toContain("encrypt");
  });

  it("cancel during the read-back check never reaches the commit", async () => {
    vi.useFakeTimers();
    const up = createBackupUploader(keys);
    const w = engine({
      verify: async () => {
        up.cancel();
        return "h";
      },
    });
    cfg.makeWorker = () => w;
    up.trigger();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(paths).toContain("/api/backup/fetch-tmp");
    expect(commits()).toBe(0);
  });
});
