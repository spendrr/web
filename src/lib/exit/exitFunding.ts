// Whether the confirmed onchain balance covers the exit's CPFP fees.
//
// bark 0.8 prices the estimate by weight arithmetic and no longer syncs or
// reads the onchain wallet; its `fundable` is deprecated and reflects the last
// synced balance, which can be stale right after a top-up. So the app syncs the
// onchain wallet itself and compares the balance with `exitBroadcastFeeSats`
// (already scaled by bark's fee margin). `fallback` is the SDK's own flag, used
// only when the balance could not be read.
export function exitFundable(neededSats: number, onchainConfirmedSats: number | null, fallback: boolean): boolean {
  if (onchainConfirmedSats === null) return fallback;
  return onchainConfirmedSats >= neededSats;
}
