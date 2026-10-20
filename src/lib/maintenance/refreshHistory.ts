// How VTXO refreshes show up in the history, and how the Ark receive watcher
// finds a new payment among them. Agreed with the user 2026-09-26:
// - a free refresh never appears in the history (only in Settings → VTXO
//   mince → Automatická obnova → Deník): it moves no money, and at 0 sats it
//   used to read as an incoming "+0 sats";
// - a failed one neither: nothing was charged and nothing changed;
// - a paid one stays, as "Obnova mincí −N sats", tagged while it's pending.
//
// A refresh Movement (bark-0.7.0) is subsystemKind "refresh" with
// effectiveBalanceSats = -fee (0 or negative, never positive), set when it is
// created and never changed, and status pending → successful | failed.

// Only the fields read here; the SDK's Movement is assignable.
export interface HistoryMovement {
  readonly id: number;
  readonly subsystemKind: string;
  readonly status: string;
  readonly effectiveBalanceSats: number;
}

export function isRefreshMovement(m: HistoryMovement): boolean {
  return m.subsystemKind === "refresh" || m.subsystemKind === "round";
}

export function hiddenFromHistory(m: HistoryMovement): boolean {
  if (!isRefreshMovement(m)) return false;
  return m.status === "failed" || m.status === "canceled" || m.effectiveBalanceSats >= 0;
}

// The newest incoming payment the watcher hasn't announced yet. It used to
// take history[0] and compare ids with !==, so (a) a refresh created in the
// same cycle, right after a payment arrived, sat on top and the payment was
// never announced, and (b) whatever movement was newest got stored as "seen",
// which with "newest positive" and !== would re-announce an old payment.
// Ids are monotonic, so "newer than the last one seen" is a plain >.
export function newestUnseenIncoming<M extends HistoryMovement>(
  history: readonly M[],
  lastSeenId: number | null,
): M | undefined {
  let best: M | undefined;
  for (const m of history) {
    if (m.effectiveBalanceSats <= 0) continue;
    if (lastSeenId !== null && m.id <= lastSeenId) continue;
    if (!best || m.id > best.id) best = m;
  }
  return best;
}

// The high-water mark to remember after looking at `history`: its highest id,
// or the previous mark when history is empty.
export function highestMovementId(history: readonly HistoryMovement[], previous: number | null): number | null {
  let max = previous;
  for (const m of history) if (max === null || m.id > max) max = m.id;
  return max;
}

