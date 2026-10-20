// Updating only the watched block height of an existing push subscription,
// without the Ark server (external audit 2026-09-27, N1).
//
// Every /api/push/subscribe write is checked against the live Ark server
// (verifyMailboxAuthorization), so while the server is down, the one thing a
// unilateral exit needs from push, a new wake-up height, could not be stored:
// the watch stayed at whatever was reported while the server still answered.
// The expiry check itself runs without the server (checkVtxoExpiry needs
// only the chain tip), so only this write was missing.
//
// Authorization without the server: every verified subscribe stores the
// SHA-256 of a random token the client keeps (heightToken). /api/push/height
// must present that token. It can only change the height of a record that a
// verified subscribe created and gave a token to; it never creates one, and
// never touches the push endpoint or the mailbox authorization.
import type { PushSubscriptionRecord } from "./index";

// Same shape and hash as the backup write token.
export { WRITE_TOKEN_RE as HEIGHT_TOKEN_RE, hashWriteToken as hashHeightToken } from "./backupAuth";

// The record after a height update, or null when the token doesn't match
// (or the record never got one). `height` null clears the watch, like the
// subscribe endpoint's explicit null.
export function applyHeightUpdate(
  record: PushSubscriptionRecord,
  tokenHash: string,
  height: number | null,
  now: number,
): PushSubscriptionRecord | null {
  if (!record.heightTokenHash || record.heightTokenHash !== tokenHash) return null;
  const next: PushSubscriptionRecord = { ...record, lastSeenAt: now };
  const effective = height === null ? undefined : height;
  next.firstExpiringVtxoBlockheight = effective;
  if (record.firstExpiringVtxoBlockheight !== effective) {
    // A new watch point gets its own nudges.
    delete next.expiryNotifiedForHeight;
    delete next.expiryReminderNotifiedForHeight;
    delete next.expiryUrgentNotifiedForHeight;
  }
  return next;
}
