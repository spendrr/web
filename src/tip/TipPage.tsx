import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import Avatar from "../components/Avatar";
import { useCopyLink } from "../components/sheet/ShareLink";
import { getFiatCurrency, type FiatCurrency } from "../lib/currency";
import { useT } from "../lib/i18n";
import { NAME_DOMAIN } from "../lib/names/handle";
import { payName } from "./path";
import { lookupName, type LookupOutcome } from "../lib/names/names";
import { fetchBtcRates, formatFiat, satsToFiat } from "../lib/price";
import {
  TIP_MAX_SATS,
  TIP_MIN_SATS,
  parseTipAmount,
  requestTipInvoice,
  satsForFiat,
  tipSettled,
  type TipInvoice,
} from "../lib/names/tipInvoice";

// Standalone page for sending a named Spendrr user a Lightning payment
// (spendrr.app/tip/<name>, /donate): pick an amount, scan the invoice, see it
// settle. It never touches a wallet or the SDK; the invoice comes from the same
// LNURL callback any Lightning wallet uses, so the Worker's limiters and
// ledger caps apply as for any payer.

const POLL_MS = 3000;
const POLL_GIVE_UP_MS = 10 * 60 * 1000;

type Step =
  | { kind: "pick" }
  | { kind: "loading" }
  | { kind: "invoice"; sats: number; fiat: string | null; invoice: TipInvoice; paid: boolean };

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12h12" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M13 7l5 5-5 5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg viewBox="1 3 22 19" aria-hidden="true">
      <path d="M12 20.5s-7.5-4.6-9.3-9.2C1.5 8 3.4 5 6.6 5c2 0 3.6 1.1 5.4 3.1C13.8 6.1 15.4 5 17.4 5c3.2 0 5.1 3 3.9 6.3-1.8 4.6-9.3 9.2-9.3 9.2z" />
    </svg>
  );
}

function Pill({
  children,
  primary,
  ...rest
}: { children: ReactNode; primary?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={`tip-pill${primary ? " tip-pill--primary" : ""} ${rest.className ?? ""}`}
    >
      {primary && (
        <span className="tip-pill-icon">
          <ArrowIcon />
        </span>
      )}
      <span className="tip-pill-label">{children}</span>
    </button>
  );
}

export default function TipPage({ name }: { name: string }) {
  const t = useT();
  // Set by the picker while an invoice is showing: the header then offers a way back.
  const [back, setBack] = useState<(() => void) | null>(null);
  // A function passed straight to setState would be run as an updater, so it is wrapped.
  const offerBack = useCallback((fn: (() => void) | null) => setBack(() => fn), []);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<LookupOutcome | null>(null);

  // The name the invoice is asked from; differs from `name` only for an alias (see path.ts).
  const payAs = payName(name);
  useEffect(() => {
    if (!payAs) return;
    let cancelled = false;
    lookupName(payAs).then((r) => {
      if (!cancelled) setResult(r);
    });
    return () => {
      cancelled = true;
    };
  }, [payAs, attempt]);

  let body;
  if (!name || result?.kind === "absent" || (result?.kind === "found" && !result.lnAddress)) {
    // A name nobody holds is most likely a typo in the link; a name without Lightning is a real name that cannot be paid here.
    const unknown = !name || result?.kind === "absent";
    body = (
      <>
        <h1 className="tip-name">{name ? `@${name}` : t("Poslat bitcoin")}</h1>
        <p className="tip-note">
          {unknown ? t("Takové jméno nikdo nemá. Zkontroluj překlepy.") : t("Tahle adresa nepřijímá Lightning platby.")}
        </p>
      </>
    );
  } else if (result === null) {
    body = (
      <>
        <h1 className="tip-name">{name}</h1>
        <p className="tip-note">{t("Načítám…")}</p>
      </>
    );
  } else if (result.kind === "error") {
    body = (
      <>
        <h1 className="tip-name">{name}</h1>
        <p className="tip-note">{t("Jméno se nepodařilo načíst. Zkontroluj připojení a zkus to znovu.")}</p>
        <Pill
          primary
          onClick={() => {
            setResult(null);
            setAttempt((n) => n + 1);
          }}
        >
          {t("Zkusit znovu")}
        </Pill>
      </>
    );
  } else {
    body = <Picker name={name} payAs={result.name} address={result.address} onBackChange={offerBack} />;
  }

  return (
    <div className="tip">
      <header className="tip-top">
        <div className="tip-top-left">
          {back && (
            <button type="button" className="tip-back" onClick={back} aria-label={t("Jiná částka")}>
              <ArrowIcon />
            </button>
          )}
          <a className="tip-brand" href="/learn" aria-label="Spendrr">
            Spend<span className="tip-r tip-r1">r</span>
            <span className="tip-r tip-r2">r</span>
          </a>
        </div>
        <a className="tip-pill tip-pill--small" href="/">
          <span className="tip-pill-label">{t("Otevřít")}</span>
        </a>
      </header>
      <main className="tip-main">
        <div className="tip-col">{body}</div>
      </main>
      <p className="tip-foot">
        {t("Platbu přijme a hned pošle dál služba Spendrr. Nemůže ji utratit ani přesměrovat, ale vidí její výši.")}
      </p>
    </div>
  );
}

type Unit = FiatCurrency | "sat";
const UNITS: Unit[] = ["eur", "czk", "usd", "sat"];
// After the number on the preset buttons, so "5" reads as five euros, not five of something.
const SYMBOL: Record<Unit, string> = { eur: "€", usd: "$", czk: "Kč", sat: "" };
const START: Record<Unit, string> = { eur: "5", czk: "100", usd: "5", sat: "5000" };
const PRESETS: Record<Unit, string[]> = {
  eur: ["2", "5", "10"],
  czk: ["50", "100", "250"],
  usd: ["2", "5", "10"],
  sat: ["1000", "5000", "21000"],
};

// Digits only, plus one decimal separator for money; spaces and anything else are dropped as typed.
function cleanAmount(raw: string, wholeOnly: boolean): string {
  const kept = raw.replace(wholeOnly ? /[^0-9]/g : /[^0-9.,]/g, "");
  if (wholeOnly) return kept;
  const i = kept.search(/[.,]/);
  return i === -1 ? kept : kept.slice(0, i + 1) + kept.slice(i + 1).replace(/[.,]/g, "");
}

function Picker({
  name,
  payAs,
  address,
  onBackChange,
}: {
  name: string;
  payAs: string;
  address: string;
  onBackChange: (back: (() => void) | null) => void;
}) {
  const t = useT();
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [unit, setUnit] = useState<Unit>(getFiatCurrency());
  const [amount, setAmount] = useState(START[getFiatCurrency()]);
  const [rates, setRates] = useState<Awaited<ReturnType<typeof fetchBtcRates>> | null>(null);
  const [ratesFailed, setRatesFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pop, setPop] = useState(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    let cancelled = false;
    fetchBtcRates().then(
      (r) => !cancelled && setRates(r),
      () => !cancelled && setRatesFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Without a price the page still works in sats; the fiat units just step aside.
  const units = ratesFailed ? (["sat"] as Unit[]) : UNITS;
  const activeUnit: Unit = ratesFailed ? "sat" : unit;
  const sats = activeUnit === "sat" ? parseTipAmount(amount) : rates ? satsForFiat(amount, rates[activeUnit]) : null;

  const choose = (nextUnit: Unit, nextAmount: string) => {
    setUnit(nextUnit);
    setAmount(nextAmount);
    setError(null);
    setPop((n) => n + 1);
  };

  const create = async () => {
    if (sats === null) return;
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setError(null);
    setStep({ kind: "loading" });
    const r = await requestTipInvoice(payAs, sats, ctl.signal);
    if (ctl.signal.aborted) return;
    if (!r.ok) {
      setError(r.reason ?? t("Fakturu se nepodařilo vytvořit."));
      setStep({ kind: "pick" });
      return;
    }
    const typed = Number(amount.replace(",", "."));
    setStep({
      kind: "invoice",
      sats,
      fiat: activeUnit !== "sat" && Number.isFinite(typed) ? formatFiat(typed, activeUnit) : null,
      invoice: r.invoice,
      paid: false,
    });
  };

  const invoiceOpen = step.kind === "invoice";
  useEffect(() => {
    onBackChange(invoiceOpen ? () => setStep({ kind: "pick" }) : null);
    return () => onBackChange(null);
  }, [invoiceOpen, onBackChange]);

  const busy = step.kind === "loading";
  const outOfRange = amount !== "" && sats === null && (activeUnit === "sat" || rates !== null);
  // The allowed range in the unit the visitor is typing, not always in sats.
  const rangeText =
    activeUnit === "sat" || !rates
      ? `${TIP_MIN_SATS.toLocaleString("cs-CZ")} ${t("až")} ${TIP_MAX_SATS.toLocaleString("cs-CZ")} sat`
      : `${formatFiat(satsToFiat(TIP_MIN_SATS, rates[activeUnit]), activeUnit)} ${t("až")} ${formatFiat(
          satsToFiat(TIP_MAX_SATS, rates[activeUnit]),
          activeUnit,
        )}`;

  return (
    <>
      <div className={`tip-to${step.kind === "invoice" ? " is-center" : ""}`}>
        {/* An alias (/donate) is not a person: a heart instead of the holder's avatar. */}
        <span className={`tip-avatar${payAs !== name ? " tip-avatar--heart" : ""}`}>
          {payAs !== name ? <HeartIcon /> : <Avatar seed={address} size={52} />}
        </span>
        <div>
          <span className="tip-to-label">{t("Pro")}</span>
          <h1 className="tip-name">
            {name}
            <span className="tip-domain">@{NAME_DOMAIN}</span>
          </h1>
        </div>
      </div>
      {step.kind === "invoice" ? (
        <InvoiceView
          sats={step.sats}
          fiat={step.fiat}
          invoice={step.invoice}
          paid={step.paid}
          onPaid={() => setStep({ ...step, paid: true })}
          onBack={() => setStep({ kind: "pick" })}
        />
      ) : (
        <form
          className="tip-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className={`tip-amount${pop > 0 ? " is-pop" : ""}`} key={pop}>
            <span className="tip-amount-field">
              <span className="tip-amount-ghost" aria-hidden="true">
                {amount || "0"}
              </span>
              <input
                className="tip-amount-input"
                type="text"
                inputMode={activeUnit === "sat" ? "numeric" : "decimal"}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                maxLength={7}
                value={amount}
                onChange={(e) => {
                  setAmount(cleanAmount(e.target.value, activeUnit === "sat"));
                  setError(null);
                }}
                aria-label={t("Částka")}
                disabled={busy}
              />
            </span>
            <span className="tip-amount-unit">{activeUnit === "sat" ? "sat" : activeUnit.toUpperCase()}</span>
          </div>
          <p className="tip-sub">
            {activeUnit !== "sat" && sats !== null
              ? `≈ ${sats.toLocaleString("cs-CZ")} sat`
              : outOfRange
                ? rangeText
                : " "}
          </p>
          <div className="tip-row">
            {PRESETS[activeUnit].map((p) => (
              <button
                key={p}
                type="button"
                className={`tip-chip${amount === p ? " is-on" : ""}`}
                disabled={busy}
                onClick={() => choose(activeUnit, p)}
              >
                {Number(p).toLocaleString("cs-CZ")}
                {SYMBOL[activeUnit] && `\u00a0${SYMBOL[activeUnit]}`}
              </button>
            ))}
          </div>
          {units.length > 1 && (
            <div className="tip-units" role="group" aria-label={t("Měna")}>
              {units.map((u) => (
                <button
                  key={u}
                  type="button"
                  className={`tip-unit${u === activeUnit ? " is-on" : ""}`}
                  aria-pressed={u === activeUnit}
                  onClick={() => choose(u, START[u])}
                >
                  {u === "sat" ? "sat" : u.toUpperCase()}
                </button>
              ))}
            </div>
          )}
          {error && <p className="tip-error">{error}</p>}
          <button type="submit" className="tip-pill tip-pill--primary tip-cta" disabled={busy || sats === null}>
            <span className="tip-pill-icon">
              <ArrowIcon />
            </span>
            <span className="tip-pill-label">{busy ? t("Načítám…") : t("Poslat")}</span>
          </button>
        </form>
      )}
    </>
  );
}

function InvoiceView({
  sats,
  fiat,
  invoice,
  paid,
  onPaid,
  onBack,
}: {
  sats: number;
  fiat: string | null;
  invoice: TipInvoice;
  paid: boolean;
  onPaid: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const { copied, copy } = useCopyLink(invoice.pr);
  const onPaidRef = useRef(onPaid);
  useEffect(() => {
    onPaidRef.current = onPaid;
  }, [onPaid]);

  useEffect(() => {
    if (paid || !invoice.verify) return;
    const verify = invoice.verify;
    const ctl = new AbortController();
    const started = Date.now();
    const h = setInterval(() => {
      if (Date.now() - started > POLL_GIVE_UP_MS) {
        clearInterval(h);
        return;
      }
      void tipSettled(verify, ctl.signal).then((settled) => {
        if (settled && !ctl.signal.aborted) {
          clearInterval(h);
          onPaidRef.current();
        }
      });
    }, POLL_MS);
    return () => {
      clearInterval(h);
      ctl.abort();
    };
  }, [invoice.verify, paid]);

  return (
    <div className="tip-invoice">
      {paid ? (
        <>
          <p className="tip-paid">
            {t("Zaplaceno")}
            <span className="tip-paid-dot">.</span>
          </p>
          <p className="tip-sub">
            {sats.toLocaleString("cs-CZ")} sat. {t("Díky!")}
          </p>
        </>
      ) : (
        <>
          <div className="tip-invoice-head">
            <p className="tip-invoice-amount">
              {sats.toLocaleString("cs-CZ")}
              <span className="tip-amount-unit">sat</span>
            </p>
            {fiat && <p className="tip-sub">≈ {fiat}</p>}
          </div>
          <div className="tip-qr">
            <QRCodeSVG value={`lightning:${invoice.pr.toUpperCase()}`} size={256} />
          </div>
          <div className="tip-actions">
            <button type="button" className="tip-btn" onClick={copy}>
              {copied ? t("Zkopírováno") : t("Kopírovat")}
            </button>
            <a className="tip-btn tip-btn--accent" href={`lightning:${invoice.pr}`}>
              {t("Otevřít v peněžence")}
            </a>
          </div>
          {invoice.verify && (
            <p className="tip-sub tip-wait">
              {t("Čekám na platbu")}
              <span className="tip-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </p>
          )}
        </>
      )}
      {paid && (
        <button type="button" className="tip-textlink" onClick={onBack}>
          {t("Poslat znovu")}
        </button>
      )}
    </div>
  );
}
