// Everything App.tsx's "reset wallet" flow must clear, gathered in one
// place. Before this existed, resetWallet() only called clearVault() —
// leaving the biometric vault behind meant a fingerprint could still
// decrypt and reveal the *old* mnemonic after a "reset," even though the
// reset-confirm dialog explicitly promises the fingerprint gets cleared too.
// The emergency-exit destination address and last-seen-movement-id are also
// wallet-specific state that must not leak into whatever wallet gets
// created/imported next.
import { clearVault } from "./crypto";
import { clearDeviceVault } from "./deviceVault";
import { clearNeedsSeedBackup, clearPendingGiftPassword } from "../gift/giftStore";
import { clearBiometricUnlock } from "./webauthn";
import { clearAllExitState } from "../exit/emergencyExit";
import { clearPushHeightToken, disableNotifications } from "../notifications";
import { clearStoredReceiveAddress } from "../wallet/onchainReceiveAddress";
import { clearEngineStates } from "../refreshEngine/runner";
import { clearPushSlots } from "../chat/pushSlots";
import { setChatPushSettings } from "../chat/chatEnabled";

const ONCHAIN_SCANNED_KEY = "btc-wallet-onchain-scanned";
const LAST_SEEN_MOVEMENT_KEY = "btc-wallet-last-seen-movement-id";
const LAST_SEEN_BALANCE_KEY = "btc-wallet-last-seen-balance";

export async function clearAllLocalWalletState(): Promise<void> {
  clearVault();
  await clearDeviceVault();
  clearBiometricUnlock();
  clearAllExitState();
  clearPushHeightToken();
  // Chat notification keys and names, readable without the password; the
  // switch goes off first so disableNotifications below drops the
  // subscription the chat tokens were made for.
  setChatPushSettings(false);
  await clearPushSlots();
  localStorage.removeItem(ONCHAIN_SCANNED_KEY);
  localStorage.removeItem(LAST_SEEN_MOVEMENT_KEY);
  // Otherwise the next wallet's very first balance load compares itself
  // against a number left behind by whatever wallet used to be on this
  // device and plays a meaningless (and possibly alarming) roll animation.
  localStorage.removeItem(LAST_SEEN_BALANCE_KEY);
  clearStoredReceiveAddress();
  // Gift-link recipient leftovers, both keyed to the wallet being thrown
  // away. The pending password is the important one: it is a vault password
  // in the clear, and after a reset it doesn't even open anything — the
  // unlock screen's "here is your password" modal would offer the *previous*
  // wallet's password for whatever wallet gets created next.
  clearPendingGiftPassword();
  clearNeedsSeedBackup();
  // The refresh engine's state per wallet: tracked batches, quarantine and a
  // log of coin ids and amounts that must not outlive the wallet.
  clearEngineStates();
  try {
    // Best-effort: unsubscribing needs a network round-trip to our own
    // Worker, which can fail (offline, etc.) — that shouldn't block or fail
    // the rest of the reset.
    await disableNotifications();
  } catch {
    // Ignored — see comment above.
  }
}
