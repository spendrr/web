// The message a payer attached to a Lightning-address payment (Phoenix "attach
// a message", LUD-12). Only the Worker knows it. The payment reaches this wallet
// as an ordinary Ark receive (the service wallet pays the wallet's address once
// the invoice is paid), with no Lightning hash on it, so a receipt is tied to a
// movement by amount and time.
//
// Each movement is asked about once, ever: the answer, including "none", is kept
// on this device by movement id. A failed ask is not kept.
import { useEffect, useState } from "react";
import type { WalletClient } from "../wallet/bark";
import { fetchLnaddrReceipts, type LnReceipt } from "./names";

export const LN_COMMENTS_KEY = "btc-wallet-ln-comments";
// Oldest entries go first; a payment older than this is simply asked again.
export const LN_COMMENTS_MAX = 300;
// How far apart the payment and the Ark receive that carries it may be: the
// wallet may be closed when it is paid and pick the coin up on its next open.
export const LN_MATCH_WINDOW_MS = 24 * 60 * 60 * 1000;
// A payment cannot show up in the wallet before it was paid; this much clock
// difference between the node and the phone is tolerated.
const CLOCK_SLACK_MS = 5 * 60 * 1000;
// The ledger notices a payment on a once-a-minute sweep, so a payment that just
// arrived still reads "pending" there. Such an invoice is accepted for a
// movement that shows up within this long of it being issued (a payer pays in
// seconds), and only when no settled receipt fits the movement.
export const LN_PENDING_WINDOW_MS = 5 * 60 * 1000;
// A movement this young that found no message is asked about again next time
// instead of being remembered as "none": its receipt may not be there yet.
export const LN_YOUNG_MS = 10 * 60 * 1000;

export type LnMovement = { id: number; sats: number; atMs: number };

// Ties receipts to movements one to one: every pair with the same amount and a
// plausible time is a candidate, the closest pairs are taken first, so two
// payments of the same amount go to their own movements and a movement that
// another payment fits better is left without. A receipt with no comment still
// takes its movement, so its neighbour cannot be given someone else's message.
export function matchLnComments(movements: readonly LnMovement[], receipts: readonly LnReceipt[]): Map<number, string | null> {
  const pairs: { m: number; r: number; gap: number; settled: boolean }[] = [];
  movements.forEach((m, mi) => {
    receipts.forEach((r, ri) => {
      if (r.amountSats !== m.sats) return;
      const after = m.atMs - r.at;
      if (after < -CLOCK_SLACK_MS || after > (r.settled ? LN_MATCH_WINDOW_MS : LN_PENDING_WINDOW_MS)) return;
      pairs.push({ m: mi, r: ri, gap: Math.abs(after), settled: r.settled });
    });
  });
  // Paid receipts first, then the ones the ledger has not caught up with.
  pairs.sort((a, b) => Number(b.settled) - Number(a.settled) || a.gap - b.gap);
  const usedM = new Set<number>();
  const usedR = new Set<number>();
  const out = new Map<number, string | null>();
  for (const p of pairs) {
    if (usedM.has(p.m) || usedR.has(p.r)) continue;
    usedM.add(p.m);
    usedR.add(p.r);
    out.set(movements[p.m].id, receipts[p.r].comment);
  }
  return out;
}

function load(storage: Storage): Record<string, string> {
  try {
    const raw = storage.getItem(LN_COMMENTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function save(storage: Storage, entries: Record<string, string>): void {
  const keys = Object.keys(entries);
  const kept = keys.length > LN_COMMENTS_MAX ? Object.fromEntries(keys.slice(keys.length - LN_COMMENTS_MAX).map((k) => [k, entries[k]])) : entries;
  try {
    storage.setItem(LN_COMMENTS_KEY, JSON.stringify(kept));
  } catch {
    // Storage full or blocked: the answer is just asked again next time.
  }
}

// undefined: not asked yet. null: asked, there is no comment.
export function cachedLnComment(movementId: number, storage: Storage = localStorage): string | null | undefined {
  const v = load(storage)[String(movementId)];
  return v === undefined ? undefined : v === "" ? null : v;
}

type Fetcher = () => Promise<LnReceipt[]>;

// One list serves every movement that asks within a minute.
const LIST_REMEMBER_MS = 60_000;
let listInFlight: { at: number; promise: Promise<LnReceipt[]> } | null = null;

function receiptList(fetcher: Fetcher): Promise<LnReceipt[]> {
  if (listInFlight && Date.now() - listInFlight.at < LIST_REMEMBER_MS) return listInFlight.promise;
  const entry = { at: Date.now(), promise: fetcher() };
  listInFlight = entry;
  entry.promise.catch(() => {
    if (listInFlight === entry) listInFlight = null;
  });
  return entry.promise;
}

export function resetLnCommentList(): void {
  listInFlight = null;
}

// `movements` is every candidate in the history (incoming, no Lightning hash):
// matching them all together is what keeps two payments of one amount apart.
// Every candidate that comes out of the answer is remembered, matched or not.
export async function loadLnComment(
  target: LnMovement,
  movements: readonly LnMovement[],
  fetcher: Fetcher,
  storage: Storage = localStorage,
  now: number = Date.now(),
): Promise<string | null> {
  const known = cachedLnComment(target.id, storage);
  if (known !== undefined) return known;
  const receipts = await receiptList(fetcher);
  const matched = matchLnComments(movements, receipts);
  const entries = load(storage);
  for (const m of movements) {
    // Only the sheet's own movement, once it is no longer young, is settled as
    // "none": another one without a receipt may simply be older than the
    // server's list, and a young one may not have its receipt yet.
    if (!matched.has(m.id) && (m.id !== target.id || now - m.atMs < LN_YOUNG_MS)) continue;
    delete entries[String(m.id)];
    entries[String(m.id)] = matched.get(m.id) ?? "";
  }
  save(storage, entries);
  return matched.get(target.id) ?? null;
}

export function clearLnComments(storage: Storage = localStorage): void {
  resetLnCommentList();
  try {
    storage.removeItem(LN_COMMENTS_KEY);
  } catch {
    // Nothing to clear.
  }
}

// The comment for an incoming payment, or null. `target` undefined (not such a
// payment, or the feature is off) never asks.
export function useLnComment(wallet: WalletClient, target: LnMovement | undefined, candidates: readonly LnMovement[]): string | null {
  const id = target?.id;
  const [comment, setComment] = useState<string | null>(() => (id !== undefined ? (cachedLnComment(id) ?? null) : null));
  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    void loadLnComment(target, candidates, () => fetchLnaddrReceipts(wallet)).then(
      (c) => {
        if (!cancelled) setComment(c);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
    // The movement id and the wallet decide when to ask; the candidates are read as they are then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, id]);
  return comment;
}
