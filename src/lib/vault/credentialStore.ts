// Best-effort hand-off of the auto-generated gift-recipient password to the
// browser / OS password manager, so a wallet that was created without the
// user ever typing a password still has a recoverable way in besides the
// seed phrase.
//
// This is genuinely best-effort: `navigator.credentials` with
// PasswordCredential is Chromium-only, and even there the "save password?"
// prompt is the browser's call. On Safari/Firefox this is a no-op today —
// the seed-phrase backup banner is the real safety net (see ARCHITECTURE.md's
// gift-link section). Returns whether the credential was handed off, purely
// so the caller can record it; never throws.
export async function offerPasswordToManager(username: string, password: string): Promise<boolean> {
  try {
    const w = window as unknown as {
      PasswordCredential?: new (data: { id: string; password: string; name?: string }) => Credential;
    };
    if (!w.PasswordCredential || !navigator.credentials || !("store" in navigator.credentials)) {
      return false;
    }
    const cred = new w.PasswordCredential({ id: username, password, name: username });
    await (navigator.credentials as unknown as { store: (c: Credential) => Promise<Credential> }).store(cred);
    return true;
  } catch {
    return false;
  }
}
