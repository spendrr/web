// The worker engine's protocol and failure handling, against a fake Worker. The real worker is covered by
// backupCycle.test.ts (same functions) and the build.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupCancelledError, BackupJob, BackupWorkerFailure, createWorkerEngine } from "../src/lib/backup/backupEngine";
import type { BackupWorkerReply, BackupWorkerRequest } from "../src/lib/backup/backupProtocol";

class FakeWorker {
  static last: FakeWorker | null = null;
  static throwOnConstruct = false;
  static silent = false;
  onmessage: ((e: MessageEvent<BackupWorkerReply>) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  sent: BackupWorkerRequest[] = [];
  reply: (req: BackupWorkerRequest) => BackupWorkerReply | null = (r) => ({ id: r.id, ok: true, result: { kind: "nothing" } });
  constructor() {
    if (FakeWorker.throwOnConstruct) throw new Error("no workers");
    if (FakeWorker.silent) this.reply = () => null;
    FakeWorker.last = this;
  }
  postMessage(req: BackupWorkerRequest) {
    this.sent.push(req);
    const r = this.reply(req);
    if (r) queueMicrotask(() => this.onmessage?.({ data: r } as MessageEvent<BackupWorkerReply>));
  }
  terminate() {
    this.terminated = true;
  }
}

beforeEach(() => {
  FakeWorker.last = null;
  FakeWorker.throwOnConstruct = false;
  FakeWorker.silent = false;
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => vi.unstubAllGlobals());

const KEY = {} as CryptoKey;

describe("worker engine", () => {
  it("sends the key with prepare and maps the reply", async () => {
    const e = createWorkerEngine();
    const pending = e.prepare(KEY);
    const w = FakeWorker.last!;
    w.reply = () => null;
    w.onmessage?.({ data: { id: 1, ok: true, result: { kind: "ready", expectedHash: "h", fingerprint: "f" } } } as MessageEvent<BackupWorkerReply>);
    expect(await pending).toEqual({ kind: "ready", expectedHash: "h", fingerprint: "f" });
    expect(w.sent[0]).toMatchObject({ type: "prepare", key: KEY });
  });

  it("an error reply, a worker error and a failed start are all BackupWorkerFailure", async () => {
    const e = createWorkerEngine();
    const p = e.prepare(KEY);
    FakeWorker.last!.reply = () => null;
    FakeWorker.last!.onmessage?.({ data: { id: 1, ok: false, error: "boom" } } as MessageEvent<BackupWorkerReply>);
    await expect(p).rejects.toBeInstanceOf(BackupWorkerFailure);

    const e2 = createWorkerEngine();
    FakeWorker.throwOnConstruct = false;
    const p2 = e2.encrypt();
    FakeWorker.last!.onerror?.({ message: "crash" });
    await expect(p2).rejects.toBeInstanceOf(BackupWorkerFailure);

    FakeWorker.throwOnConstruct = true;
    await expect(createWorkerEngine().prepare(KEY)).rejects.toBeInstanceOf(BackupWorkerFailure);
  });

  it("dispose terminates the worker and fails a call still waiting", async () => {
    const e = createWorkerEngine();
    const p = e.prepare(KEY);
    const w = FakeWorker.last!;
    w.reply = () => null;
    e.dispose();
    expect(w.terminated).toBe(true);
    await expect(p).rejects.toBeInstanceOf(BackupWorkerFailure);
    await expect(e.encrypt()).rejects.toBeInstanceOf(BackupWorkerFailure);
  });
});

describe("worker engine deadlines and error kinds", () => {
  it("a worker that never answers is ended and reported as a failure", async () => {
    vi.useFakeTimers();
    try {
      FakeWorker.silent = true;
      const e = createWorkerEngine({ prepareMs: 1000, stepMs: 500 });
      const p = e.prepare(KEY);
      const w = FakeWorker.last!;
      const assertion = expect(p).rejects.toBeInstanceOf(BackupWorkerFailure);
      await vi.advanceTimersByTimeAsync(1001);
      await assertion;
      expect(w.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an error reply to encrypt or verify is an ordinary error, not a reason to repeat the cycle", async () => {
    const e = createWorkerEngine();
    const p = e.encrypt();
    FakeWorker.last!.reply = () => null;
    FakeWorker.last!.onmessage?.({ data: { id: 1, ok: false, error: "OperationError" } } as MessageEvent<BackupWorkerReply>);
    const err = await p.catch((x: unknown) => x);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BackupWorkerFailure);
  });
});

describe("BackupJob", () => {
  it("cancel ends the attached engine and stops the cycle at the next check", () => {
    const job = new BackupJob();
    const dispose = vi.fn();
    job.attach({ prepare: vi.fn(), encrypt: vi.fn(), verify: vi.fn(), dispose });
    job.assertLive();
    job.cancel();
    expect(dispose).toHaveBeenCalled();
    expect(() => job.assertLive()).toThrow(BackupCancelledError);
  });
});
