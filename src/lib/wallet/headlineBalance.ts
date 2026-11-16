// The number shown as the wallet's balance: what can be paid with plus the
// inputs locked in a refresh round. bark 0.8 counts every VTXO in exactly one
// balance field, so the two never overlap (bark 0.7 counted a waiting
// delegated refresh in both, which is why this sum was once forbidden). Without
// the locked inputs the headline would drop for the length of a refresh round
// and come back, as if money had left. Both terms come from one balance read,
// so the sum cannot show a half-updated state.
//
// Not for sending: what can be sent is `spendableSats` alone, a locked coin
// cannot be paid with.
export function headlineSats(b: { spendableSats: number; pendingInRoundSats: number }): number {
  return b.spendableSats + b.pendingInRoundSats;
}
