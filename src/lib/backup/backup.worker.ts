// Entry point of the backup worker: installs the network guard, then loads the real implementation with a
// dynamic import so the guard runs before any other module is evaluated (same pattern as chat.worker.ts).
import { installBackupNetworkGuards } from "./backupWorkerGuard";
import type { BackupWorkerRequest } from "./backupProtocol";

installBackupNetworkGuards();

const early: BackupWorkerRequest[] = [];
self.onmessage = (e: MessageEvent<BackupWorkerRequest>) => {
  early.push(e.data);
};

const failLoad = (req: BackupWorkerRequest, e: unknown) =>
  self.postMessage({ id: req.id, ok: false, error: `backup worker could not load: ${e instanceof Error ? e.message : String(e)}` });

// A load failure (a chunk gone after a new deploy, say) answers every request with an error instead of leaving the
// cycle to wait out its deadline while it holds the upload lock; the main thread then runs the cycle itself.
import("./backupWorkerImpl").then(
  ({ handleBackupRequest }) => {
    self.onmessage = (e: MessageEvent<BackupWorkerRequest>) => void handleBackupRequest(e.data);
    for (const req of early) void handleBackupRequest(req);
  },
  (e) => {
    self.onmessage = (ev: MessageEvent<BackupWorkerRequest>) => failLoad(ev.data, e);
    for (const req of early) failLoad(req, e);
  },
);
