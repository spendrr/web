// A short "payment in progress" window during which Dashboard.tsx skips the
// background chores that can hold the wallet worker's single FIFO queue for
// many seconds at a time: maintenance (up to its ~60s deadline) and the
// on-chain sync. Every wallet.* call waits its turn behind whatever is
// already running (walletWorkerImpl.ts), so without this a tap-to-pay send,
// and the receiver's balance checks watching for it, routinely sat behind a
// chore and the payment "took forever" to finish on both screens.
//
// Skipping them briefly is harmless: ARCHITECTURE.md's maintenance-suppression
// notes cover why a delayed maintenance() isn't a fund-safety issue, and the
// SDK's background daemon keeps pulling mailbox deliveries (incoming Ark
// payments) on its own regardless.
//
// Self-expiring, so a screen that unmounts without clearing it can't leave
// the chores switched off: the owner re-arms it while it still needs it.
const WINDOW_MS = 90_000;

let activeUntil = 0;

export function setPaymentPriority(active: boolean): void {
  activeUntil = active ? Date.now() + WINDOW_MS : 0;
}

export function isPaymentPriority(): boolean {
  return Date.now() < activeUntil;
}

// The receiving side of a tap-to-pay: the bump sheet already shows its own
// "Přijato", so the generic "Platba přijata" toast Dashboard's receive watchers
// raise for the same movement would just be a second announcement on top of it.
// Armed while the sheet is in the receiving role and kept for a short grace
// after it goes away, because a watcher can see the movement a few seconds
// after the sheet noticed it (its own poll interval). Self-expiring like the
// window above. Only the toast is suppressed; balance, history and the balance
// animation are untouched, and so is an unrelated payment outside this window.
const BUMP_TOAST_GRACE_MS = 15_000;

let bumpReceivingUntil = 0;

export function setBumpReceiving(active: boolean): void {
  const now = Date.now();
  bumpReceivingUntil = active ? now + WINDOW_MS : Math.min(bumpReceivingUntil, now + BUMP_TOAST_GRACE_MS);
}

export function isBumpReceiving(): boolean {
  return Date.now() < bumpReceivingUntil;
}
