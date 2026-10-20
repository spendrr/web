// How much of the wallet is sitting in a VTXO refresh round right now, split
// by whether the headline balance already counts it.
//
// The split exists because `balance().pendingInRoundSats` alone cannot answer
// that, and the answer differs per round kind. In bark, `pending_in_round` is
// the sum of every non-final round state's *output* amounts
// (`pending_round_balance` -> `RoundState::pending_balance`,
// `round/mod.rs:1844-1851,599-616`), which is NOT derived from VTXO states at
// all. Meanwhile:
//
// - an *interactive* participation locks its inputs before the round state
//   even exists (`round/mod.rs:1616`, `:1784`), so they leave `spendable` and
//   `pendingInRoundSats` is genuinely money the headline no longer shows;
// - a *delegated* participation leaves its inputs `Spendable` until the
//   server issues its round (bark 0.7.1 locks them then, `progress_delegated`),
//   so while it waits they are counted in the headline, while
//   `pendingInRoundSats` reports their post-fee value as well.
//
// So during a delegated refresh the same coins are in both numbers, and a
// note reading "+ N sats in refresh" claims money the user is already
// looking at. (This is also the most plausible explanation for the
// 2026-09-08 doubled-headline incident, which was blamed on the
// `allVtxos()` duplication: adding `pendingInRoundSats` into the headline
// double-counts exactly when the pending round is a delegated one.)
//
// Rather than guess from the aggregate, this buckets the actual participation
// inputs by their real VTXO state. Dashboard feeds it
// `wallet.pendingRoundInputVtxos()`, which in bark 0.7.1 lists only the inputs
// a round holds (wallet/roundInputs.ts): a waiting participation's coins are
// then missing from the split, under-reported rather than counted twice.

// Only the fields this module reads. The SDK's own Vtxo is assignable.
export interface RefreshingVtxo {
  readonly id: string;
  readonly amountSats: number;
  readonly state: { readonly type: string };
}

export interface RefreshingSplit {
  // In a pending round while still `Spendable`, i.e. already inside the
  // headline balance. Shown as "of which ... is in a refresh", never as a
  // "+", because adding it would show the same coins twice.
  countedInHeadlineSats: number;
  // In a pending round and no longer `Spendable`, i.e. absent from the
  // headline. This is the one the "+ ..." note is honest about.
  withheldSats: number;
}

export const NO_REFRESHING: RefreshingSplit = { countedInHeadlineSats: 0, withheldSats: 0 };

export function refreshingSplitsEqual(a: RefreshingSplit, b: RefreshingSplit): boolean {
  return a.countedInHeadlineSats === b.countedInHeadlineSats && a.withheldSats === b.withheldSats;
}

export function splitRefreshingVtxos(vtxos: readonly RefreshingVtxo[]): RefreshingSplit {
  // Deduped by id before summing: the SDK has been observed handing back
  // duplicate VTXO rows from allVtxos() (see VtxoList's own dedup in
  // Settings.tsx), and this number is displayed to the user as an exact
  // amount, so a duplicated row here would overstate it.
  const seen = new Set<string>();
  let countedInHeadlineSats = 0;
  let withheldSats = 0;
  for (const vtxo of vtxos) {
    if (!vtxo || seen.has(vtxo.id)) continue;
    seen.add(vtxo.id);
    switch (vtxo.state.type) {
      case "spendable":
        countedInHeadlineSats += vtxo.amountSats;
        break;
      // A round whose inputs are already spent or exited is over as far as
      // these coins are concerned (the outputs exist, or they left offchain
      // entirely), so neither bucket should claim them even if the round
      // state itself hasn't been cleaned up yet.
      case "spent":
      case "exited":
        break;
      default:
        withheldSats += vtxo.amountSats;
        break;
    }
  }
  return { countedInHeadlineSats, withheldSats };
}
