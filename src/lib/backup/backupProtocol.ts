// Messages between backup.ts (main thread) and backup.worker.ts. One cycle uses one worker: "prepare"
// dumps and hashes, "encrypt" and "verify" reuse what prepare kept, then the main thread terminates it.
export type BackupWorkerRequest =
  | { id: number; type: "prepare"; key: CryptoKey }
  | { id: number; type: "encrypt" }
  | { id: number; type: "verify"; ivHex: string; cipherB64: string };

export type BackupWorkerReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export interface PrepareReply {
  kind: "nothing" | "noArk" | "ready";
  expectedHash?: string;
  fingerprint?: string;
}
