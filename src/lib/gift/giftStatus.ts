// What the Settings gift list shows and when it looks again. Pure, so the
// rules can be tested without a wallet or a worker.
import { claimIsAssumed } from "./giftReclaim";
import type { GiftPeekEntry } from "./giftStore";
import type { OutgoingGift } from "./giftStore";

// How old a look may be before the list does it again on open. A definite
// "claimed" is final (an empty wallet does not fill up again), so it is never
// looked at automatically. A "slow" look costs the whole pull budget every
// time, so it gets one try a day. A gift that was found waiting is cheap to
// re-check but rarely changes within minutes.
export const PEEK_TTL_UNCLAIMED_MS = 10 * 60_000;
export const PEEK_TTL_LIKELY_CLAIMED_MS = 24 * 60 * 60_000;
// Looks started by opening the list, newest gifts first. The rest wait for a
// tap: every look opens a whole throwaway wallet, one at a time.
export const AUTO_LOOKS_PER_OPEN = 4;

export type GiftStatus =
  | "creating" // funding never confirmed
  | "waiting" // found untouched
  | "unverified" // nothing known yet
  | "likely-claimed" // pull never finished
  | "claimed"
  | "reclaimed";

export function giftStatus(g: OutgoingGift, entry: GiftPeekEntry | undefined): GiftStatus {
  if (g.state === "reclaimed") return "reclaimed";
  if (g.state === "creating") return "creating";
  if (g.state === "claimed") return claimIsAssumed(g) ? "likely-claimed" : "claimed";
  if (entry?.hint === "claimed") return "claimed";
  if (entry?.hint === "likely-claimed") return "likely-claimed";
  if (entry?.hint === "unclaimed") return "waiting";
  return "unverified";
}

// Finished rows (nothing left to do with them) go in the compact group.
export function isFinished(status: GiftStatus): boolean {
  return status === "claimed" || status === "reclaimed";
}

// Whether opening the list should look into this gift again.
export function needsLook(g: OutgoingGift, entry: GiftPeekEntry | undefined, now: number): boolean {
  if (g.state !== "unclaimed") return false;
  if (!entry) return true;
  const age = now - entry.at;
  if (entry.hint === "claimed") return false;
  if (entry.hint === "likely-claimed") return age >= PEEK_TTL_LIKELY_CLAIMED_MS;
  return age >= PEEK_TTL_UNCLAIMED_MS;
}

// The gifts to look into automatically on open: the newest ones that need it.
export function autoLookIds(gifts: OutgoingGift[], cache: Record<string, GiftPeekEntry>, now: number): string[] {
  return [...gifts]
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter((g) => needsLook(g, cache[g.id], now))
    .slice(0, AUTO_LOOKS_PER_OPEN)
    .map((g) => g.id);
}

// "Take back" is how the money comes back, so it follows the stored state and
// whether the label can be trusted: a definite "claimed" (an empty wallet) has
// nothing to take back; everything that might still hold the gift keeps it.
export function canTakeBack(g: OutgoingGift, status: GiftStatus): boolean {
  if (status === "claimed" || status === "reclaimed") return false;
  return g.state === "unclaimed" || g.state === "creating" || claimIsAssumed(g);
}

export type ExpiryInfo = { kind: "in"; ms: number } | { kind: "due" } | null;

// Only for gifts the 7 day auto-return will act on.
export function expiryInfo(g: OutgoingGift, status: GiftStatus, now: number): ExpiryInfo {
  if (g.state !== "unclaimed" || isFinished(status)) return null;
  return now < g.expiresAt ? { kind: "in", ms: g.expiresAt - now } : { kind: "due" };
}
