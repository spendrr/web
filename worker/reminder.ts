// Payment reminders by push (beta, V2): "pay @pavel 5000 sats" at the time a
// recurring payment falls due, while the app is closed.
//
// The server never sees the words. The app seals the text on the device
// (src/lib/chat/reminderBlob.ts) and hands the shard an opaque blob plus the
// time. The shard keeps both on the mailbox's own record and, when the time
// comes, forwards the blob as the push payload; the Service Worker opens it
// (public/sw-chat.js). What the server learns is that a reminder exists and
// when, never for whom or how much.
//
// Authorization is the height token (pushHeight.ts): proof of a record a
// verified subscribe created, no Ark server call. One reminder per mailbox,
// the soonest one; the app registers the next after each payment.
import type { PushSubscriptionRecord } from "./index";

// 12-byte IV + padded plaintext + 16-byte tag as base64url. The app pads to one
// size, so the cap only has to hold that and refuse anything that is not.
export const REMINDER_BLOB_RE = /^[A-Za-z0-9_-]{16,700}$/;
export const MAX_REMIND_BODY_BYTES = 2048;
// The record is dropped after SUBSCRIPTION_TTL_SECONDS without a subscribe, so
// a reminder further out than that could never fire.
export const MAX_REMIND_AHEAD_SECONDS = 40 * 24 * 60 * 60;
// A reminder this far past its time is not sent: a day-old "pay now" is noise.
export const REMIND_STALE_SECONDS = 2 * 24 * 60 * 60;
// Pushes one alarm may send. An alarm shares its 50 subrequests with
// CHECKS_PER_INVOCATION mailbox reads (mailboxWatcher.ts), which give up one
// read per reminder sent.
export const REMINDERS_PER_ALARM = 8;
// A reminder whose push failed is tried again after this, not at every alarm: the
// failing ones would otherwise take every slot ahead of reminders that would send.
export const REMINDER_RETRY_SECONDS = 30 * 60;

export function isRemindAt(value: unknown, nowSeconds: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > nowSeconds - REMIND_STALE_SECONDS &&
    value <= nowSeconds + MAX_REMIND_AHEAD_SECONDS
  );
}

// The record with the reminder set (or cleared, `remindAt` null), or null when
// the token does not match or the record never got one. Does not touch
// lastSeenAt: only a real subscribe keeps a subscription alive.
export function applyReminder(
  record: PushSubscriptionRecord,
  tokenHash: string,
  remindAt: number | null,
  blob: string | null,
): PushSubscriptionRecord | null {
  if (!record.heightTokenHash || record.heightTokenHash !== tokenHash) return null;
  const { remindAt: _a, remindBlob: _b, ...rest } = record;
  if (remindAt === null || blob === null) return rest;
  return { ...rest, remindAt, remindBlob: blob };
}

// The ids due at `now`, soonest first, at most `max`. `index` maps mailbox id to
// remindAt (seconds).
export function dueReminders(index: Record<string, number>, now: number, max: number): string[] {
  return Object.entries(index)
    .filter(([, at]) => at <= now)
    .sort((a, b) => a[1] - b[1])
    .slice(0, max)
    .map(([id]) => id);
}

export function isStaleReminder(remindAt: number, now: number): boolean {
  return now - remindAt > REMIND_STALE_SECONDS;
}
