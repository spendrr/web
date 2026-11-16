// How much of the wallet is sitting in a VTXO refresh round right now, split
// by whether the VTXO is still Spendable.
//
// bark 0.8 counts every VTXO in one balance field only: `pendingInRoundSats` is
// the locked inputs of a round (headlineSats adds it to the headline). A
// delegated participation that still waits for its round locks nothing, so its
// coins stay Spendable, are inside `spendableSats` and are not in
// `pendingInRoundSats`. This module buckets the real participation inputs
// (`wallet.pendingRoundInputVtxos()`) by their actual state, for the notes
// that say which half is which:
//
// - Spendable: still in the headline and payable, but a round will take them.
// - locked: in the headline through `pendingInRoundSats`, not payable until the
//   round ends.
//
// (bark 0.7 counted a waiting delegated refresh in both numbers, which is why
// the two were never summed there. wallet/roundInputs.ts still lists a waiting
// participation's inputs from the round movements, because
// pendingRoundInputVtxos() lists only issued rounds' inputs.)

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
