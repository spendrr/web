import { useRef } from "react";
import { useT } from "../lib/i18n";
import { satsToFiat, fiatToSats } from "../lib/price";
import type { FiatCurrency } from "../lib/currency";
import type { SpendLimitsStatus } from "../lib/wallet/spendLimits";
import { SPEND_WINDOW_MS } from "../lib/wallet/spendLimits";
import { niceFiat } from "../lib/send/fiatDisplay";
import { QUICK_BUDGET_MULTIPLES, QUICK_STEPS_FIAT, type QuickPayState } from "../lib/send/quickPay";
import { VaultDrawing } from "./VaultDrawing";
import "./SpendLimitsPage.css";

interface Props {
  status: SpendLimitsStatus;
  // sats spent in the daily window, oldest first (for "okno se uvolní za")
  windowOldestAt: number | null;
  now: number;
  quick: QuickPayState;
  currency: FiatCurrency;
  // fiat per BTC, null when the price is not known
  btcRate: number | null;
  onQuick: (q: QuickPayState) => void;
  onEditNoPassword: () => void;
  onEditHard: () => void;
  onCancelPending: () => void;
}

// A limit is stored in sats, so its fiat value is never round: from 10 units up, whole units ("122 Kč");
// below, two decimals only when there are some ("4,80 €", "5 €").
function formatFiat(raw: number, currency: FiatCurrency): string {
  const amount = niceFiat(raw);
  const big = Math.abs(amount) >= 10;
  const whole = big || Math.abs(amount - Math.round(amount)) < 0.005;
  return new Intl.NumberFormat("cs-CZ", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(amount);
}

// The amount with its currency symbol in the accent, like the balance's "sat" on the home screen.
function FiatText({ amount: raw, currency }: { amount: number; currency: FiatCurrency }) {
  const amount = niceFiat(raw);
  const big = Math.abs(amount) >= 10;
  const whole = big || Math.abs(amount - Math.round(amount)) < 0.005;
  const parts = new Intl.NumberFormat("cs-CZ", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).formatToParts(amount);
  return (
    <>
      {parts.map((part, i) =>
        part.type === "currency" ? (
          <span key={i} className="limits-unit">
            {part.value}
          </span>
        ) : (
          part.value
        ),
      )}
    </>
  );
}

// The amount without its unit, for the cramped steps of the scale; the unit is named once in the card title.
function numFiat(raw: number): string {
  const amount = niceFiat(raw);
  const whole = Math.abs(amount) >= 10 || Math.abs(amount - Math.round(amount)) < 0.005;
  return new Intl.NumberFormat("cs-CZ", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(amount);
}

function hoursLeft(ms: number): number {
  return Math.max(1, Math.ceil(ms / 3_600_000));
}

export function SpendLimitsPage(p: Props) {
  const t = useT();
  const { limits, hardRemainingSats } = p.status;
  const fmt = (sats: number): string => (p.btcRate ? formatFiat(satsToFiat(sats, p.btcRate), p.currency) : `${sats.toLocaleString("cs-CZ")} sats`);
  const steps = QUICK_STEPS_FIAT[p.currency];
  const quickFiat = p.quick.step > 0 ? steps[p.quick.step - 1] : null;
  const quickSats = quickFiat !== null && p.btcRate ? Math.min(fiatToSats(quickFiat, p.btcRate), limits.noPasswordSats) : null;
  const hard = limits.hardSats;
  const spent = hard !== null && hardRemainingSats !== null ? hard - hardRemainingSats : 0;
  const usedPct = hard ? Math.min(100, (spent / hard) * 100) : 0;
  const freesIn = p.windowOldestAt !== null && spent > 0 ? hoursLeft(p.windowOldestAt + SPEND_WINDOW_MS - p.now) : null;

  // One scale, left to right, of what a payment of that size gets. Quick pay is absent while it is off.
  const num = (sats: number): string => (p.btcRate ? numFiat(satsToFiat(sats, p.btcRate)) : new Intl.NumberFormat("cs-CZ").format(sats));
  const unit = p.btcRate ? { eur: "€", usd: "$", czk: "Kč" }[p.currency] : "sats";
  // Every step stays in the bar; one that does not apply (quick pay off, no daily limit) collapses to nothing, so
  // switching a setting grows or shrinks the bar instead of redrawing it. A collapsing step keeps its last text.
  const zoneText = useRef<Record<string, { name: string; amount: string }>>({});
  const zones = [
    { key: "quick", name: t("Hned"), amount: quickSats !== null ? `${t("do")} ${num(quickSats)}` : null },
    { key: "confirm", name: t("Potvrdit"), amount: `${t("do")} ${num(limits.noPasswordSats)}` },
    { key: "password", name: t("Heslo"), amount: hard !== null ? `${t("do")} ${num(hard)}` : t("bez stropu") },
    { key: "stop", name: t("Stop"), amount: hard !== null ? `${t("nad")} ${num(hard)}` : null },
  ].map((z) => {
    if (z.amount !== null) zoneText.current[z.key] = { name: z.name, amount: z.amount };
    const shown = zoneText.current[z.key] ?? { name: z.name, amount: "" };
    return { key: z.key, name: shown.name, amount: shown.amount, gone: z.amount === null };
  });
  // The last quick-pay threshold, so its budget row keeps reading right while it folds away.
  const lastQuickFiat = useRef<number>(steps[1]);
  if (quickFiat !== null) lastQuickFiat.current = quickFiat;
  const budgetFiat = (quickFiat ?? lastQuickFiat.current) * QUICK_BUDGET_MULTIPLES[p.quick.budgetIdx];
  const pending = limits.pending;
  const nearly = hard !== null && usedPct >= 85;

  return (
    <div className="limits-page">
      <section className={`limits-summary limits-summary--ghost${hard === null ? " is-off" : ""}`}>
        {hard !== null && hardRemainingSats !== null ? (
          <>
            <div className="limits-summary-head">
              <div className="limits-summary-main">
                <div className="limits-summary-label">{t("Dnes zbývá")}</div>
                <div className="limits-summary-amount">
                  {p.btcRate ? (
                    <FiatText amount={satsToFiat(hardRemainingSats, p.btcRate)} currency={p.currency} />
                  ) : (
                    <>
                      {new Intl.NumberFormat("cs-CZ").format(hardRemainingSats)} <span className="limits-unit">sats</span>
                    </>
                  )}
                </div>
              </div>
              <VaultDrawing className="limits-vault" />
            </div>
            <div className={`limits-meter${nearly ? " is-high" : ""}`} role="img" aria-label={`${Math.round(usedPct)} %`}>
              <div className="limits-meter-fill" style={{ width: `${usedPct}%` }} />
            </div>
            <div className="limits-summary-line">
              <span>
                {t("Utraceno")} {fmt(spent)}
              </span>
              <span>
                {t("z")} {fmt(hard)}
              </span>
            </div>
            {freesIn !== null && <div className="limits-summary-dim">{t("Okno se uvolňuje průběžně, nejstarší platba za")} {freesIn} h</div>}
          </>
        ) : (
          <>
            <div className="limits-summary-head">
              <div className="limits-summary-main">
                <div className="limits-summary-label">{t("Denní limit")}</div>
                <div className="limits-summary-amount limits-summary-amount--off">{t("Vypnuto")}</div>
              </div>
              <VaultDrawing className="limits-vault is-off" />
            </div>
            <div className="limits-summary-dim">{t("Strop všech odeslaných plateb za 24 h.")}</div>
            <button className="secondary small limits-summary-btn" onClick={p.onEditHard}>
              {t("Zapnout")}
            </button>
          </>
        )}
      </section>

      <section className="limits-card">
        <div className="limits-head limits-head--tight">
          <h3 className="limits-card-title">{t("Při platbě")}</h3>
          <span className="limits-card-unit">{unit}</span>
        </div>
        <div className="limits-scale-bar">
          {zones.map((z) => (
            <div key={z.key} className={`limits-zone limits-zone--${z.key}${z.gone ? " is-gone" : ""}`} aria-hidden={z.gone}>
              <span className="limits-zone-name">{z.name}</span>
              <span className="limits-zone-amount">{z.amount}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="limits-card">
        <div className="limits-head">
          <h3 className="limits-card-title">{t("Rychlá platba")}</h3>
          <span key={quickFiat === null ? "off" : "on"} className="limits-head-value limits-swap">
            {quickFiat === null ? t("vypnuto") : `${t("do")} ${formatFiat(quickFiat, p.currency)}`}
          </span>
        </div>
        <StepSlider
          value={p.quick.step}
          labels={[t("vyp"), ...steps.map((v) => new Intl.NumberFormat("cs-CZ").format(v))]}
          onChange={(step) => p.onQuick({ ...p.quick, step })}
          ariaLabel={t("Rychlá platba")}
          disabled={p.btcRate === null}
        />
        <p key={`${p.btcRate === null}-${quickFiat === null}`} className="limits-note limits-swap">
          {p.btcRate === null
            ? t("Bez kurzu se potvrzuje každá platba.")
            : quickFiat === null
              ? t("Každá platba se potvrzuje.")
              : t("Bez potvrzení. Jen QR z kamery, bez @jmen.")}
        </p>
        <div className={`limits-collapse${quickFiat !== null ? " is-open" : ""}`} inert={quickFiat === null}>
          <div className="limits-collapse-inner">
            <div className="limits-head limits-head--sub">
              <h4 className="limits-sub">{t("Denně rychle")}</h4>
              <span className="limits-head-value">{formatFiat(budgetFiat, p.currency)}</span>
            </div>
            <StepSlider
              value={p.quick.budgetIdx}
              labels={QUICK_BUDGET_MULTIPLES.map((m) => `${m}×`)}
              onChange={(budgetIdx) => p.onQuick({ ...p.quick, budgetIdx })}
              ariaLabel={t("Denně rychle")}
            />
            <p className="limits-note">{t("Po vyčerpání se potvrzuje.")}</p>
          </div>
        </div>
      </section>

      <section className="limits-card limits-card--rows">
        <button className="limits-row" onClick={p.onEditNoPassword}>
          <span className="limits-row-text">
            <span className="limits-row-label">{t("Částka bez hesla")}</span>
            <span className="limits-row-sub">{t("Od ní se chce heslo")}</span>
          </span>
          <span className="limits-row-value">{fmt(limits.noPasswordSats)}</span>
        </button>
        <button className="limits-row" onClick={p.onEditHard}>
          <span className="limits-row-text">
            <span className="limits-row-label">{t("Denní limit")}</span>
            <span className="limits-row-sub">{t("Blokuje i s heslem, uvolnění trvá 24 h")}</span>
          </span>
          <span className={`limits-row-value${hard === null ? " is-off" : ""}`}>{hard === null ? t("vypnuto") : fmt(hard)}</span>
        </button>
        {pending && (
          <div className="limits-row limits-row--pending">
            <span className="limits-row-text">
              <span className="limits-row-label">{t("Čeká změna")}</span>
              <span className="limits-row-sub">
                {pending.hardSats === null ? t("Vypnutí") : fmt(pending.hardSats)} {t("za")} {hoursLeft(pending.effectiveAt - p.now)} h
              </span>
            </span>
            <button className="secondary small" onClick={p.onCancelPending}>
              {t("Zrušit")}
            </button>
          </div>
        )}
      </section>

      <p className="limits-foot">{t("Chrání před unáhlenou platbou.")}</p>
    </div>
  );
}

// Discrete steps, labelled under the track. The visible track and thumb are drawn here so they can glide between
// steps; the native range input sits on top, invisible, and keeps touch, keyboard and screen readers working.
function StepSlider({ value, labels, onChange, ariaLabel, disabled = false }: { value: number; labels: string[]; onChange: (v: number) => void; ariaLabel: string; disabled?: boolean }) {
  const max = labels.length - 1;
  return (
    <div className={`limits-slider${disabled ? " is-disabled" : ""}`} style={{ ["--n" as string]: max, ["--v" as string]: value }}>
      <div className="limits-slider-rail">
        <div className="limits-slider-track" />
        <div className="limits-slider-marks" aria-hidden="true">
          {labels.map((_, i) => (
            <i key={i} style={{ ["--i" as string]: i }} />
          ))}
        </div>
        <div className="limits-slider-fill" />
        <div className="limits-slider-thumb" />
        <input
          className="limits-slider-input"
          type="range"
          min={0}
          max={max}
          step={1}
          value={value}
          aria-label={ariaLabel}
          aria-valuetext={labels[value]}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
      <div className="limits-slider-ticks" aria-hidden="true">
        {labels.map((l, i) => (
          <span key={i} className={i === value ? "is-on" : ""} style={{ ["--i" as string]: i }}>
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}
