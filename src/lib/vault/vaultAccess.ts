// Where a flow that needs the password vault ends up when there is none. A passwordless gift wallet
// (deviceVault.ts) has no password vault yet, so anything that must re-enter a password asks App to open the setup
// sheet instead of failing with a dead end.
import { loadVault, type EncryptedVault } from "./crypto";
import { hasDeviceVault } from "./deviceVault";

export const PASSWORD_SETUP_EVENT = "spendrr:password-setup";

export type PasswordSetupReason = "gift" | "spend" | "backup" | "settings";

// Fired once a passwordless wallet got its password, so a screen that already rendered (Settings) can re-read it.
export const VAULT_PASSWORD_SET_EVENT = "btc-wallet-vault-password-set";

export function requestPasswordSetup(reason: PasswordSetupReason = "spend"): void {
  window.dispatchEvent(new CustomEvent<PasswordSetupReason>(PASSWORD_SETUP_EVENT, { detail: reason }));
}

// The password vault, or null. With no password vault but a device vault the setup sheet is requested first.
export function loadVaultOrPrompt(): EncryptedVault | null {
  const vault = loadVault();
  if (vault) return vault;
  if (hasDeviceVault()) requestPasswordSetup();
  return null;
}

// The error text for "no vault", by situation (Czech source string; callers pass it through t()).
export function missingVaultText(): string {
  return hasDeviceVault() ? "Nejdřív si nastav heslo k peněžence." : "Trezor nenalezen.";
}
