// Orchestrates the encrypted cloud backup feature (see ARCHITECTURE.md's backup
// section): dumps both local IndexedDB databases, encrypts them with a key
// derived from the mnemonic (backupCrypto.ts), and uploads to this app's own
// Worker so a partial/corrupt upload can never clobber the last good backup:
// beta (V2) in one versioned put, verified locally first and checksummed by R2;
// V1 via tmp-key -> read-back verify -> commit. Restore is the inverse,
// used only on the import/recovery path (App.tsx).
//
// Modeled on notifications.ts's postSubscription()/refreshPushAuthorization()
// pattern: every network call here is best-effort and never throws to a
// caller that isn't explicitly awaiting a result (uploads are fire-and-forget
// by design; restore is the one path that does propagate failure, since the
// caller needs to know whether it got real data back).
import { decryptBackupBlob, type BackupKeys } from "./backupCrypto";
import { getDesignVersion } from "../ui/designVersion";
import { decompressBackup } from "./backupCompress";
import { ARK_DB_NAME, ONCHAIN_DB_NAME, hasAnyLocalWalletData, restoreDatabase } from "./backupStore";
import { VOUCHERS_DB_NAME, dumpAllDatabases, stringifyDump, type BundledDump } from "./backupCycle";
import {
  BackupJob,
  BackupWorkerFailure,
  createInlineEngine,
  createWorkerEngine,
  wantsBackupWorker,
  type BackupEngine,
} from "./backupEngine";
import { GIFTS_DB_NAME } from "../gift/giftStore";
import { maintenanceWithDeadline } from "../wallet/bark";
import { isMaintenanceSuppressed } from "../maintenance/maintenanceSuppress";

// Bitrefill orders. The feature itself is archived (archive/bitrefill/), but
// its database stays in the backup: a device that bought something still has
// the records, and a later release that brings the feature back must find
// them in the backup too, not lose them to the first upload without it.

export { hasAnyLocalWalletData };

const LAST_SUCCESS_KEY = "btc-wallet-backup-last-success-at";
const LAST_ATTEMPT_KEY = "btc-wallet-backup-last-attempt-at";
// Persisted so a failure is diagnosable from the device it happened on —
// this feature runs silently with no console visible to most users, and a
// real production failure (bigint values breaking JSON.stringify) was only
// findable at all because the user could read this back and report it.
const LAST_ERROR_KEY = "btc-wallet-backup-last-error";

// Set when a restore was attempted and failed, and cleared only when a
// later restore succeeds — App.tsx reads it back on every open
// (isRestoreFailureLatched) and keeps every upload switched off while it is
// present, not just for the session that hit the failure (see its
// restoreFailed comment). Deliberately NOT reported through LAST_ERROR_KEY
// above: that one only ever reaches the user via the widget's "backups have
// been failing for a while" banner, which needs lastAttemptAt set AND the
// last success to be 2+ days old — and skipping every upload means neither
// condition is ever reached, so the one state where the user is running with
// backups silently switched off would be the one state nothing shows. Its
// own key, surfaced unconditionally.
const RESTORE_FAILED_KEY = "btc-wallet-backup-restore-failed";

// Set alongside RESTORE_FAILED_KEY when the latch came from an upload's
// version conflict rather than a failed restore. Lets the next open check
// whether that conflict was only this device racing itself (see
// clearSelfInflictedConflictLatch); a real restore failure removes it, so it
// can never be used to lift that kind of latch.
const CONFLICT_LATCH_KEY = "btc-wallet-backup-conflict-latched";

export function getLastBackupStatus(): {
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  restoreError: string | null;
} {
  const lastSuccessAt = Number(localStorage.getItem(LAST_SUCCESS_KEY)) || null;
  const lastAttemptAt = Number(localStorage.getItem(LAST_ATTEMPT_KEY)) || null;
  const lastError = localStorage.getItem(LAST_ERROR_KEY);
  const restoreError = localStorage.getItem(RESTORE_FAILED_KEY);
  return { lastSuccessAt, lastAttemptAt, lastError, restoreError };
}

export function recordRestoreFailure(e: unknown): void {
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  console.error("[backup] restore failed — uploads disabled until a restore succeeds", e);
  try {
    localStorage.setItem(RESTORE_FAILED_KEY, message.slice(0, 300));
    localStorage.removeItem(CONFLICT_LATCH_KEY);
  } catch {
    // Best-effort — localStorage full/unavailable shouldn't compound the
    // original failure.
  }
}

// Cleared only when a restore actually succeeds (App.tsx) — NOT on every
// clean-looking open. Once set, it keeps uploads switched off across
// reloads: the open right after a failed restore leaves the local DB
// holding only what the SDK's lossy key-gap-limited scan recovered, and the
// next unlock would otherwise treat that subset as authoritative and commit
// it over the last good server blob (one blob per wallet — irreversible).
export function clearRestoreFailure(): void {
  localStorage.removeItem(RESTORE_FAILED_KEY);
  localStorage.removeItem(CONFLICT_LATCH_KEY);
}

// True when a previous session's restore attempt failed and nothing has
// restored successfully since. Read on every open so the upload gate
// (App.tsx) survives a reload, not just the session that hit the failure.
export function isRestoreFailureLatched(): boolean {
  try {
    return localStorage.getItem(RESTORE_FAILED_KEY) !== null;
  } catch {
    return false;
  }
}

function recordAttempt(): void {
  localStorage.setItem(LAST_ATTEMPT_KEY, String(Date.now()));
}

function recordSuccess(): void {
  const now = String(Date.now());
  localStorage.setItem(LAST_SUCCESS_KEY, now);
  localStorage.setItem(LAST_ATTEMPT_KEY, now);
  localStorage.removeItem(LAST_ERROR_KEY);
}

function recordFailure(e: unknown): void {
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  console.error("[backup] upload failed", e);
  try {
    localStorage.setItem(LAST_ERROR_KEY, message.slice(0, 300));
  } catch {
    // Best-effort — localStorage full/unavailable shouldn't compound the
    // original failure.
  }
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Every backup request carries the write token (see backupCrypto.ts): the
// server refuses writes, and reads of a backup that has one recorded, without
// it. Without the token, anyone who learned a lookupKey could commit garbage
// over the backup (the version check doesn't stop them, /meta tells them the
// version) or replay an old blob they had downloaded.
function authBody(keys: BackupKeys): { lookupKey: string; writeToken: string } {
  return { lookupKey: keys.lookupKey, writeToken: keys.writeToken };
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}

// Scoped per lookupKey (not one global key) so switching between wallets on
// the same device/browser tracks each one's own last-uploaded state
// independently, rather than one wallet's hash wrongly suppressing another's
// upload.
function lastUploadedHashKey(lookupKey: string): string {
  return `btc-wallet-backup-last-hash:${lookupKey}`;
}

// The last committed state as backupFingerprint.ts sees it (block checkpoints
// left out), with the time of that commit. Lets an open after a new block skip
// the upload; written only after a verified commit, together with the hash.
function lastUploadedFingerprintKey(lookupKey: string): string {
  return `btc-wallet-backup-last-fingerprint:${lookupKey}`;
}

// A skip on the fingerprint alone lets the stored checkpoints age, so past this
// an upload goes out anyway. Well inside the time a restore would still sync
// from them without trouble.
const FINGERPRINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function fingerprintUnchanged(lookupKey: string, fingerprint: string): boolean {
  try {
    const raw = localStorage.getItem(lastUploadedFingerprintKey(lookupKey));
    if (raw === null) return false;
    const last = JSON.parse(raw) as { fp?: unknown; at?: unknown };
    if (last.fp !== fingerprint || typeof last.at !== "number") return false;
    const age = Date.now() - last.at;
    return age >= 0 && age < FINGERPRINT_MAX_AGE_MS;
  } catch {
    return false;
  }
}

// This device's last-known server backup version for this wallet — the
// client half of the optimistic-concurrency check in
// worker/index.ts's handleBackupCommit (see backupVersion.ts). 0 means
// "never synced against a real backup": a brand-new wallet, or a device
// that has never recorded one (including every device that existed before
// this check was added). Kept in localStorage, not memory, so it survives
// a reload — a fresh session must not forget what this device last
// verified was current and silently treat 0 as "known-safe to overwrite".
function knownVersionKey(lookupKey: string): string {
  return `btc-wallet-backup-known-version:${lookupKey}`;
}

function getKnownVersion(lookupKey: string): number {
  const raw = localStorage.getItem(knownVersionKey(lookupKey));
  const n = raw === null ? 0 : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function setKnownVersion(lookupKey: string, version: number): void {
  try {
    localStorage.setItem(knownVersionKey(lookupKey), String(version));
  } catch {
    // Best-effort — worst case the next upload cycle's meta check sees a
    // stale/absent local version and is (correctly, if overly cautiously)
    // treated as a conflict, the same safe direction a real one would be.
  }
}

// Written right before a commit and removed once its reply is handled. If the
// reply never arrives (network drop, tab killed) while the server did commit,
// the server ends up one version ahead of what this device knows, which reads
// exactly like another device writing, and latched uploads off with no way
// out. The likely cause of a latch seen 2026-09-21 (server 86, device 85),
// not confirmed: a genuine second device would look the same.
function pendingCommitKey(lookupKey: string): string {
  return `btc-wallet-backup-pending-commit:${lookupKey}`;
}

// The server's version is our own lost commit when it is exactly one past the
// base we committed on and holds exactly the bytes we committed. A version
// from anywhere else never matches: another device's commit carries a
// different sha256 (its own local state), or a later version number.
interface PendingCommit {
  base: number;
  sha256: string;
}

// The marker is a list, newest first. An attempt is recorded before it is sent,
// so a still-unresolved earlier attempt would otherwise be overwritten by the
// next one, and a reply lost to a closed tab could no longer be recognised. An
// older marker written as one bare object is read as a list of one.
function readPendingCommits(lookupKey: string): PendingCommit[] {
  try {
    const raw = localStorage.getItem(pendingCommitKey(lookupKey));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    const list: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter(
      (p): p is PendingCommit =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as PendingCommit).base === "number" &&
        typeof (p as PendingCommit).sha256 === "string",
    );
  } catch {
    return [];
  }
}

// Every attempt on the current base stays until one is resolved: any of them may be the one that committed (a reply
// lost, then later attempts that never reached the server). Markers on an older base can no longer match (the server
// is past base + 1 of theirs), so they go. The cap only bounds storage after many failures in a row.
const MAX_PENDING_COMMITS = 16;

function rememberPendingCommit(lookupKey: string, base: number, sha256: string): void {
  try {
    const rest = readPendingCommits(lookupKey).filter((p) => p.base >= base && !(p.base === base && p.sha256 === sha256));
    localStorage.setItem(pendingCommitKey(lookupKey), JSON.stringify([{ base, sha256 }, ...rest].slice(0, MAX_PENDING_COMMITS)));
  } catch {
    // Best-effort: without it a lost reply latches, as before.
  }
}

function adoptOwnLostCommit(lookupKey: string, serverVersion: number, serverSha256: unknown): boolean {
  try {
    const match = readPendingCommits(lookupKey).find((p) => serverVersion === p.base + 1 && serverSha256 === p.sha256);
    if (!match) return false;
    setKnownVersion(lookupKey, serverVersion);
    localStorage.setItem(lastUploadedHashKey(lookupKey), match.sha256);
    localStorage.removeItem(pendingCommitKey(lookupKey));
    return true;
  } catch {
    return false;
  }
}

// Thrown by performUpload when the server's actual current version doesn't
// match what this device believed was current — see performUpload's own
// comment for the exact scenario this catches (a stale device silently
// overwriting a newer backup from elsewhere). Callers must not treat this
// like an ordinary transient failure: it means local wallet state on this
// device is not known to be the most recent, so every future upload must
// stay switched off until a real restore succeeds — the same conservative
// rule already applied to a failed restore itself (recordRestoreFailure).
export class BackupVersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupVersionConflictError";
  }
}

// Shared by createBackupUploader's runNow and uploadBackupNow below — a
// version conflict is not an ordinary upload failure (recordFailure, which
// only surfaces after 2+ days of a wallet's backups failing): it means this
// device's local state might not be the most recent, and silently retrying
// the same stale content would just keep hitting the same conflict, doing
// nothing, while telling nobody. Routing it through recordRestoreFailure
// instead reuses the exact same protection a failed restore already gets —
// see its own comment: every future upload on this device stays switched
// off until a real restore succeeds, and Settings shows it unconditionally
// (restoreError), not gated behind the staleness window generic failures
// are.
function handleUploadFailure(e: unknown): void {
  if (e instanceof BackupVersionConflictError) {
    recordRestoreFailure(e);
    try {
      localStorage.setItem(CONFLICT_LATCH_KEY, "1");
    } catch {
      // Best-effort: without the marker the latch just stays the stricter
      // restore-failure kind.
    }
  } else {
    recordFailure(e);
  }
}

// Called on open while a latch is set. Lifts it only when it came from a
// version conflict (not a failed restore) AND the server's current version is
// exactly the one this device last committed or restored. The version counter
// is a single monotonic sequence, so equality means no other device has
// committed since; the conflict was two uploads from this same device
// overlapping (fixed by runUploadExclusive, but latches set before that fix
// need a way out). Any mismatch or error keeps the latch.
// Latches set before the marker existed are recognised by their message,
// which only handleUploadFailure's conflict path can produce (restore
// failures never throw BackupVersionConflictError).
function isConflictLatch(): boolean {
  if (localStorage.getItem(CONFLICT_LATCH_KEY) !== null) return true;
  return localStorage.getItem(RESTORE_FAILED_KEY)?.startsWith("BackupVersionConflictError:") ?? false;
}

// Runs on the unlock path before the dashboard shows, so it must never hang.
const CONFLICT_CHECK_TIMEOUT_MS = 5000;

export async function clearSelfInflictedConflictLatch(keys: BackupKeys): Promise<boolean> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CONFLICT_CHECK_TIMEOUT_MS);
  try {
    if (!isConflictLatch()) return false;
    const res = await fetch("/api/backup/meta", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(authBody(keys)),
      signal: abort.signal,
    });
    if (!res.ok) return false;
    const { version, sha256 } = (await res.json()) as { version: number; sha256?: string | null };
    if (version === 0) return false;
    if (version !== getKnownVersion(keys.lookupKey) && !adoptOwnLostCommit(keys.lookupKey, version, sha256)) {
      return false;
    }
    clearRestoreFailure();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// One upload at a time, across this tab and every other tab of the app.
// The one-shot post-open upload and the debounced uploader are independent,
// and the settle wait before the one-shot can last minutes, so they used to
// overlap: both read the same server version in the meta check, one
// committed, and the other's commit got a 409 that latched uploads off as if
// another device had written. Serialized, the second upload's meta check runs
// after the first one's commit and setKnownVersion, so it sees a match (or
// skips entirely on the unchanged-hash check).
let localUploadChain: Promise<unknown> = Promise.resolve();

function runUploadExclusive(keys: BackupKeys, job: BackupJob = new BackupJob()): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request("btc-wallet-backup-upload", () => performUpload(keys, job));
  }
  const run = localUploadChain.then(() => performUpload(keys, job));
  localUploadChain = run.catch(() => {});
  return run;
}

// One cycle. The heavy half (dump, serialize, hash, compress, encrypt, hash of the read-back copy) runs in the
// backup worker, and on the main thread where workers do not exist (backupEngine.ts). A worker that fails at any step
// repeats the whole cycle on the main thread: nothing before the commit has side effects that matter.
async function performUpload(keys: BackupKeys, job: BackupJob): Promise<void> {
  job.assertLive();
  let fallbackReason: string | undefined;
  if (wantsBackupWorker()) {
    const started = Date.now();
    try {
      await runCycle(keys, job, createWorkerEngine());
      recordEngineUse("worker", Date.now() - started);
      return;
    } catch (e) {
      if (!(e instanceof BackupWorkerFailure) || job.cancelled) throw e;
      fallbackReason = e.message;
      console.warn("[backup] worker failed, running the cycle on the main thread", e);
    }
  }
  const started = Date.now();
  await runCycle(keys, job, createInlineEngine());
  recordEngineUse("inline", Date.now() - started, fallbackReason);
}

// Which path the last finished cycle took and how long it ran, and the last time the worker had to be given up on.
// Kept so a worker that silently never works (the cycle still succeeds on the main thread) shows up in the exported
// call log instead of only as a UI freeze. Best-effort, never throws.
const ENGINE_NOTE_KEY = "btc-wallet-backup-engine";

function recordEngineUse(path: "worker" | "inline", ms: number, fallbackReason?: string): void {
  try {
    const prev = JSON.parse(localStorage.getItem(ENGINE_NOTE_KEY) ?? "null") as { fallback?: unknown } | null;
    const fallback = fallbackReason !== undefined ? { at: Date.now(), reason: fallbackReason.slice(0, 120) } : prev?.fallback;
    localStorage.setItem(ENGINE_NOTE_KEY, JSON.stringify({ path, ms, at: Date.now(), fallback }));
  } catch {
    // Diagnostics only.
  }
}

export function getBackupEngineNote(): string | null {
  try {
    const raw = localStorage.getItem(ENGINE_NOTE_KEY);
    if (!raw) return null;
    const n = JSON.parse(raw) as { path: string; ms: number; at: number; fallback?: { at: number; reason: string } };
    const iso = (t: number) => new Date(t).toISOString();
    const last = `${n.path}, ${n.ms} ms, ${iso(n.at)}`;
    return n.fallback ? `${last}; worker given up ${iso(n.fallback.at)}: ${n.fallback.reason}` : last;
  } catch {
    return null;
  }
}

async function runCycle(keys: BackupKeys, job: BackupJob, engine: BackupEngine): Promise<void> {
  job.attach(engine);
  try {
    await cycleSteps(keys, job, engine);
  } finally {
    engine.dispose();
  }
}

async function cycleSteps(keys: BackupKeys, job: BackupJob, engine: BackupEngine): Promise<void> {
  const prepared = await engine.prepare(keys.encryptionKey);
  job.assertLive();
  if (prepared.kind === "nothing") return;
  // See prepareDump: an Ark database that dumped empty is refused, never committed.
  if (prepared.kind === "noArk") throw new Error("refusing to upload: Ark database dumped empty");
  const { expectedHash, fingerprint } = prepared;

  // Skip the network round-trip entirely when the last successfully
  // committed backup for this wallet already matches byte-for-byte. Most
  // triggers (every open/unlock via uploadBackupNow, the debounced trigger
  // on any balance/history change) fire far more often than the wallet's
  // actual state changes, so this is the difference between backing up on
  // every app open and backing up only when there's something new — each
  // skipped cycle saves a Worker request and an R2 write.
  const hashKey = lastUploadedHashKey(keys.lookupKey);
  if (localStorage.getItem(hashKey) === expectedHash) return;

  // Same skip, but blind to the block checkpoints that move with every block (backupFingerprint.ts). Equal to
  // expectedHash when the dump has none, in which case the check above already decided.
  if (fingerprintUnchanged(keys.lookupKey, fingerprint)) return;

  // Beta (V2) uploads in one request (uploadByPut); V1 keeps the four-request flow until put has run on real R2
  // with real wallets. Both write the same object with the same version CAS, so devices on either path share one
  // backup safely. Read once per cycle; cycles never overlap.
  const committedVersion =
    getDesignVersion() === "v2"
      ? await uploadByPut(keys, job, engine, expectedHash)
      : await uploadByTmpCommit(keys, job, engine, expectedHash);
  if (committedVersion === null) return; // A lost commit of ours already holds this state.
  setKnownVersion(keys.lookupKey, committedVersion);
  // Removed only here: a failed reply (5xx) may still have committed. A marker
  // left behind is harmless, it only ever matches a version holding exactly
  // these bytes, and the next commit overwrites it.
  localStorage.removeItem(pendingCommitKey(keys.lookupKey));

  // Only recorded after a verified, committed upload — never speculatively —
  // so a failed cycle never wrongly marks this state as "already backed up"
  // and silently suppresses the retry a real failure needs.
  try {
    localStorage.setItem(hashKey, expectedHash);
    localStorage.setItem(lastUploadedFingerprintKey(keys.lookupKey), JSON.stringify({ fp: fingerprint, at: Date.now() }));
  } catch {
    // Best-effort — worst case the next cycle just re-uploads unnecessarily,
    // exactly like today's behavior.
  }
}

// One request does what meta + upload-tmp + fetch-tmp + commit do. Returns the committed version, or null when a lost
// commit of ours already holds exactly this state.
async function uploadByPut(keys: BackupKeys, job: BackupJob, engine: BackupEngine, expectedHash: string): Promise<number | null> {
  // Compressed before encryption (backupCompress.ts); the hash above and the
  // verify below stay on the uncompressed JSON.
  const { ivHex, cipherB64, cipherSha256 } = await engine.encrypt();
  job.assertLive();

  // The proof the upload-tmp / fetch-tmp round trip gives, that the blob
  // decrypts and hashes to the expected plaintext, is done here (in the backup
  // worker when it runs) before anything is sent. Corruption in transit or in
  // storage is the server's job: the put carries the ciphertext's own sha256,
  // which R2 checks on write (handleBackupPut). Never send a blob that does not
  // verify.
  const actualHash = await engine.verify(ivHex, cipherB64);
  job.assertLive();
  if (actualHash !== expectedHash) {
    throw new Error("backup verify failed: hash mismatch after local round-trip");
  }

  // The version check is the server's etag compare-and-swap (see
  // backupVersion.ts for why a stale device must never overwrite a newer
  // backup). baseVersion is what this device last knew; 0 is accepted only when
  // the server has no versioned backup yet. A 409 carries the server's current
  // version and plaintext hash, which is how a device whose previous reply was
  // lost recognises its own commit (adoptOwnLostCommit) instead of latching as a
  // conflict.
  let baseVersion = getKnownVersion(keys.lookupKey);
  for (let attempt = 0; ; attempt++) {
    // Written before sending, kept until the reply is read: a reply lost to a
    // dropped connection or a closed tab may still have committed.
    job.assertLive();
    rememberPendingCommit(keys.lookupKey, baseVersion, expectedHash);
    const putRes = await postJson("/api/backup/put", {
      ...authBody(keys),
      iv: ivHex,
      ciphertext: cipherB64,
      sha256: expectedHash,
      cipherSha256,
      baseVersion,
    });
    if (putRes.status === 409) {
      const conflict = (await putRes.json().catch(() => null)) as { version?: unknown; sha256?: unknown } | null;
      const serverVersion = typeof conflict?.version === "number" ? conflict.version : 0;
      // Only once: a second 409 right after adopting means someone else is writing.
      if (attempt === 0 && serverVersion !== 0 && adoptOwnLostCommit(keys.lookupKey, serverVersion, conflict?.sha256)) {
        if (conflict?.sha256 === expectedHash) return null;
        baseVersion = serverVersion;
        continue;
      }
      throw new BackupVersionConflictError(
        `refusing to upload: server backup is at version ${serverVersion}, this device last knew ${baseVersion}`,
      );
    }
    if (!putRes.ok) throw new Error(`put failed: ${putRes.status} ${await readErrorBody(putRes)}`);
    return ((await putRes.json()) as { version: number }).version;
  }
}

// The four-request flow (V1): meta, upload-tmp, fetch-tmp, commit. Returns the committed version, or null when a lost
// commit of ours already holds exactly this state.
async function uploadByTmpCommit(keys: BackupKeys, job: BackupJob, engine: BackupEngine, expectedHash: string): Promise<number | null> {
  // Optimistic-concurrency guard against a stale device silently overwriting a
  // newer backup from elsewhere (see backupVersion.ts). Learn the server's
  // actual current version right now, not whatever this device last saw, and
  // refuse to proceed if it does not match what this device believes is
  // current. serverVersion === 0 ("no backup yet") always passes, see
  // resolveCommitVersion for why that one-time exception is safe.
  const metaRes = await postJson("/api/backup/meta", authBody(keys));
  if (!metaRes.ok) throw new Error(`meta check failed: ${metaRes.status} ${await readErrorBody(metaRes)}`);
  const { version: serverVersion, sha256: serverSha256 } = (await metaRes.json()) as {
    version: number;
    sha256?: string | null;
  };
  let baseVersion = getKnownVersion(keys.lookupKey);
  if (
    serverVersion !== 0 &&
    baseVersion !== serverVersion &&
    adoptOwnLostCommit(keys.lookupKey, serverVersion, serverSha256)
  ) {
    baseVersion = serverVersion;
    if (serverSha256 === expectedHash) return null;
  }
  if (serverVersion !== 0 && baseVersion !== serverVersion) {
    throw new BackupVersionConflictError(
      `refusing to upload: server backup is at version ${serverVersion}, this device last knew ${baseVersion}`,
    );
  }

  // Compressed before encryption (backupCompress.ts); the hash above and the
  // verify below stay on the uncompressed JSON.
  const { ivHex, cipherB64 } = await engine.encrypt();
  job.assertLive();

  const uploadRes = await postJson("/api/backup/upload-tmp", {
    ...authBody(keys),
    iv: ivHex,
    ciphertext: cipherB64,
    sha256: expectedHash,
  });
  if (!uploadRes.ok) throw new Error(`upload-tmp failed: ${uploadRes.status} ${await readErrorBody(uploadRes)}`);

  // Read back exactly what the server stored and decrypt+hash it before ever
  // promoting it: a transit or storage corruption is caught here, before
  // commit, so it can never clobber the last good backup. Never call commit
  // speculatively.
  const readBackRes = await postJson("/api/backup/fetch-tmp", authBody(keys));
  if (!readBackRes.ok) {
    throw new Error(`fetch-tmp verify failed: ${readBackRes.status} ${await readErrorBody(readBackRes)}`);
  }
  const { iv: readBackIv, ciphertext: readBackCipher } = (await readBackRes.json()) as {
    iv: string;
    ciphertext: string;
  };
  const actualHash = await engine.verify(readBackIv, readBackCipher);
  job.assertLive();
  if (actualHash !== expectedHash) {
    throw new Error("backup verify failed: hash mismatch after round-trip");
  }

  // sha256 lets the server refuse to promote a tmp object it never verified
  // (handleBackupCommit); baseVersion is the independent check that the
  // promoted content is newer than what is already there (resolveCommitVersion).
  // The marker is written in the same list format put uses, so a lost reply is
  // recognised whichever path the next cycle takes.
  job.assertLive();
  rememberPendingCommit(keys.lookupKey, serverVersion, expectedHash);
  const commitRes = await postJson("/api/backup/commit", {
    ...authBody(keys),
    sha256: expectedHash,
    baseVersion: serverVersion,
  });
  if (commitRes.status === 409) {
    // Someone else committed between the meta check above and this call.
    throw new BackupVersionConflictError("commit rejected: server backup changed since the meta check");
  }
  if (!commitRes.ok) throw new Error(`commit failed: ${commitRes.status} ${await readErrorBody(commitRes)}`);
  return ((await commitRes.json()) as { version: number }).version;
}

// Takes already-derived keys, never the mnemonic itself. Nothing on the
// main thread can derive them any more: the wallet worker does it during
// prepareSession (walletSession.ts) — the one realm the plaintext seed ever
// exists in — and hands back only the result, a public lookupKey plus a
// non-extractable CryptoKey. That's the same isolation principle the worker
// boundary exists for elsewhere in this app (see ARCHITECTURE.md's
// network-hardening and backup sections).
// Returns { trigger, cancel } rather than a bare function — see cancel's own
// comment for why a cancel path exists at all. Every caller must call
// cancel() at the same point it used to just drop the reference (retiring
// this uploader for a lock, a reset, or handing off to a freshly derived
// uploader for a different wallet).
export function createBackupUploader(keys: BackupKeys): { trigger: () => void; cancel: () => void } {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let pendingWhileInFlight = false;
  // Set once this uploader is retired. Without it, an already-armed 30s
  // debounce timer outlives the ref that used to be the only handle on it —
  // dropping the ref (backupTriggerRef.current = null) never stopped the
  // timer underneath. If a different mnemonic gets opened inside that
  // window (lock → import/unlock another wallet before the timer fires),
  // the stale closure still holds the FIRST wallet's `keys`: it dumps
  // whatever is in btc-wallet-mainnet *now* — the second wallet's local
  // state — and commits it under the first wallet's lookupKey. One blob per
  // wallet, so that permanently destroys the first wallet's only backup.
  // Checked at every point control could resume after an await or a timer:
  // before arming, when the timer fires, and after an in-flight upload
  // resolves (rather than requeuing into a runNow() this uploader has no
  // business making any more).
  let cancelled = false;
  // The cycle in flight, so cancel() can end its worker (see BackupJob).
  let job: BackupJob | null = null;

  const runNow = () => {
    if (cancelled) return;
    inFlight = true;
    recordAttempt();
    const thisJob = new BackupJob();
    job = thisJob;
    runUploadExclusive(keys, thisJob)
      .then(() => {
        if (!cancelled) recordSuccess();
      })
      .catch((e: unknown) => {
        if (!cancelled) handleUploadFailure(e);
      })
      .finally(() => {
        inFlight = false;
        if (!cancelled && pendingWhileInFlight) {
          pendingWhileInFlight = false;
          runNow();
        }
      });
  };

  return {
    trigger: () => {
      if (cancelled) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (cancelled) return;
        if (inFlight) {
          pendingWhileInFlight = true;
          return;
        }
        runNow();
      }, 30_000);
    },
    cancel: () => {
      cancelled = true;
      pendingWhileInFlight = false;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      // An upload already in flight: a network call already dispatched can't be
      // aborted from here, but the job ends its worker and stops before the next
      // step, so a cycle never finishes under a retired uploader's keys.
      // cancelled stops it from recording an outcome or requeuing.
      job?.cancel();
    },
  };
}

// Fire-and-forget one-shot upload, used right after a successful open/unlock
// — separate from the debounced trigger above since this should run once
// immediately, not wait out a debounce window. Same keys-not-mnemonic
// contract as createBackupUploader.
// Resolves true when the upload (or the decision to skip an unchanged state)
// went through, false when it failed (recorded the same way as before). The
// caller can then arm the cancellable uploader for one more try.
export function uploadBackupNow(keys: BackupKeys): Promise<boolean> {
  recordAttempt();
  return runUploadExclusive(keys)
    .then(() => {
      recordSuccess();
      return true;
    })
    .catch((e: unknown) => {
      handleUploadFailure(e);
      return false;
    });
}

interface SettleCheckable {
  vtxos(): Promise<{ id: string }[]>;
}

const SETTLE_POLL_MS = 3000;
// Widened from an initial 10s (2026-09-13T~10:00) to 3 minutes the same day,
// after live testing showed Arkoor mailbox delivery on this server routinely
// takes tens of seconds to several minutes, not the ~10-30s assumed when this
// was first written — the 10s window caught only whichever VTXOs had already
// landed in that first brief moment, then confidently declared "settled" and
// backed up an incomplete snapshot anyway (same failure mode this function
// exists to prevent, just with a shorter fuse). This still isn't a hard
// guarantee for a payment that takes longer than 3 minutes to arrive — the
// debounced trigger in createBackupUploader is what catches that, *if* the
// app stays open long enough to notice the later balance change. There is no
// bound here that's provably long enough; 3 minutes is a practical trade-off
// against delaying every wallet's first backup indefinitely.
const SETTLE_MAX_WAIT_MS = 3 * 60_000;

// Waits for the wallet's locally-known VTXO set to stop changing across two
// consecutive checks before the caller proceeds — meant to sit in front of
// the very first uploadBackupNow() after an open.
//
// Real incident (2026-09-13): a brand-new wallet received two Arkoor
// payments back to back. Wallet.open's own doc comment says its recovery
// scan "runs on the open that creates the wallet locally", and its resolving
// only means the scan ran — a RecoveryReport's `isComplete` can still be
// `false`, i.e. the promise resolving doesn't guarantee every VTXO the scan
// found is durably written yet. App.tsx used to call uploadBackupNow() on
// the very next tick after open, with no settling — it caught only the
// first of the two VTXOs and uploaded that as the backup. Every later
// restore (even to a completely fresh browser) then re-applied that
// incomplete snapshot *before* the SDK ever got to run its own open-time
// recovery scan again — a restored-nonempty local DB no longer looks like
// "the open that creates the wallet locally" to the SDK, so the scan that
// would have found the missing VTXO never re-ran. The backup, meant to
// protect against exactly this class of fund-visibility loss (see
// project_stop_gap_fund_loss), silently froze an incomplete view of the
// wallet instead.
//
// Bounded to SETTLE_MAX_WAIT_MS so a wallet that genuinely never settles (or
// a call that errors) doesn't block the first backup indefinitely — the
// debounced trigger (createBackupUploader) still catches anything this
// misses once Dashboard's own poll notices a real balance/history change.
// wallet.maintenance() here used to be the plain, uncapped call — a totally
// separate blind spot from Dashboard.tsx's refresh() (see maintenanceWithDeadline's
// own comment in bark.ts): this loop fires on every unlock, independent of
// Dashboard, and against a stalled Ark round-coordinator would sit for up to
// SETTLE_MAX_WAIT_MS repeatedly re-attempting a call that itself had no
// ceiling — found live 2026-09-15 still visibly hanging the worker's queue
// even after refresh() was fixed. maintenanceWithDeadline() bounds each
// attempt to a fixed ~60s; isMaintenanceSuppressed() (the same Settings
// toggle refresh() honors) skips the call entirely, same reasoning as there
// — vtxos() alone still gives a meaningful (if less complete) settle
// signal without ever touching the round-event stream.
//
// maintenanceWithDeadline() and wallet.vtxos() are deliberately in
// *separate* try/catch blocks, not one shared one. They used to share one,
// which meant a single failed maintenance attempt returned out of the whole
// function immediately — before ever calling vtxos() even once — and
// silently reintroduced the exact 2026-09-13 incident this function exists
// to prevent, just triggered by a different kind of transient error.
// maintenanceWithDeadline() failing is not rare: it's documented (see its
// own comment in bark.ts) to hang/timeout against a stalled Ark
// round-coordinator, a real, previously-observed occurrence, not a
// hypothetical one — and that failure says nothing about whether the
// locally known VTXO set has actually stabilized. A failed maintenance
// attempt here should cost this one poll's worth of refresh, not the whole
// settle wait. vtxos() failing is different: without it there is no
// settle signal at all for this attempt, so giving up there (as before)
// remains correct.
export async function waitForLocalStateToSettle(
  wallet: SettleCheckable,
  maintenance: () => Promise<unknown> = maintenanceWithDeadline,
): Promise<void> {
  const deadline = Date.now() + SETTLE_MAX_WAIT_MS;
  let prevKey: string | null = null;
  while (Date.now() < deadline) {
    if (!isMaintenanceSuppressed()) {
      try {
        await maintenance();
      } catch {
        // Best-effort — skip only this attempt's refresh; still check
        // vtxos() below with whatever local state already exists.
      }
    }
    try {
      const vtxos = await wallet.vtxos();
      const key = vtxos
        .map((v) => v.id)
        .sort()
        .join(",");
      if (prevKey !== null && key === prevKey) return;
      prevKey = key;
    } catch {
      // Best-effort — proceed to the upload rather than block it on a
      // transient error here; performUpload has its own failure handling.
      return;
    }
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
  }
}

export interface FetchedBackup {
  dump: BundledDump;
}

// Network + decrypt only — touches no local IndexedDB, so it's safe to call
// while the wallet is still open (no collision with the WASM wallet's own
// live DB connection). Returns null when there's simply no backup for this
// wallet yet (the expected case for every wallet that predates this
// feature), which the caller must NOT treat as an error.
//
// Takes already-derived keys, never the mnemonic — same contract as
// createBackupUploader/uploadBackupNow above, and for the same reason. It
// used to derive them itself from the mnemonic, which is no longer possible
// (or wanted) on the main thread now that the seed never leaves the wallet
// worker: the worker derives the keys during prepareSession and only the
// derived result comes back. See ARCHITECTURE.md.
export async function fetchAndDecryptBackup(keys: BackupKeys): Promise<FetchedBackup | null> {
  const fetched = await fetchServerDump(keys);
  if (!fetched) return null;
  // Seeds this device's optimistic-concurrency baseline from what it just
  // pulled down — see performUpload's own comment. Without this, the very
  // first upload right after a successful restore would still read the
  // pre-restore (or entirely absent) known version, and could misfire a
  // conflict against the backup this device just legitimately restored.
  setKnownVersion(keys.lookupKey, fetched.version);
  return { dump: fetched.dump };
}

async function fetchServerDump(keys: BackupKeys): Promise<{ dump: BundledDump; version: number } | null> {
  let res = await postJson("/api/backup/fetch", authBody(keys));
  // One retry, only on 429. The Worker rate-limits reads per source IP, and
  // this request is the one place where being told "later" is expensive out of
  // proportion to the cause: the caller (App.tsx) can't distinguish a throw
  // here from a corrupt or undecryptable backup, so it latches the
  // restore-failure flag and stops backing up until some later restore
  // succeeds. Several tabs or a reload loop on one connection is enough to
  // collide. The read bucket is sized so this should not trigger at all; the
  // retry is there so that if it ever does, it costs a second rather than a
  // wallet's backups.
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 2000));
    res = await postJson("/api/backup/fetch", authBody(keys));
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`backup fetch failed: ${res.status}`);

  const { iv, ciphertext, version } = (await res.json()) as { iv: string; ciphertext: string; version?: number };
  const plaintext = await decompressBackup(await decryptBackupBlob(keys.encryptionKey, iv, ciphertext));
  const dump = JSON.parse(new TextDecoder().decode(plaintext)) as BundledDump;
  return { dump, version: version ?? 0 };
}

// Names what the server backup holds that this device lacks, by primary key,
// store by store, or returns null when nothing is missing. Overwriting a
// backup that returns null here loses no record, which is what the version
// check exists to prevent (the gap-limit loss: VTXOs that only the backup
// still knows about). Values are not compared: local state is the one being
// kept either way. A store or database the server has and this device lacks
// counts as missing.
export function findMissingLocally(server: BundledDump, local: BundledDump): string | null {
  for (const name of ["ark", "onchain", "gifts", "vouchers"] as const) {
    const serverDb = server[name];
    if (!serverDb) continue;
    const localDb = local[name];
    if (!localDb) return name;
    for (const [storeName, serverStore] of Object.entries(serverDb.stores)) {
      const localStore = localDb.stores[storeName];
      if (!localStore) return `${name}/${storeName}`;
      const localKeys = new Set(localStore.records.map((r) => JSON.stringify(r.key)));
      const missing = serverStore.records.filter((r) => !localKeys.has(JSON.stringify(r.key))).length;
      if (missing > 0) return `${name}/${storeName} (${missing})`;
    }
  }
  return null;
}

// Slower way out of a latch, for when clearSelfInflictedConflictLatch cannot
// prove the server's version is this device's own (a conflict latch from
// before the pending-commit marker, a lost reply whose marker is gone) and for
// a failed-restore latch, which used to have no way out at all: one transient
// fetch error (offline, a 429, a Worker hiccup) on an import switched uploads
// off for good, because a restore is only retried over an EMPTY local database.
// Downloads and decrypts the server backup and lifts the latch only when
// nothing in it is missing locally, so the next upload cannot drop a record.
// A server with no backup at all (404) also lifts a failed-restore latch:
// there is nothing the next upload could overwrite. Runs in the background
// after unlock (a full backup download does not belong on the unlock path);
// uploads resume on the next open.
export async function liftConflictLatchIfCovered(keys: BackupKeys): Promise<boolean> {
  try {
    const latched = localStorage.getItem(RESTORE_FAILED_KEY);
    if (latched === null) return false;
    const conflict = isConflictLatch();
    const fetched = await fetchServerDump(keys);
    if (!fetched) {
      if (conflict) return false;
      clearRestoreFailure();
      return true;
    }
    if (fetched.version === 0) return false;
    const local = await dumpAllDatabases();
    const missing = findMissingLocally(fetched.dump, local);
    // Replaced by a different failure meanwhile.
    if (localStorage.getItem(RESTORE_FAILED_KEY)?.split(" | ")[0] !== latched.split(" | ")[0]) return false;
    if (missing !== null) {
      // Shown in Settings with the latch, the only place a phone user can
      // read why it stayed. Keeps the error's own prefix (isConflictLatch).
      const current = (localStorage.getItem(RESTORE_FAILED_KEY) ?? "").split(" | ")[0];
      localStorage.setItem(RESTORE_FAILED_KEY, `${current} | missing locally: ${missing}`.slice(0, 300));
      return false;
    }
    setKnownVersion(keys.lookupKey, fetched.version);
    clearRestoreFailure();
    return true;
  } catch (e) {
    console.warn("[backup] conflict latch content check failed", e);
    return false;
  }
}

// The actual IndexedDB write. Must only be called while nothing holds a
// live WASM handle on either database (see App.tsx's restore sequencing:
// close the just-opened wallet first, call this, then reopen) — restoring
// into a database a WASM object still references is unverified against the
// real SDK and deliberately avoided here.
export async function applyFetchedBackup(fetched: FetchedBackup): Promise<void> {
  if (fetched.dump.ark) await restoreDatabase(ARK_DB_NAME, fetched.dump.ark);
  if (fetched.dump.onchain) await restoreDatabase(ONCHAIN_DB_NAME, fetched.dump.onchain);
  // Last, and absent on every backup taken before gift links shipped — an
  // older blob simply has no `gifts` field and restores exactly as it always
  // did. Unlike the two above this database is ours, not the SDK's, and
  // nothing holds a handle on it here, so restoreDatabase creates it and its
  // one object store outright when the device has never sent a gift.
  if (fetched.dump.gifts) await restoreDatabase(GIFTS_DB_NAME, fetched.dump.gifts);
  // Same reasoning as gifts above, for a backup taken before vouchers
  // shipped.
  if (fetched.dump.vouchers) await restoreDatabase(VOUCHERS_DB_NAME, fetched.dump.vouchers);
}

// Before the stale-DB wipe on an import (App.tsx): "incorrect mnemonic" also
// comes from a seed typed with a one-word typo that still passes the BIP39
// checksum, and then the wipe deletes the REAL wallet's local state (coins
// outside a round, exit bookkeeping). A copy of both databases is kept in a
// separate IndexedDB (never read by the SDK, not touched by deleteWalletDb or
// reset) so it can be recovered by hand. Only the last two are kept. Skipped
// when there is nothing to lose; any failure here must not block the import.
const QUARANTINE_DB = "btc-wallet-quarantine";
const QUARANTINE_KEEP = 2;

export async function quarantineWalletDbs(): Promise<void> {
  try {
    if (!(await hasAnyLocalWalletData().catch(() => true))) return;
    const dump = stringifyDump(await dumpAllDatabases());
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(QUARANTINE_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("dumps");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("dumps", "readwrite");
        const store = tx.objectStore("dumps");
        store.put(dump, Date.now());
        const keys = store.getAllKeys();
        keys.onsuccess = () => {
          for (const k of (keys.result as number[]).sort((a, b) => a - b).slice(0, -QUARANTINE_KEEP)) store.delete(k);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch (e) {
    console.warn("[backup] could not quarantine local DBs before wipe", e);
  }
}
