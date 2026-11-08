// Size steps for a large sats amount in the payment detail sheet. Same
// thresholds and factors as the headline balance (balanceScaleClass in
// Dashboard.tsx), so a big amount reads the same in both places.
export function amountScaleClass(sats: number): string {
  const n = Math.abs(sats);
  if (n >= 100_000_000) return " txd-amount--scale-100m";
  if (n >= 10_000_000) return " txd-amount--scale-10m";
  if (n >= 1_000_000) return " txd-amount--scale-1m";
  if (n >= 100_000) return " txd-amount--scale-100k";
  return "";
}
