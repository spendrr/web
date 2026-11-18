// Entry point of the backup worker: installs the network guard, then loads the real implementation with a
// dynamic import so the guard runs before any other module is evaluated (same pattern as chat.worker.ts).
import { installBackupNetworkGuards } from "./backupWorkerGuard";
import type { BackupWorkerRequest } from "./backupProtocol";

installBackupNetworkGuards();

const early: BackupWorkerRequest[] = [];
self.onmessage = (e: MessageEvent<BackupWorkerRequest>) => {
  early.push(e.data);
};

void import("./backupWorkerImpl").then(({ handleBackupRequest }) => {
  self.onmessage = (e: MessageEvent<BackupWorkerRequest>) => void handleBackupRequest(e.data);
  for (const req of early) void handleBackupRequest(req);
});
