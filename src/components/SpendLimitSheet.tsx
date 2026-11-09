import { useMemo, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import type { FiatCurrency } from "../lib/currency";
import { niceFiat } from "../lib/send/fiatDisplay";
import { acceptLimitText, parseLimitAmount } from "../lib/send/limitAmount";
import { fiatToSats, satsToFiat } from "../lib/price";
import { MAX_LIMIT_SATS, applyChange, type SpendLimits } from "../lib/wallet/spendLimits";
import { Collapse, Screen, Sheet, WaitingDots, useSheetClose } from "./sheet/PaySheet";
import "./SpendLimitSheet.css";

export type LimitKind = "noPassword" | "hard";

// Quick picks under the field. Fiat when the price is known, otherwise sats.
const PRESETS: Record<LimitKind, { fiat: Record<FiatCurrency, number[]>; sats: number[] }> = {
  noPassword: {
    fiat: { eur: [10, 20, 50, 100, 200], usd: [10, 20, 50, 100, 200], czk: [250, 500, 1000, 2500, 5000] },
    sats: [10000, 25000, 50000, 100000, 250000],
  },
  hard: {
    fiat: { eur: [50, 100, 200, 500, 1000], usd: [50, 100, 200, 500, 1000], czk: [1000, 2500, 5000, 10000, 25000] },
    sats: [100000, 250000, 500000, 1000000, 2500000],
  },
};

interface Props {
  kind: LimitKind;
  limits: SpendLimits;
  now: number;
  currency: FiatCurrency;
  // fiat per BTC, null when the price is not known (the amount is then typed in sats)
  btcRate: number | null;
  // null = saved, otherwise the message to show. `sats` null switches the daily limit off.
  onSave: (sats: number | null, password: string) => Promise<string | null>;
  onClose: () => void;
}

// The current value as the field would show it: fiat to the cent when it has one, whole otherwise.
function initialText(sats: number | null, rate: number | null): string {
  if (sats === null) return "";
  const group = new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 2 });
  if (rate === null) return group.format(sats);
  const v = niceFiat(satsToFiat(sats, rate));
  return group.format(v >= 10 ? Math.round(v) : Math.round(v * 100) / 100);
}

export function SpendLimitSheet({ kind, limits, now, currency, btcRate, onSave, onClose }: Props) {
  const t = useT();
  const { closing, closeThen } = useSheetClose();
  const current = kind === "noPassword" ? limits.noPasswordSats : limits.hardSats;
  // Turning the daily limit on starts from the middle pick, so enabling it is one choice, not a blank field.
  const seedFor = (rate: number | null): string => {
    if (current === null && kind === "hard") {
      const picks = rate === null ? PRESETS.hard.sats : PRESETS.hard.fiat[currency];
      return new Intl.NumberFormat("cs-CZ").format(picks[2]);
    }
    return initialText(current, rate);
  };
  const [seedText, setSeedText] = useState(() => seedFor(btcRate));
  const [text, setText] = useState(seedText);
  const [off, setOff] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // Set synchronously, so a second Enter in the same render cannot start another save.
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  // The field is typed in the unit known when it opened. If the price arrives (or goes) while the sheet is open, the
  // same digits would be read in the other unit ("250 000" sats as 250 000 Kč): start the field over in the new one.
  const unit = btcRate === null ? "sats" : "fiat";
  const [seededUnit, setSeededUnit] = useState(unit);
  if (seededUnit !== unit) {
    const seed = seedFor(btcRate);
    setSeededUnit(unit);
    setSeedText(seed);
    setText(seed);
    setOff(false);
    setPassword("");
    setError(null);
  }

  const symbol = btcRate === null ? "sats" : { eur: "€", usd: "$", czk: "Kč" }[currency];
  const allowDecimals = btcRate !== null;
  // A long amount steps the figures down so number, unit and the sats line always fit one field.
  const amountSize = (off ? 0 : text.length) <= 6 ? 40 : text.length <= 9 ? 34 : 26;
  const parsed = parseLimitAmount(text, allowDecimals);
  const typed = parsed ?? 0;
  const typedOk = parsed !== null && parsed > 0;
  const rawSats = typedOk ? Math.round(btcRate === null ? typed : fiatToSats(typed, btcRate)) : null;
  // An amount that rounds to no sats at all is not a limit; neither is one that cannot be held.
  const satsOk = rawSats !== null && rawSats >= 1 && rawSats <= MAX_LIMIT_SATS;
  const unusable = typedOk && !satsOk;
  const sats = off ? null : satsOk ? rawSats : undefined;

  const result = useMemo(() => {
    if (sats === undefined) return null;
    return applyChange(limits, kind === "noPassword" ? { kind: "noPassword", sats: sats ?? 0 } : { kind: "hard", sats }, now);
  }, [limits, kind, sats, now]);

  // The field shows the stored limit rounded for reading ("4 996 Kč" opens as "5 000"). Untouched, it is still the
  // stored limit: comparing the rounded text's sats with it would call an unedited sheet a change.
  const untouched = current !== null && !off && text === seedText;
  const unchanged = untouched || sats === current;
  // Nothing is asked or refused for a limit that is not being changed.
  const needsAuth = !unchanged && result?.ok === true && result.needsAuth;
  const reject = unchanged ? null : unusable ? t("Neplatná částka") : result?.ok === false ? (result.reason === "above-hard" ? t("Nad denním limitem") : t("Neplatná částka")) : null;
  const canSave = result?.ok === true && !unchanged && (!needsAuth || password !== "") && !busy && !closing;

  const save = async () => {
    if (!canSave || sats === undefined || savingRef.current) return;
    savingRef.current = true;
    setBusy(true);
    setError(null);
    let message: string | null;
    try {
      message = await onSave(sats, needsAuth ? password : "");
    } catch {
      message = t("Uložení se nezdařilo");
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
    if (message === null) closeThen(onClose);
    else setError(message);
  };

  const nf = new Intl.NumberFormat("cs-CZ");
  const shownSats = untouched ? current : sats;
  const intro = kind === "noPassword" ? t("Od ní se chce heslo. Platby pod ní se sčítají za 24 h.") : t("Strop všech odeslaných plateb za 24 h, i s heslem.");
  const nowText = current === null ? null : btcRate === null ? `${nf.format(current)} sats` : `${initialText(current, btcRate)} ${symbol}`;
  const note = unchanged
    ? nowText === null
      ? t("Denní limit je vypnutý.")
      : `${t("Teď platí")} ${nowText}.`
    : kind === "noPassword"
      ? needsAuth
        ? t("Zvýšení chce heslo.")
        : t("Snížení platí hned.")
      : needsAuth
        ? t("Změna se projeví za 24 h, do té doby platí dnešní limit.")
        : t("Platí hned. Blokuje i s heslem.");

  return (
    <Sheet closing={closing} onBackdrop={busy ? undefined : () => closeThen(onClose)} screenKey="edit" className="limit-sheet">
      <Screen className="limit-stack">
        <div className="limit-head">
          <h2 className="limit-title">{kind === "noPassword" ? t("Částka bez hesla") : t("Denní limit")}</h2>
          {kind === "hard" && limits.hardSats !== null && (
            <button type="button" className="limit-inline" disabled={busy} onClick={() => setOff(!off)}>
              {off ? t("Ponechat limit") : t("Vypnout limit")}
            </button>
          )}
        </div>
        <p className="limit-sub">{intro}</p>

        <label className={`limit-field${off ? " is-off" : ""}`} style={{ ["--amount-size" as string]: `${amountSize}px` }}>
          <span className="limit-field-main">
            <span className="limit-size">
              <span className="limit-size-ghost" aria-hidden="true">
                {off ? t("vypnuto") : text || "0"}
              </span>
              <input
                className="limit-field-input"
                inputMode="decimal"
                autoComplete="off"
                value={off ? "" : text}
                placeholder={off ? t("vypnuto") : "0"}
                disabled={off || busy}
                onChange={(e) => {
                  setText((prev) => acceptLimitText(e.target.value, prev, allowDecimals));
                  setError(null);
                }}
                onKeyDown={(e) => e.key === "Enter" && void save()}
                maxLength={16}
                aria-label={kind === "noPassword" ? t("Částka bez hesla") : t("Denní limit")}
              />
            </span>
            {!off && <span className="limit-field-unit">{symbol}</span>}
          </span>
          <span className="limit-field-sats">{shownSats != null && btcRate !== null ? `≈ ${nf.format(shownSats)} sats` : ""}</span>
        </label>

        {!off && (
          <div className="limit-chips" role="group" aria-label={t("Rychlá volba")}>
            {(btcRate === null ? PRESETS[kind].sats : PRESETS[kind].fiat[currency]).map((v) => (
              <button
                key={v}
                type="button"
                className={`limit-chip${typedOk && typed === v ? " is-on" : ""}`}
                aria-label={`${nf.format(v)} ${symbol}`}
                disabled={busy}
                onClick={() => {
                  setText(nf.format(v));
                  setError(null);
                }}
              >
                {nf.format(v)}
              </button>
            ))}
          </div>
        )}

        <p className={`limit-note${reject ? " is-danger" : ""}`}>{reject ?? note}</p>

        <Collapse open={needsAuth}>
          <label className="limit-pw">
            <input
              className="limit-pw-input"
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && void save()}
              placeholder={t("Heslo")}
              aria-label={t("Heslo")}
              disabled={busy}
            />
          </label>
        </Collapse>

        {error && <p className="limit-note is-danger">{error}</p>}

        <div className="sht-actions limit-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => closeThen(onClose)}>
            {t("Zpět")}
          </button>
          <button type="button" className="primary" disabled={!canSave} onClick={() => void save()}>
            {busy ? (
              <span className="sht-waiting">
                {t("Ukládám")}
                <WaitingDots />
              </span>
            ) : off ? (
              t("Vypnout")
            ) : (
              t("Uložit")
            )}
          </button>
        </div>
      </Screen>
    </Sheet>
  );
}
