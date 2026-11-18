// What the backup worker does with a message. Holds the plaintext bundle and the key between "prepare" and
// "encrypt"/"verify" of the same cycle; the main thread terminates the worker when the cycle ends.
import { encryptPrepared, hashReadBack, prepareDump, type PreparedDump } from "./backupCycle";
import type { BackupWorkerReply, BackupWorkerRequest, PrepareReply } from "./backupProtocol";

let heldKey: CryptoKey | null = null;
let held: PreparedDump | null = null;

async function run(req: BackupWorkerRequest): Promise<unknown> {
  if (req.type === "prepare") {
    heldKey = req.key;
    held = null;
    const r = await prepareDump();
    if (r.kind !== "ready") return { kind: r.kind } satisfies PrepareReply;
    held = r.prepared;
    return { kind: "ready", expectedHash: r.prepared.expectedHash, fingerprint: r.prepared.fingerprint } satisfies PrepareReply;
  }
  if (!heldKey) throw new Error("backup worker has no key");
  if (req.type === "encrypt") {
    if (!held) throw new Error("backup worker has nothing prepared");
    return encryptPrepared(heldKey, held.plaintext);
  }
  return hashReadBack(heldKey, req.ivHex, req.cipherB64);
}

export async function handleBackupRequest(req: BackupWorkerRequest): Promise<void> {
  let reply: BackupWorkerReply;
  try {
    reply = { id: req.id, ok: true, result: await run(req) };
  } catch (e) {
    reply = { id: req.id, ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
  self.postMessage(reply);
}
