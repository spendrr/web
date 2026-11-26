// Tip (dýško) for the Pokladna: an optional step the customer sees after
// "Účtovat", before the invoice exists. It has to come first: a Lightning
// invoice is for a fixed amount, so a tip added later would mean a second
// invoice.

import type { FiatCurrency } from "../currency";
import { fractionDigits, MAX_SALE_TOTAL } from "./posSale";

const STORAGE_KEY = "btc-wallet-pos-tips";

export const TIP_PERCENTS = [5, 10, 15] as const;

// Off unless the merchant turns it on in the price list editor: without it
// charging stays one tap.
export function loadTipsEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveTipsEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode or a full quota: the switch just does not stick.
  }
}

// A percentage of the sale, rounded to the currency's smallest unit the till
// uses (whole koruny, cents), so the total never shows half a koruna.
export function tipAmount(total: number, percent: number, currency: FiatCurrency): number {
  if (!(total > 0) || !(percent > 0)) return 0;
  const scale = 10 ** fractionDigits(currency);
  return Math.round((total * percent * scale) / 100) / scale;
}

// Sum in the same units, without float noise (0.1 + 0.2).
export function addTip(total: number, tip: number, currency: FiatCurrency): number {
  const scale = 10 ** fractionDigits(currency);
  return Math.round((total + tip) * scale) / scale;
}

// Whether a tip keeps the sale within the till's limit.
export function tipFits(total: number, tip: number, currency: FiatCurrency): boolean {
  return tip >= 0 && addTip(total, tip, currency) <= MAX_SALE_TOTAL;
}

// Appended to the invoice description, so the merchant sees it in the
// history too: "Espresso ×2, dýško 10 %" or just "dýško".
export function describeWithTip(summary: string, tipNote: string): string {
  if (!tipNote) return summary;
  return summary ? `${summary}, ${tipNote}` : tipNote;
}
