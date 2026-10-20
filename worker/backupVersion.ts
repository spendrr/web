// Pure version-arithmetic for the cloud backup's optimistic-concurrency
// commit check (see worker/index.ts's handleBackupCommit/handleBackupMeta
// and ARCHITECTURE.md's backup section). Kept in its own file, with no Worker/R2
// dependency, so this exact arithmetic is unit-testable the same way
// backupStore.ts's chooseRestoreVersion is (tests/backupVersion.test.ts) —
// a regression here either lets a stale device silently overwrite a newer
// backup (the bug this exists to close) or permanently wedges every future
// commit for a wallet, so it's worth pinning down outside the Workers
// runtime.
//
// The problem this closes: before this existed, handleBackupCommit's only
// check was that the tmp object hadn't changed since the client verified it
// (see its own sha256 comment) — that guards the upload-tmp -> commit
// window, but says nothing about whether the content being committed is
// actually newer than what's already there. A second device/session with
// stale local wallet state (an old laptop that imported the same mnemonic
// months ago and was never opened since) would pass that check fine — its
// own upload is internally consistent, just old — and silently clobber a
// fresher backup from another device. There's only one blob per wallet, so
// that's an unrecoverable loss of exactly the kind this whole feature
// exists to prevent (see ARCHITECTURE.md's STOP_GAP note).

// Parses the `version` customMetadata field on a committed R2 object.
// Missing/unparseable reads as 0 — the same sentinel used for "no backup
// exists at all". Deliberately conflated: every backup committed before
// this field existed has no `version` tag, and there's no way to know its
// "true" version relative to some other device's local state — so it's
// treated as freshly commit-eligible exactly once (see
// resolveCommitVersion below), which is what upgrades it into the versioned
// scheme. From that first versioned commit onward, every later commit is
// checked for real.
export function parseVersion(raw: string | undefined | null): number {
  if (raw === undefined || raw === null) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

// The actual optimistic-concurrency decision, applied at commit time.
// `currentVersion` must come from a fresh head() taken immediately before
// this call (see handleBackupCommit's own comment on why a version learned
// earlier in the request, or in an earlier request, isn't good enough —
// that's exactly the TOCTOU gap a stale overwrite exploits). `baseVersion`
// is what the client believed was current when it started this upload
// cycle: 0 means "never synced against a real backup" (a brand-new wallet,
// or a device that has never recorded a known version at all).
//
// currentVersion === 0 always succeeds regardless of baseVersion — that's
// both the legitimate "no backup yet" first-ever upload, and the one-time
// migration window for a backup committed before versioning existed (see
// parseVersion's comment). Every commit after that first one always has a
// real, nonzero current version, so a wallet can only ever cross this
// unconditional-accept window once.
export function resolveCommitVersion(currentVersion: number, baseVersion: number): number | "conflict" {
  if (currentVersion !== 0 && baseVersion !== currentVersion) return "conflict";
  return currentVersion + 1;
}
