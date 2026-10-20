// Pure sale arithmetic for the Point of Sale terminal (PosPanel.tsx), kept
// out of the component so the part that decides how much a customer is
// charged is unit-tested (tests/posSale.test.ts).
//
// The rule the old panel broke: the big number on screen and the invoice
// must be the same number. It showed only the amount being typed ("26 Kč")
// while the invoice was for everything already rung up plus that (286 Kč).
// Here there is one total, and it already includes the typed entry.

import type { FiatCurrency } from "../currency";
import { fiatToSats } from "../price";
import type { PosItem } from "./posItems";

export type Rates = Record<FiatCurrency, number>;

// An ad-hoc amount rung up from the keypad, in the currency active when it
// was typed.
export interface CustomAmount {
  id: string;
  amount: number;
  currency: FiatCurrency;
}

export interface PosDraft {
  cart: Record<string, number>;
  custom: CustomAmount[];
  entry: string;
}

export const EMPTY_DRAFT: PosDraft = { cart: {}, custom: [], entry: "" };

// Hard ceiling on what the keypad accepts, per entry. A POS amount that
// large is a fat finger, not a sale.
const ENTRY_MAX_INT_DIGITS = 7;

export function fractionDigits(currency: FiatCurrency): number {
  return currency === "czk" ? 0 : 2;
}

// Keypad input. `entry` is a plain "1250" / "12.5" string, "." as the
// separator whatever the display locale. CZK takes no decimals at all
// (formatFiat rounds it to whole crowns, so a typed "12.50" would have been
// shown as "13 Kč" on the receipt); its keypad puts "C" (clear the whole
// sale, PosPanel) in the comma's place. "00" is still understood here: a
// CZK keypad used to have it there.
export function applyKey(entry: string, key: string, currency: FiatCurrency): string {
  if (key === "back") return entry.slice(0, -1);
  const dot = entry.indexOf(".");
  if (key === ".") {
    if (fractionDigits(currency) === 0 || dot !== -1) return entry;
    return entry === "" ? "0." : entry + ".";
  }
  if (key !== "00" && !/^[0-9]$/.test(key)) return entry;
  let next = entry;
  for (const digit of key) {
    if (next === "" && digit === "0" && key === "00") return entry;
    if (dot !== -1) {
      if (next.length - dot > fractionDigits(currency)) return next;
    } else if (next.replace(/^0+/, "").length >= ENTRY_MAX_INT_DIGITS && next !== "0") {
      return next;
    }
    next = next === "0" ? digit : next + digit;
  }
  return next;
}

export function entryValue(entry: string): number {
  const value = Number(entry);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// Price in `from` expressed in `to`. Exact (no rate needed) when the two
// match, so a single-currency shop never sees conversion drift. null when a
// rate it actually needs is missing.
export function convertFiat(amount: number, from: FiatCurrency, to: FiatCurrency, rates: Rates | null): number | null {
  if (from === to) return amount;
  if (!rates || !(rates[from] > 0) || !(rates[to] > 0)) return null;
  return (amount * rates[to]) / rates[from];
}

export interface ReceiptLine {
  key: string;
  label: string;
  qty: number;
  // Line total in the line's own currency, and in the till's currency.
  amount: number;
  currency: FiatCurrency;
  converted: number | null;
  itemId?: string;
  customId?: string;
}

export function receiptLines(
  draft: PosDraft,
  items: PosItem[],
  currency: FiatCurrency,
  rates: Rates | null,
  customLabel: string,
): ReceiptLine[] {
  const lines: ReceiptLine[] = [];
  for (const item of items) {
    const qty = draft.cart[item.id] ?? 0;
    if (qty <= 0) continue;
    const amount = item.price * qty;
    lines.push({
      key: `i:${item.id}`,
      label: item.name,
      qty,
      amount,
      currency: item.currency,
      converted: convertFiat(amount, item.currency, currency, rates),
      itemId: item.id,
    });
  }
  for (const custom of draft.custom) {
    lines.push({
      key: `c:${custom.id}`,
      label: customLabel,
      qty: 1,
      amount: custom.amount,
      currency: custom.currency,
      converted: convertFiat(custom.amount, custom.currency, currency, rates),
      customId: custom.id,
    });
  }
  return lines;
}

// The one number the customer is charged, in the till's currency: every
// receipt line plus whatever is still on the keypad. null if some line's
// currency can't be converted right now (no rates).
export function saleTotal(lines: ReceiptLine[], entry: string): number | null {
  let total = entryValue(entry);
  for (const line of lines) {
    if (line.converted === null) return null;
    total += line.converted;
  }
  return total;
}

export function totalSats(total: number | null, currency: FiatCurrency, rates: Rates | null): number {
  if (total === null || total <= 0 || !rates || !(rates[currency] > 0)) return 0;
  return fiatToSats(total, rates[currency]);
}

// Shown to the payer by their wallet as the invoice description, so they
// can see what they are paying for. Kept short: it lives in the bolt11
// string, and a longer one makes a denser QR.
export const DESCRIPTION_MAX = 80;

export function saleDescription(lines: ReceiptLine[], formatAmount: (amount: number, currency: FiatCurrency) => string): string {
  const parts = lines.map((line) =>
    line.customId ? formatAmount(line.amount, line.currency) : line.qty > 1 ? `${line.label} ×${line.qty}` : line.label,
  );
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const next = out ? `${out}, ${parts[i]}` : parts[i];
    if (next.length > DESCRIPTION_MAX) {
      const rest = parts.length - i;
      const suffix = ` +${rest}`;
      return out ? out + suffix : parts[i].slice(0, DESCRIPTION_MAX - 1) + "…";
    }
    out = next;
  }
  return out;
}

// Keypad entry for display: "1250.5" -> "1 250,5" with the thousands
// grouping and comma the rest of the app's fiat amounts use (formatFiat is
// always cs-CZ). A trailing separator the user just typed stays visible.
export function formatEntry(entry: string): string {
  if (!entry) return "0";
  const [int, frac] = entry.split(".");
  const grouped = Number(int || "0").toLocaleString("cs-CZ", { maximumFractionDigits: 0 });
  return frac === undefined ? grouped : `${grouped},${frac}`;
}
