export type FiatCurrency = "czk" | "eur" | "usd";

const STORAGE_KEY = "btc-wallet-currency";

// First-run default is EUR (paired with the English UI default, see i18n.ts).
// CZK stays available via the currency toggle in Settings.
export function getFiatCurrency(): FiatCurrency {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "eur" || v === "usd" || v === "czk" ? v : "eur";
}

export function setFiatCurrency(currency: FiatCurrency): void {
  localStorage.setItem(STORAGE_KEY, currency);
}
