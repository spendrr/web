import { useEffect, useRef, useState } from "react";
import type { FiatCurrency } from "../lib/currency";
import { btcRatesUpdatedAt, formatFiat, satsToFiat } from "../lib/price";
import { localeFor, tf, useLang, useT } from "../lib/i18n";
import { useAmountEntry } from "./sheet/PaySheet";
import "./ConverterPanel.css";

const CURRENCIES: FiatCurrency[] = ["czk", "eur", "usd"];

// The Utility hub's "Převodník" tab. It used to be a bottom sheet behind a
// triple-click on the wordmark; here it is a section of the hub's page, so
// nothing of the sheet is left but its amount entry (useAmountEntry, shared
// with the pay/gift/request sheets).
//
// Two big numbers, the typed one on top and its conversion below, with a
// round swap button between them that trades their places. The list under
// them carries the remaining currencies, so no value is shown twice.
export default function ConverterPanel({
  rates,
  currency,
}: {
  rates: Record<FiatCurrency, number> | null;
  currency: FiatCurrency;
}) {
  const t = useT();
  const lang = useLang();
  const locale = localeFor(lang);
  const fmt = (n: number) => n.toLocaleString(locale);
  const rate = rates ? rates[currency] : null;
  const entry = useAmountEntry(rate, currency, fmt);
  const freshness = useFreshness();
  // Grows by half a turn per swap, so the icon always spins the same way.
  const [turns, setTurns] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  // After a swap the field holds the converted number; selecting it makes
  // the first digit typed replace it instead of landing after it.
  // Only while the field has focus: select() can focus it in some browsers,
  // and a swap alone must not open the keyboard.
  useEffect(() => {
    const input = inputRef.current;
    if (turns > 0 && input && document.activeElement === input) input.select();
  }, [turns]);

  // The keyboard opens only when the number itself is tapped, not on open
  // and not from a swap; a swap while typing keeps it open.
  const swap = () => {
    if (!entry.canSwitch) return;
    const typing = document.activeElement === inputRef.current;
    entry.switchUnit();
    setTurns((n) => n + 1);
    if (typing) inputRef.current?.focus();
  };

  const shown = entry.unit === "fiat" ? groupFiatText(entry.text) : entry.shown;

  const fiatUnit = currency.toUpperCase();
  const fromUnit = entry.unit === "sats" ? "sats" : fiatUnit;
  const toUnit = entry.unit === "sats" ? fiatUnit : "sats";
  const toValue = !rate
    ? "–"
    : entry.unit === "sats"
      ? fiatNumber(satsToFiat(entry.sats, rate), currency, locale)
      : fmt(entry.sats);

  const btc = (entry.sats / 1e8).toLocaleString(locale, { maximumFractionDigits: 8 });
  const rows: { label: string; value: string }[] = rates
    ? [
        ...CURRENCIES.filter((c) => c !== currency).map((c) => ({
          label: c.toUpperCase(),
          value: formatFiat(satsToFiat(entry.sats, rates[c]), c),
        })),
        { label: "BTC", value: `${btc} ₿` },
      ]
    : [];

  return (
    <div className="utility-hub-panel cvt-panel">
      <div className="cvt-pair">
        <div className="cvt-side">
          <span className="cvt-unit">{fromUnit}</span>
          <input
            ref={inputRef}
            className="cvt-input"
            style={{ fontSize: bigFontSize(shown.length) }}
            type="text"
            inputMode={entry.unit === "sats" ? "numeric" : "decimal"}
            autoComplete="off"
            aria-label={tf(t("Částka v {unit}"), { unit: fromUnit })}
            placeholder="0"
            value={shown}
            onChange={(e) => entry.setText(e.target.value)}
          />
        </div>
        <div className="cvt-divider">
          <button
            type="button"
            className="cvt-swap"
            onClick={swap}
            onMouseDown={keepFieldFocus}
            disabled={!entry.canSwitch}
            aria-label={t("Prohodit měny")}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" style={{ transform: `rotate(${turns * 180}deg)` }}>
              <path d="M8 4v15M4.5 15.5 8 19l3.5-3.5M16 20V5m-3.5 3.5L16 5l3.5 3.5" />
            </svg>
          </button>
        </div>
        {/* Tapping the result makes it the side you type, same as the
            swap button. */}
        <button
          type="button"
          className="cvt-side cvt-side-tap"
          onClick={swap}
          onMouseDown={keepFieldFocus}
          disabled={!entry.canSwitch}
          aria-label={t("Prohodit měny")}
        >
          <span className="cvt-unit">{toUnit}</span>
          <output className="cvt-output" style={{ fontSize: bigFontSize(toValue.length) }}>
            {toValue}
          </output>
        </button>
      </div>
      {rates ? (
        <div className="cvt-rows">
          {rows.map((r, i) => (
            <div className="cvt-row" key={r.label} style={{ ["--d" as string]: `${0.08 + i * 0.04}s` }}>
              <span className="cvt-row-label">{r.label}</span>
              <span className="cvt-row-value">{r.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <span className="cvt-rows-skeleton" aria-label={t("Načítám kurz")} />
      )}
      {rates && (
        <p className="cvt-source">
          <a href="https://www.coingecko.com" target="_blank" rel="noopener noreferrer">
            CoinGecko
          </a>
          {freshness && `, ${freshness}`}
        </p>
      )}
    </div>
  );
}

// The converted fiat amount without its symbol (the unit sits above it).
function fiatNumber(amount: number, currency: FiatCurrency, locale: string): string {
  const digits = currency === "czk" ? 0 : 2;
  return amount.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// Keeps focus (and so an open keyboard) in the amount field when a swap
// control is pressed; without it the button takes focus before its click.
function keepFieldFocus(e: React.MouseEvent) {
  e.preventDefault();
}

// The fiat amount as typed ("12345,5"), grouped like the sats side
// ("12 345,5"). Always space-grouped: the entry uses a decimal comma in both
// languages, so an English "12,345" would read back as a decimal. setText
// strips the spaces again on the next keystroke.
function groupFiatText(text: string): string {
  if (!text) return "";
  const [whole, ...rest] = text.split(",");
  const grouped = whole ? Number(whole).toLocaleString("cs-CZ", { maximumFractionDigits: 0 }) : "";
  return rest.length ? `${grouped},${rest.join("")}` : grouped;
}

// Both numbers step down together as they grow, so neither wraps.
function bigFontSize(length: number): string {
  if (length <= 7) return "56px";
  if (length <= 10) return "44px";
  if (length <= 13) return "34px";
  return "28px";
}

// "před 3 min" by CoinGecko's own timestamp, like the price sheet. Re-rendered
// every 10s, which is as fine as the wording gets past the first minute.
function useFreshness(): string | null {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, []);
  const updatedAt = btcRatesUpdatedAt();
  if (updatedAt === null) return null;
  const secs = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (secs < 10) return t("právě teď");
  if (secs < 60) return tf(t("před {n} s"), { n: secs });
  return tf(t("před {n} min"), { n: Math.floor(secs / 60) });
}
