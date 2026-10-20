// One-time coachmark flags for the post-setup onboarding tour. Each hint has
// its own independent flag (rather than one "tour done" flag) so a partial
// tour — e.g. the tab closed mid-sequence — resumes only with the hints not
// yet shown, instead of replaying ones already seen.

const PREFIX = "btc-wallet-hint-";

export type HintKey =
  | "logo-price"
  | "balance-hint"
  | "lock-gesture"
  | "qr-copy"
  | "onchain-info"
  | "utility-swipe"
  | "action-hold";

export function hasSeenHint(key: HintKey): boolean {
  return localStorage.getItem(PREFIX + key) === "1";
}

export function markHintSeen(key: HintKey): void {
  localStorage.setItem(PREFIX + key, "1");
}
