// Orchestrates the encrypted cloud backup feature (see ARCHITECTURE.md's backup
// section): dumps both local IndexedDB databases, encrypts them with a key
// derived from the mnemonic (backupCrypto.ts), and uploads to this app's own
// Worker via a tmp-key -> verify -> commit sequence so a partial/corrupt
// upload can never clobber the last good backup. Restore is the inverse,
// used only on the import/recovery path (App.tsx).
//
// Modeled on notifications.ts's postSubscription()/refreshPushAuthorization()
// pattern: every network call here is best-effort and never throws to a
// caller that isn't explicitly awaiting a result (uploads are fire-and-forget
// by design; restore is the one path that does propagate failure, since the
// caller needs to know whether it got real data back).
import { encryptBackupBlob, decryptBackupBlob, sha256Hex, type BackupKeys } from "./backupCrypto";
import { compressBackup, decompressBackup } from "./backupCompress";
import { dumpWithoutChainCheckpoints } from "./backupFingerprint";
import { ARK_DB_NAME, ONCHAIN_DB_NAME, dumpDatabase, hasAnyLocalWalletData, restoreDatabase, type SerializedDb } from "./backupStore";
import { GIFTS_DB_NAME } from "../gift/giftStore";
import { maintenanceWithDeadline } from "../wallet/bark";
import { isMaintenanceSuppressed } from "../maintenance/maintenanceSuppress";

// Bitrefill orders. The feature itself is archived (archive/bitrefill/), but
// its database stays in the backup: a device that bought something still has
// the records, and a later release that brings the feature back must find
// them in the backup too, not lose them to the first upload without it.
const VOUCHERS_DB_NAME = "btc-wallet-vouchers";

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

interface BundledDump {
  ark: SerializedDb | null;
  onchain: SerializedDb | null;
  // Outgoing gift links (btc-wallet-gifts). Optional, not just nullable:
  // every backup written before gifts existed decodes without this field,
  // and restore has to treat "absent" exactly like "no gifts" rather than
  // failing on an older blob.
  gifts?: SerializedDb | null;
  // Bitrefill orders (btc-wallet-vouchers) — same optionality reasoning as
  // gifts above, for the same kind of backup written before this feature
  // existed.
  vouchers?: SerializedDb | null;
}

async function dumpAllDatabases(): Promise<BundledDump> {
  const [ark, onchain, gifts, vouchers] = await Promise.all([
    dumpDatabase(ARK_DB_NAME),
    dumpDatabase(ONCHAIN_DB_NAME),
    // Small (one record per gift) but load-bearing: each record carries the
    // encrypted reclaim seed for a gift whose funds are sitting on the Ark
    // server. Lose it and the 7-day auto-return and the manual "Vzít zpět"
    // both have nothing to work with, and the money is unreachable for good.
    dumpDatabase(GIFTS_DB_NAME),
    // Also small and load-bearing in the same way: an order paid for but not
    // yet delivered has real money already spent riding on it, and a
    // delivered order's redemption code is the only copy of something as
    // spendable as the gift card itself — losing this record after paying
    // but before the app ever showed the code would be an unrecoverable
    // loss with nothing to point at.
    dumpDatabase(VOUCHERS_DB_NAME),
  ]);
  return { ark, onchain, gifts, vouchers };
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Belt-and-suspenders on top of backupStore.ts's own tagValue(): if any
// value ever reaches JSON.stringify still untagged in a form JSON can't
// represent (a bigint slipping through, most plausibly — that exact bug hit
// production once already, see backupStore.ts's tagValue comment), fail
// with a clear, attributable error instead of JSON.stringify's own opaque
// TypeError, and coerce bigints to strings rather than crashing outright so
// a single unanticipated field doesn't block the whole backup.
function stringifyDump(dump: unknown): string {
  return JSON.stringify(dump, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
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
function adoptOwnLostCommit(lookupKey: string, serverVersion: number, serverSha256: unknown): boolean {
  try {
    const raw = localStorage.getItem(pendingCommitKey(lookupKey));
    if (raw === null) return false;
    const pending = JSON.parse(raw) as { base?: unknown; sha256?: unknown };
    if (typeof pending.base !== "number" || typeof pending.sha256 !== "string") return false;
    if (serverVersion !== pending.base + 1 || serverSha256 !== pending.sha256) return false;
    setKnownVersion(lookupKey, serverVersion);
    localStorage.setItem(lastUploadedHashKey(lookupKey), pending.sha256);
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

function runUploadExclusive(keys: BackupKeys): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request("btc-wallet-backup-upload", () => performUpload(keys));
  }
  const run = localUploadChain.then(() => performUpload(keys));
  localUploadChain = run.catch(() => {});
  return run;
}

async function performUpload(keys: BackupKeys): Promise<void> {
  const dump = await dumpAllDatabases();
  if (!dump.ark && !dump.onchain) return; // Nothing local to back up yet.
  // The Ark database is the one that holds the VTXOs — the whole reason this
  // feature exists. Every caller runs only *after* a successful openWallet(),
  // which always creates it, so a null here doesn't mean "new wallet", it
  // means the dump itself didn't see what it should have (a failed/blocked
  // open, a restore that died partway through). Committing that would
  // overwrite the one server-side copy with a bundle missing its important
  // half — permanently, since there is only ever one blob per wallet. Refuse
  // and surface it instead.
  if (!dump.ark) throw new Error("refusing to upload: Ark database dumped empty");

  const plaintext = new TextEncoder().encode(stringifyDump(dump));
  const expectedHash = await sha256Hex(plaintext);

  // Skip the network round-trip entirely when the last successfully
  // committed backup for this wallet already matches byte-for-byte. Most
  // triggers (every open/unlock via uploadBackupNow, the debounced trigger
  // on any balance/history change) fire far more often than the wallet's
  // actual state changes, so this is the difference between backing up on
  // every app open and backing up only when there's something new — each
  // skipped cycle saves 2 R2 Class A writes (upload-tmp + commit) plus a
  // Class B read (the fetch-tmp round-trip verify).
  const hashKey = lastUploadedHashKey(keys.lookupKey);
  if (localStorage.getItem(hashKey) === expectedHash) return;

  // Same skip, but blind to the block checkpoints that move with every block
  // (backupFingerprint.ts). Equal to expectedHash when the dump has none, in
  // which case the check above already decided.
  const withoutChain = dumpWithoutChainCheckpoints(dump);
  const fingerprint = withoutChain ? await sha256Hex(new TextEncoder().encode(stringifyDump(withoutChain))) : expectedHash;
  if (fingerprintUnchanged(keys.lookupKey, fingerprint)) return;

  // Optimistic-concurrency guard against a stale device silently
  // overwriting a newer backup from elsewhere (see backupVersion.ts's own
  // top-of-file comment for the full scenario: a second device/session with
  // older local wallet state, e.g. an old laptop that imported the same
  // mnemonic months ago and was never opened since). Learn the server's
  // *actual current* version right now, not whatever this device last saw —
  // another device/session may have committed since — and refuse to
  // proceed if it doesn't match what this device believes is current.
  // serverVersion === 0 ("no backup yet", including every backup committed
  // before this check existed) always passes regardless of baseVersion —
  // see resolveCommitVersion's own comment for why that one-time exception
  // is safe.
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
    if (serverSha256 === expectedHash) return; // The lost commit already holds this state.
  }
  if (serverVersion !== 0 && baseVersion !== serverVersion) {
    throw new BackupVersionConflictError(
      `refusing to upload: server backup is at version ${serverVersion}, this device last knew ${baseVersion}`,
    );
  }

  // Compressed before encryption (backupCompress.ts); the hash above and the
  // verify below stay on the uncompressed JSON.
  const { ivHex, cipherB64 } = await encryptBackupBlob(keys.encryptionKey, await compressBackup(plaintext));

  const uploadRes = await postJson("/api/backup/upload-tmp", {
    ...authBody(keys),
    iv: ivHex,
    ciphertext: cipherB64,
    sha256: expectedHash,
  });
  if (!uploadRes.ok) throw new Error(`upload-tmp failed: ${uploadRes.status} ${await readErrorBody(uploadRes)}`);

  // Read back exactly what the server actually stored and decrypt+hash it
  // before ever promoting it — this is what makes overwrite-latest safe: a
  // transit or storage corruption is caught here, before commit, so it can
  // never clobber the last good backup. Never call commit speculatively.
  const readBackRes = await postJson("/api/backup/fetch-tmp", authBody(keys));
  if (!readBackRes.ok) {
    throw new Error(`fetch-tmp verify failed: ${readBackRes.status} ${await readErrorBody(readBackRes)}`);
  }
  const { iv: readBackIv, ciphertext: readBackCipher } = (await readBackRes.json()) as {
    iv: string;
    ciphertext: string;
  };
  const roundTripped = await decompressBackup(await decryptBackupBlob(keys.encryptionKey, readBackIv, readBackCipher));
  const actualHash = await sha256Hex(roundTripped);
  if (actualHash !== expectedHash) {
    throw new Error("backup verify failed: hash mismatch after round-trip");
  }

  // sha256 lets the server refuse to promote a tmp object it never verified —
  // see handleBackupCommit's own comment for the concurrent-upload window
  // this closes: without it, whatever bytes happen to be at the tmp key at
  // commit time get promoted, not necessarily the ones just hash-verified
  // above. baseVersion is the second, independent check on the same call —
  // see resolveCommitVersion — for whether the promoted content is actually
  // newer than what's already there, which the sha256 check alone can't
  // tell.
  try {
    const pending = JSON.stringify({ base: serverVersion, sha256: expectedHash });
    localStorage.setItem(pendingCommitKey(keys.lookupKey), pending);
  } catch {
    // Best-effort: without it a lost reply latches, as before.
  }
  const commitRes = await postJson("/api/backup/commit", {
    ...authBody(keys),
    sha256: expectedHash,
    baseVersion: serverVersion,
  });
  if (commitRes.status === 409) {
    // Someone else (another device/session) committed between the meta
    // check above and this call — the same conflict, just caught at the
    // narrower TOCTOU window handleBackupCommit's own head() closes rather
    // than the coarser one this function's own meta check closes.
    throw new BackupVersionConflictError("commit rejected: server backup changed since the meta check");
  }
  if (!commitRes.ok) throw new Error(`commit failed: ${commitRes.status} ${await readErrorBody(commitRes)}`);
  const { version: committedVersion } = (await commitRes.json()) as { version: number };
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

  const runNow = () => {
    if (cancelled) return;
    inFlight = true;
    recordAttempt();
    runUploadExclusive(keys)
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
      // An upload already in flight (its network calls already dispatched)
      // can't be aborted from here — cancelled only stops it from recording
      // an outcome or requeuing once it resolves. That upload's own dump was
      // taken before this cancel() ran, so it still reflects the wallet this
      // uploader was created for, not whatever opens next.
    },
  };
}

// Fire-and-forget one-shot upload, used right after a successful open/unlock
// — separate from the debounced trigger above since this should run once
// immediately, not wait out a debounce window. Same keys-not-mnemonic
// contract as createBackupUploader.
export function uploadBackupNow(keys: BackupKeys): void {
  recordAttempt();
  runUploadExclusive(keys)
    .then(() => recordSuccess())
    .catch(handleUploadFailure);
}

interface SettleCheckable {
  allVtxos(): Promise<{ id: string }[]>;
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
// — allVtxos() alone still gives a meaningful (if less complete) settle
// signal without ever touching the round-event stream.
//
// maintenanceWithDeadline() and wallet.allVtxos() are deliberately in
// *separate* try/catch blocks, not one shared one. They used to share one,
// which meant a single failed maintenance attempt returned out of the whole
// function immediately — before ever calling allVtxos() even once — and
// silently reintroduced the exact 2026-09-13 incident this function exists
// to prevent, just triggered by a different kind of transient error.
// maintenanceWithDeadline() failing is not rare: it's documented (see its
// own comment in bark.ts) to hang/timeout against a stalled Ark
// round-coordinator, a real, previously-observed occurrence, not a
// hypothetical one — and that failure says nothing about whether the
// locally known VTXO set has actually stabilized. A failed maintenance
// attempt here should cost this one poll's worth of refresh, not the whole
// settle wait. allVtxos() failing is different: without it there is no
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
        // allVtxos() below with whatever local state already exists.
      }
    }
    try {
      const vtxos = await wallet.allVtxos();
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
