// Gift status from the open-time recovery scan (beta). Pure, so the rules can be tested without a wallet.
//
// A gift's state used to be inferred from a mailbox pull that, for a claimed gift, never finished, so a slow
// connection and a claimed gift looked the same. Opening a fresh local wallet DB from the gift's seed runs a
// recovery scan whose report is a definite answer (regtest 2026-10-14, six scenarios; mainnet, two gifts):
//   nothing registered            -> nobody has pulled the gift yet
//   `recovered` (still spendable) -> the recipient pulled it, the forward is not done
//   `skipped` (spent)             -> forwarded: claimed by the recipient, or taken back by us
// The scan only runs on the open that creates the DB, so every look uses a new DB name and drops it after.
import { claimIsAssumed } from "./giftReclaim";
import type { OutgoingGift } from "./giftStore";

export { classifyGiftScan, type GiftScan } from "./giftScanReport";
import type { GiftScan } from "./giftScanReport";

export type ScanHint = Exclude<GiftScan, "unknown">;
export interface GiftScanEntry {
  hint: ScanHint;
  at: number;
}

export type GiftRowStatus = "creating" | "waiting" | "opened" | "claimed" | "reclaimed";

// Gifts a look is meaningful for: the stored record says unclaimed, or says claimed only because timeouts
// piled up (never seen empty). A creating gift is settled by the reclaim sweep, a reclaimed one is ours.
export function isLookable(g: OutgoingGift): boolean {
  return g.state === "unclaimed" || claimIsAssumed(g);
}

export function scanStatus(g: OutgoingGift, entry: GiftScanEntry | undefined): GiftRowStatus {
  if (g.state === "reclaimed") return "reclaimed";
  if (g.state === "creating") return "creating";
  if (g.state === "claimed" && !claimIsAssumed(g)) return "claimed";
  if (entry?.hint === "claimed") return "claimed";
  if (entry?.hint === "opened") return "opened";
  return "waiting";
}

export function isDone(status: GiftRowStatus): boolean {
  return status === "claimed" || status === "reclaimed";
}

export const SCAN_TTL_MS = 10 * 60_000;
// A look is a throwaway wallet, one at a time (about a second each), so the list looks at the newest few by itself.
export const AUTO_SCANS_PER_OPEN = 12;

export function needsScan(g: OutgoingGift, entry: GiftScanEntry | undefined, now: number): boolean {
  if (!isLookable(g)) return false;
  if (!entry) return true;
  // Spent does not unspend.
  if (entry.hint === "claimed") return false;
  return now - entry.at >= SCAN_TTL_MS;
}

export function scanIds(gifts: OutgoingGift[], cache: Record<string, GiftScanEntry>, now: number): string[] {
  return [...gifts]
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter((g) => needsScan(g, cache[g.id], now))
    .slice(0, AUTO_SCANS_PER_OPEN)
    .map((g) => g.id);
}

// "Vzít zpět" is shown wherever the gift may still be here. A definite claim has nothing to take back.
export function canTakeBackScan(g: OutgoingGift, status: GiftRowStatus): boolean {
  if (isDone(status)) return false;
  return g.state === "unclaimed" || g.state === "creating" || claimIsAssumed(g);
}

export type ScanExpiry = { kind: "in"; ms: number } | { kind: "due" } | null;

// Only for gifts the 7 day auto-return will act on.
export function scanExpiry(g: OutgoingGift, status: GiftRowStatus, now: number): ScanExpiry {
  if (g.state !== "unclaimed" || isDone(status)) return null;
  return now < g.expiresAt ? { kind: "in", ms: g.expiresAt - now } : { kind: "due" };
}
