// A limit is stored in sats, so its fiat value is never round: 5 000 Kč set yesterday reads 4 996 Kč after the price
// moved. Shown amounts are therefore rounded to two significant figures from 100 up ("1 619" reads "1 600"), under
// 100 they stay as they are. Display only; the stored limit is exact.
export function niceFiat(amount: number): number {
  const a = Math.abs(amount);
  if (!Number.isFinite(a) || a < 100) return amount;
  const step = 10 ** (Math.floor(Math.log10(a)) - 1);
  return Math.sign(amount) * Math.round(a / step) * step;
}
