// Confirm screen of a send, as a sheet (V2). Presentation only: every value
// comes from the frozen SendPlan the caller hands in, and the buttons just
// call back. No state about the send lives here except the copy flash and
// the exit animation.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { FiatCurrency } from "../../lib/currency";
import { localeFor, useLang, useT } from "../../lib/i18n";
import { NAME_DOMAIN } from "../../lib/names/handle";
import { ErrorCircleIcon } from "../BannerIcons";
import Avatar from "../Avatar";
import { formatFiat, formatFiatParts, satsToFiat } from "../../lib/price";
import { Sheet, WaitingDots, useSheetClose } from "./PaySheet";
import "./SendConfirmSheet.css";

// Paper plane with a speed trail. `flying` loops the trail and lifts the
// plane along its own axis while the send is in flight.
export function SendGlyph({ flying = false }: { flying?: boolean }) {
  return (
    <svg
      className={`sht-send-glyph${flying ? " is-flying" : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <g className="sht-send-plane">
        <path d="M21.5 2.5l-6.5 19-3.6-8.4L3 9.5l18.5-7z" />
        <path d="M17.6 6.4L11.4 13.1" />
      </g>
      <path className="sht-send-trail sht-send-trail--a" d="M2.5 21.5L7 17" />
      <path className="sht-send-trail sht-send-trail--b" d="M3.5 16.5L6 14" />
      <path className="sht-send-trail sht-send-trail--c" d="M7.5 21.5L10 19" />
    </svg>
  );
}

function truncateMiddle(value: string, head = 10, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export interface SendConfirmPlan {
  // On-chain is the one kind that is slow and leaves Ark; everything else
  // (Ark, Lightning) lands in seconds. The row says what that means rather
  // than naming the protocol.
  onchain: boolean;
  // A Lightning address (name@domain) is read like an email: the domain is
  // where the money goes, so it is always shown whole; only an overlong name
  // gets an ellipsis at its end. Never cut in the middle.
  lightningAddress: boolean;
  destination: string;
  amountSats: number | undefined;
  recipient?: { name: string; address: string; changed: boolean };
  // A BIP 353 name (user@domain) whose DNSSEC-validated record `destination` came from.
  bip353?: { name: string; validUntil?: number };
}

export function SendConfirmSheet({
  plan,
  feeSats,
  feePending,
  rate,
  currency,
  amountUnit,
  needsPassword,
  password,
  onPassword,
  busy,
  ready,
  armMs,
  error,
  errorRef,
  onConfirm,
  onBack,
}: {
  plan: SendConfirmPlan;
  feeSats: number | null;
  // The estimate is still running: the fee rows show waiting dots instead of
  // appearing late and moving the sheet.
  feePending: boolean;
  rate: number | null;
  currency: FiatCurrency;
  // The unit the amount was typed in leads; the other one is the small line.
  amountUnit: "sats" | "fiat";
  needsPassword: boolean;
  password: string;
  onPassword: (value: string) => void;
  busy: boolean;
  ready: boolean;
  // Fill time of the button's arm animation; undefined when motion is off.
  armMs?: number;
  error: string | null;
  errorRef?: RefObject<HTMLDivElement | null>;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const { closing, closeThen } = useSheetClose();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copied = copyState === "copied";
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  const fmt = (n: number) => n.toLocaleString(localeFor(lang));
  // The backdrop and Zpět are dead while the send is running: backing out
  // then would hide a payment that is still in flight.
  const back = busy ? undefined : () => closeThen(onBack);
  const armStyle = armMs === undefined ? undefined : ({ "--arm-ms": `${armMs}ms` } as CSSProperties);
  const { recipient, bip353 } = plan;

  return (
    <Sheet closing={closing} onBackdrop={back} screenKey="send-confirm">
      <div className="sht-stack sht-send">
        <header className="sht-send-head">
          <SendGlyph flying={busy} />
          {recipient ? (
            <TitleSwap
              a={t("Zkontroluj platbu")}
              b={
                <>
                  {t("Platíš")} <span className="sht-send-title-name">@{recipient.name}</span>
                </>
              }
            />
          ) : bip353 && fitsTitle(bip353.name) ? (
            <TitleSwap a={t("Zkontroluj platbu")} b={<LightningTitle label={t("Platíš")} value={`\u20bf${bip353.name}`} />} />
          ) : plan.lightningAddress && fitsTitle(plan.destination) ? (
            <TitleSwap a={t("Zkontroluj platbu")} b={<LightningTitle label={t("Platíš")} value={plan.destination} />} />
          ) : (
            <h2 className="sht-send-title">{t("Zkontroluj platbu")}</h2>
          )}
        </header>
        {plan.amountSats !== undefined && (
          <SendAmount sats={plan.amountSats} rate={rate} currency={currency} fiatFirst={amountUnit === "fiat"} fmt={fmt} />
        )}
        {/* Reads off the plan only, same as the old confirm screen. */}
        <div className="sht-send-card">
          {recipient && (
            <div className="sht-send-row">
              <span className="sht-send-label">{t("Komu")}</span>
              <span className="sht-send-who">
                <Avatar seed={recipient.address} size={26} />
                <strong>
                  {recipient.name}
                  <span className="sht-send-domain">@{NAME_DOMAIN}</span>
                </strong>
              </span>
            </div>
          )}
          {bip353 && (
            <div className="sht-send-row">
              <span className="sht-send-label">{t("Komu")}</span>
              <span className="sht-send-addr">
                <LightningAddress key={bip353.name} value={bip353.name} />
              </span>
            </div>
          )}
          <button
            type="button"
            className={`sht-send-row sht-send-copy${copied ? " is-copied" : ""}`}
            aria-label={`${t("Kopírovat")}: ${plan.destination}`}
            onClick={() => {
              // Feedback follows the real outcome: a rejected write must not
              // read as "Zkopírováno" while the clipboard still holds old text.
              const settle = (state: "copied" | "failed") => {
                setCopyState(state);
                window.clearTimeout(copyTimer.current);
                copyTimer.current = window.setTimeout(() => setCopyState("idle"), 1200);
              };
              navigator.clipboard.writeText(plan.destination).then(
                () => settle("copied"),
                () => settle("failed"),
              );
            }}
          >
            <span className="sht-send-label">{recipient || bip353 ? t("Adresa") : t("Komu")}</span>
            <span className="sht-send-addr">
              {copyState !== "idle" ? (
                <code>{copied ? t("Zkopírováno") : t("Nelze zkopírovat")}</code>
              ) : plan.lightningAddress ? (
                <LightningAddress key={plan.destination} value={plan.destination} />
              ) : (
                <code>{truncateMiddle(plan.destination)}</code>
              )}
              <CopyGlyph done={copied} />
            </span>
          </button>
          <div className="sht-send-row">
            <span className="sht-send-label">{t("Doručení")}</span>
            <span className="sht-send-value">{plan.onchain ? t("desítky minut") : t("hned")}</span>
          </div>
          {(feeSats !== null || feePending) && (
            <div className="sht-send-row">
              <span className="sht-send-label">{t("Poplatek")}</span>
              <span className={`sht-send-value${feeSats === null ? " sht-send-value--wait" : ""}`}>{feeSats !== null ? `≈ ${fmt(feeSats)} sats` : <WaitingDots />}</span>
            </div>
          )}
          {/* What actually leaves the wallet. On-chain only: there the fee is
              real and sizable; a Lightning fee is a routing estimate. */}
          {plan.onchain && (feeSats !== null || feePending) && plan.amountSats !== undefined && (
            <div className="sht-send-row sht-send-row--total">
              <span className="sht-send-label">{t("Celkem")}</span>
              <span className={`sht-send-value${feeSats === null ? " sht-send-value--wait" : ""}`}>
                {feeSats !== null ? `≈ ${fmt(plan.amountSats + feeSats)} sats` : <WaitingDots />}
              </span>
            </div>
          )}
        </div>
        {recipient?.changed && (
          <p className="sht-send-note sht-send-note--danger">
            <ErrorCircleIcon />
            <span>
              {t("Adresa u tohoto jména je jiná než při tvé poslední platbě. Než pošleš, ověř s příjemcem, že si ji opravdu změnil/a.")}
            </span>
          </p>
        )}
        <p className="sht-send-note">
          <InfoGlyph />
          {/* The title already says to review; this line only adds that it is final. */}
          <span>{t("Odeslanou platbu nelze vzít zpět.")}</span>
        </p>
        {needsPassword && (
          <label className="sht-send-pw">
            <span className="sht-send-label">{t("Heslo pro velkou částku")}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => onPassword(e.target.value)}
              placeholder={t("Heslo")}
              onKeyDown={(e) => e.key === "Enter" && !busy && !closing && ready && password && onConfirm()}
            />
          </label>
        )}
        {error && (
          <p className="sht-send-note sht-send-note--danger" ref={errorRef}>
            <ErrorCircleIcon />
            <span>{error}</span>
          </p>
        )}
        <div className="sht-send-actions">
          <button
            type="button"
            className={`primary sht-wide${armMs !== undefined ? ` confirm-arm${ready ? " armed" : ""}${busy ? " sending" : ""}` : ""}`}
            style={armStyle}
            disabled={busy || closing || !ready || (needsPassword && !password)}
            onClick={onConfirm}
          >
            {busy ? (
              <span className="sht-waiting">
                {t("Odesílám")}
                <WaitingDots />
              </span>
            ) : (
              t("Potvrdit a odeslat")
            )}
          </button>
          <button type="button" className="sht-link" disabled={busy} onClick={back}>
            {t("Zpět")}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

// The amount the way it was typed: sats big with fiat below, or the other
// way round. The sats line is the exact amount sent; fiat is at today's rate.
function SendAmount({
  sats,
  rate,
  currency,
  fiatFirst,
  fmt,
}: {
  sats: number;
  rate: number | null;
  currency: FiatCurrency;
  fiatFirst: boolean;
  fmt: (n: number) => string;
}) {
  const fiat = rate !== null && sats > 0 ? satsToFiat(sats, rate) : null;
  if (fiatFirst && fiat !== null) {
    const { value, symbol, symbolFirst } = formatFiatParts(fiat, currency);
    // "$" or "€" is one glyph and vanishes at the unit size that suits "Kč".
    const unitClass = symbol.length === 1 ? "sht-send-unit sht-send-unit--glyph" : "sht-send-unit";
    return (
      <div className="sht-send-amount">
        <div className="sht-send-sats">
          {symbolFirst && <span className={unitClass}>{symbol}</span>}
          {value}
          {!symbolFirst && <span className={unitClass}>{symbol}</span>}
        </div>
        <div className="sht-send-fiat">{fmt(sats)} sats</div>
      </div>
    );
  }
  return (
    <div className="sht-send-amount">
      <div className="sht-send-sats">
        {fmt(sats)}
        <span className="sht-send-unit">sats</span>
      </div>
      {fiat !== null && <div className="sht-send-fiat">≈ {formatFiat(fiat, currency)}</div>}
    </div>
  );
}

// Once, on open: the title turns into who is being paid and back. Both lines
// are measured and the title's height eases between them in step with the
// cross-fade, so a two-line "Platíš @long-name" never leaves a gap around the
// one-line title.
function TitleSwap({ a, b }: { a: string; b: ReactNode }) {
  const aRef = useRef<HTMLSpanElement>(null);
  const bRef = useRef<HTMLSpanElement>(null);
  const [heights, setHeights] = useState<[number, number] | null>(null);
  useLayoutEffect(() => {
    const elA = aRef.current;
    const elB = bRef.current;
    if (!elA || !elB) return;
    const measure = () => setHeights([elA.offsetHeight, elB.offsetHeight]);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(elA);
    ro.observe(elB);
    return () => ro.disconnect();
  }, []);
  const style = heights
    ? ({ "--ha": `${heights[0]}px`, "--hb": `${heights[1]}px` } as CSSProperties)
    : undefined;
  return (
    <h2 className="sht-send-title sht-send-title--swap" style={style}>
      <span ref={aRef} className="sht-send-title-a">
        {a}
      </span>
      <span ref={bRef} className="sht-send-title-b" aria-hidden="true">
        {b}
      </span>
    </h2>
  );
}

// The title shows "Platíš" over the address at title size. When the whole
// address does not fit one line, the domain drops to its own smaller line and
// the name keeps the title size. Longer than these (domain counted with its
// "@") leaves the address in the card.
const LN_TITLE_NAME_MAX = 16;
const LN_TITLE_DOMAIN_MAX = 20;
// An address that fills more of the title's width than this drops its domain
// to its own line too, rather than touching the sheet's edges on one line.
const LN_TITLE_FILL_MAX = 0.92;
function fitsTitle(address: string): boolean {
  const at = address.lastIndexOf("@");
  return at > 0 && at <= LN_TITLE_NAME_MAX && address.length - at <= LN_TITLE_DOMAIN_MAX;
}

function LightningTitle({ label, value }: { label: string; value: string }) {
  const at = value.lastIndexOf("@");
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.classList.remove("is-stacked");
      // The text's own width: scrollWidth is never below clientWidth, so it
      // cannot tell a short address from one that fills the line.
      const text = document.createRange();
      text.selectNodeContents(el);
      if (text.getBoundingClientRect().width > el.clientWidth * LN_TITLE_FILL_MAX) el.classList.add("is-stacked");
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [value]);
  return (
    <>
      {label}
      <span ref={ref} className="sht-send-title-ln">
        {value.slice(0, at)}
        <span className="sht-send-title-lndomain">{value.slice(at)}</span>
      </span>
    </>
  );
}

// One line, domain whole. A name that does not fit is cut to the exact width
// that does, so no spare pixels sit between its ellipsis and the domain (CSS
// text-overflow alone leaves up to a glyph of slack there).
// Air between a cut name's ellipsis and the domain (the glyph itself has none).
const ELLIPSIS_GAP = 2;

function LightningAddress({ value }: { value: string }) {
  const at = value.lastIndexOf("@");
  const name = value.slice(0, at);
  const nameRef = useRef<HTMLSpanElement>(null);
  const measRef = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState<{ text: string; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = nameRef.current;
    const m = measRef.current;
    if (!el || !m) return;
    if (fit !== null) {
      const row = el.closest(".sht-send-row");
      if (!row) return;
      // Observing fires once at once; only a real width change refits, or the
      // fit and the refit would chase each other every frame.
      let last = row.clientWidth;
      const ro = new ResizeObserver(() => {
        if (row.clientWidth === last) return;
        last = row.clientWidth;
        setFit(null);
      });
      ro.observe(row);
      return () => ro.disconnect();
    }
    const avail = el.clientWidth;
    const width = (text: string) => {
      m.textContent = text;
      return m.offsetWidth;
    };
    if (el.scrollWidth <= avail) {
      setFit({ text: name, width: width(name) });
      return;
    }
    let lo = 0;
    let hi = name.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (width(`${name.slice(0, mid)}…`) <= avail - ELLIPSIS_GAP) lo = mid;
      else hi = mid - 1;
    }
    const text = `${name.slice(0, lo)}…`;
    setFit({ text, width: width(text) });
  }, [fit, name]);
  return (
    <strong className="sht-send-lnaddr">
      <span
        ref={nameRef}
        className="sht-send-lnname"
        style={
          fit
            ? { flex: "none", width: fit.width, overflow: "visible", marginRight: fit.text === name ? 0 : ELLIPSIS_GAP }
            : undefined
        }
      >
        {fit ? fit.text : name}
      </span>
      <span ref={measRef} className="sht-send-lnmeasure" aria-hidden="true" />
      <span className="sht-send-domain">{value.slice(at)}</span>
    </strong>
  );
}

function CopyGlyph({ done }: { done: boolean }) {
  return (
    <svg className="sht-send-copyglyph" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {done ? (
        <path d="M3.5 8.5l3 3 6-7" />
      ) : (
        <>
          <rect x="5.5" y="5.5" width="8" height="8" rx="2" />
          <path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" />
        </>
      )}
    </svg>
  );
}

// Same 1.5 outline as the plane, so the note reads as part of the sheet
// rather than an alarm.
function InfoGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" />
      {/* Italic i: slanted stem with a small exit curl, dot shifted right to match. */}
      <path d="M7.1 7.6h1.2l-.85 3.1c-.12.45.2.7.6.5l.45-.25" strokeLinejoin="round" />
      <circle cx="8.75" cy="4.95" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}
