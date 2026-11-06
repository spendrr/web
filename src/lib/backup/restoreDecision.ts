// Whether opening a wallet should first look for a cloud backup to restore.
//
// An import or recovery always looks. A plain unlock looks only when the local
// databases are empty (the browser wiped IndexedDB while the vault survived),
// so an empty local state is never uploaded over a good backup. A seed the app
// has just generated looks never: no backup can exist for it, and a failed
// lookup would switch uploads off for a wallet with nothing to restore.
//
// `hasLocalData` is only called when the answer depends on it. A failing check
// counts as "data present": restoring needlessly over local state is worse than
// skipping the safety net once.
export async function shouldAttemptRestore(
  opts: { tryRestoreBackup: boolean; freshSeed: boolean },
  hasLocalData: () => Promise<boolean>,
): Promise<boolean> {
  if (opts.tryRestoreBackup) return true;
  if (opts.freshSeed) return false;
  return !(await hasLocalData().catch(() => true));
}

// What an onboarding open means for the backup. `openNewWallet` is reached only
// from the two onboarding paths: an imported seed (look for its backup) and a
// seed the app has just generated (there is none). Kept in one place so the two
// flags cannot drift apart.
export function restoreIntentForOnboarding(isImport: boolean): { tryRestoreBackup: boolean; freshSeed: boolean } {
  return { tryRestoreBackup: isImport, freshSeed: !isImport };
}
