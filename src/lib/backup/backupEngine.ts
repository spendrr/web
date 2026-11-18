// Who runs the heavy half of a backup cycle (backupCycle.ts): the backup worker or the main thread.
// backup.ts only talks to this interface, so the cycle's order, the version CAS and every network call are
// the same on both paths. A worker that cannot start, crashes or answers with an error is reported as
// BackupWorkerFailure; backup.ts then runs the whole cycle again on the main thread, which is the path
// every version before this one took.
import { encryptPrepared, hashReadBack, prepareDump, type PreparedDump } from "./backupCycle";
import type { EncryptedBackupBlob } from "./backupCrypto";
import type { BackupWorkerReply, BackupWorkerRequest, PrepareReply } from "./backupProtocol";

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

export type PrepareOutcome = { kind: "nothing" } | { kind: "noArk" } | { kind: "ready"; expectedHash: string; fingerprint: string };

export interface BackupEngine {
  prepare(key: CryptoKey): Promise<PrepareOutcome>;
  encrypt(): Promise<EncryptedBackupBlob>;
  verify(ivHex: string, cipherB64: string): Promise<string>;
  dispose(): void;
}

export class BackupWorkerFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupWorkerFailure";
  }
}

export class BackupCancelledError extends Error {
  constructor() {
    super("backup cancelled");
    this.name = "BackupCancelledError";
  }
}

// Lets the uploader that owns a cycle retire it: after cancel() no further step runs and a worker is gone,
// so a cycle that outlives its wallet can never finish under the old wallet's key.
export class BackupJob {
  cancelled = false;
  private engine: BackupEngine | null = null;
  attach(engine: BackupEngine): void {
    this.engine = engine;
  }
  cancel(): void {
    this.cancelled = true;
    this.engine?.dispose();
  }
  assertLive(): void {
    if (this.cancelled) throw new BackupCancelledError();
  }
}

export function createInlineEngine(): BackupEngine {
  let held: PreparedDump | null = null;
  let heldKey: CryptoKey | null = null;
  return {
    async prepare(key) {
      heldKey = key;
      const r = await prepareDump();
      if (r.kind !== "ready") return { kind: r.kind };
      held = r.prepared;
      return { kind: "ready", expectedHash: r.prepared.expectedHash, fingerprint: r.prepared.fingerprint };
    },
    async encrypt() {
      if (!held || !heldKey) throw new Error("backup engine has nothing prepared");
      return encryptPrepared(heldKey, held.plaintext);
    },
    async verify(ivHex, cipherB64) {
      if (!heldKey) throw new Error("backup engine has no key");
      return hashReadBack(heldKey, ivHex, cipherB64);
    },
    dispose() {
      held = null;
      heldKey = null;
    },
  };
}

// A worker that never answers (killed for memory, a stuck IndexedDB transaction) would hold the upload lock until
// the next reload. Each call gets a deadline; a miss ends the worker and the cycle repeats on the main thread.
export interface WorkerTimeouts {
  prepareMs: number;
  stepMs: number;
}
export const WORKER_TIMEOUTS: WorkerTimeouts = { prepareMs: 90_000, stepMs: 45_000 };

export function createWorkerEngine(timeouts: WorkerTimeouts = WORKER_TIMEOUTS): BackupEngine {
  let worker: Worker | null = null;
  let nextId = 1;
  let disposed = false;
  const pending = new Map<
    number,
    { type: BackupWorkerRequest["type"]; resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  const failAll = (message: string) => {
    const err = new BackupWorkerFailure(message);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const dispose = () => {
    disposed = true;
    worker?.terminate();
    worker = null;
    failAll("backup worker terminated or timed out");
  };

  const start = (): Worker => {
    const w = new Worker(new URL("./backup.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<BackupWorkerReply>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      // Only a failed dump can be specific to the worker (IndexedDB in a worker is not available everywhere), so only
      // that one is retried on the main thread. A failed encrypt or read-back check is about the data, not the
      // worker: it propagates as the error it is instead of repeating the whole cycle.
      else p.reject(p.type === "prepare" ? new BackupWorkerFailure(e.data.error) : new Error(e.data.error));
    };
    w.onerror = (e) => failAll(`backup worker error: ${e.message}`);
    w.onmessageerror = () => failAll("backup worker message error");
    return w;
  };

  const call = <T>(req: WithoutId<BackupWorkerRequest>): Promise<T> => {
    if (disposed) return Promise.reject(new BackupWorkerFailure("backup worker terminated"));
    try {
      worker ??= start();
    } catch (e) {
      return Promise.reject(new BackupWorkerFailure(`backup worker could not start: ${String(e)}`));
    }
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        dispose();
      }, req.type === "prepare" ? timeouts.prepareMs : timeouts.stepMs);
      const settle = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A) => {
        clearTimeout(timer);
        fn(...a);
      };
      pending.set(id, {
        type: req.type,
        resolve: settle(resolve as (v: unknown) => void),
        reject: settle(reject),
      });
      try {
        worker!.postMessage({ ...req, id } as BackupWorkerRequest);
      } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        reject(new BackupWorkerFailure(`backup worker postMessage failed: ${String(e)}`));
      }
    });
  };

  return {
    async prepare(key) {
      const r = await call<PrepareReply>({ type: "prepare", key });
      if (r.kind === "ready" && r.expectedHash && r.fingerprint) {
        return { kind: "ready", expectedHash: r.expectedHash, fingerprint: r.fingerprint };
      }
      if (r.kind === "nothing" || r.kind === "noArk") return { kind: r.kind };
      throw new BackupWorkerFailure("backup worker returned a malformed prepare reply");
    },
    encrypt: () => call<EncryptedBackupBlob>({ type: "encrypt" }),
    verify: (ivHex, cipherB64) => call<string>({ type: "verify", ivHex, cipherB64 }),
    dispose,
  };
}

// The worker is the normal path everywhere workers exist. Without one, or when it fails, the main thread runs the
// cycle (see BackupWorkerFailure above).
export function wantsBackupWorker(): boolean {
  return typeof Worker !== "undefined";
}
