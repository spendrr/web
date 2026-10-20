// Receive (v2): the Lightning address <name>@spendrr.app is the one thing on
// the screen, because every common wallet can pay it and the payer's wallet
// asks for the amount itself. Ark and on-chain sit in a quiet row at the
// bottom. Without a working address (none registered, switched off, or the
// service refusing invoices) Ark is the default and Lightning becomes an
// invoice made here for an amount.
//
// A payment to the address arrives as an Ark payment through the mailbox, so
// Dashboard's Ark watch sees it like any other and the screen dissolves the
// same way.
import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { LightningInvoice } from "@secondts/bark";
import type { WalletClient } from "../lib/wallet/bark";
import type { FiatCurrency } from "../lib/currency";
import { formatFiat, satsToFiat } from "../lib/price";
import { localeFor, useLang, useT } from "../lib/i18n";
import { NAME_DOMAIN } from "../lib/names/handle";
import { withTimeout } from "../lib/wallet/walletCall";
import { surfaceError } from "../lib/appErrors";
import { AmountField, useAmountEntry } from "./sheet/PaySheet";
import { TruncatedAddress } from "./TruncatedAddress";
import "./ReceiveScreen.css";

// "ln" is the Lightning address, "lightning" an invoice from this wallet.
export type ReceiveFormat = "ln" | "ark" | "lightning" | "onchain";

const NOTE_MAX = 140;
const INVOICE_TIMEOUT_MS = 20_000;

function useCopied(): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  return [
    copied,
    () => {
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    },
  ];
}

const ICON = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

function CopyIcon() {
  return (
    <svg {...ICON}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </svg>
  );
}

function CopiedIcon() {
  return (
    <svg {...ICON}>
      <path d="m5.5 12.5 4 4 9-9.5" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg {...ICON}>
      <path d="M12 15V3M7 8l5-5 5 5" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  );
}

export default function ReceiveScreen({
  wallet,
  format,
  onFormatChange,
  lnName,
  lnServiceOk,
  onSetupAddress,
  address,
  addressError,
  onchainAddress,
  onRequestOnchainAddress,
  invoice,
  onInvoiceCreated,
  onCancelInvoice,
  rates,
  currency,
  onQrCopied,
  dissolving,
}: {
  wallet: WalletClient;
  format: ReceiveFormat;
  onFormatChange: (format: ReceiveFormat) => void;
  // The registered name, only while its Lightning address is switched on.
  lnName: string | null;
  lnServiceOk: boolean;
  onSetupAddress: () => void;
  address: string | null;
  addressError: string | null;
  onchainAddress: string | null;
  onRequestOnchainAddress: () => void;
  invoice: { invoice: LightningInvoice; status: "waiting" | "paid" } | null;
  onInvoiceCreated: (invoice: LightningInvoice) => void;
  onCancelInvoice: () => void;
  rates: Record<FiatCurrency, number> | null;
  currency: FiatCurrency;
  onQrCopied: () => void;
  dissolving: boolean;
}) {
  const t = useT();
  const lang = useLang();
  const fmt = (n: number) => n.toLocaleString(localeFor(lang));
  const rate = rates ? rates[currency] : null;

  const lnUsable = lnName !== null && lnServiceOk;
  // The address is the default; without a usable one Ark stands in for it.
  const shown: ReceiveFormat = format === "ln" && !lnUsable ? "ark" : format;

  useEffect(() => {
    if (shown === "onchain" && !onchainAddress) onRequestOnchainAddress();
  }, [shown, onchainAddress, onRequestOnchainAddress]);

  const [copied, markCopied] = useCopied();
  const [pulsing, setPulsing] = useState(false);
  const pulseTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (pulseTimer.current !== null) window.clearTimeout(pulseTimer.current);
    },
    [],
  );

  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  const amount = useAmountEntry(rate, currency, fmt, () => setInvoiceError(null));
  const [note, setNote] = useState("");
  // The note is not part of LightningInvoice; kept here for the invoice it was
  // typed for, so it can be shown beside the amount.
  const [noteFor, setNoteFor] = useState<{ hash: string; note: string } | null>(null);
  const [creating, setCreating] = useState(false);

  const lnAddress = lnName ? `${lnName}@${NAME_DOMAIN}` : "";
  const value =
    shown === "ln"
      ? lnAddress
      : shown === "lightning"
        ? (invoice?.invoice.invoice ?? null)
        : shown === "ark"
          ? address
          : onchainAddress;
  // The scheme tells a phone's camera app what the code is; wallets read the
  // bare value too. An invoice goes in upper case: bech32 allows it and the
  // QR's alphanumeric mode makes the code noticeably less dense (our own
  // scanner lower-cases it again, normalizeDestination).
  const qrValue =
    value === null
      ? null
      : shown === "ln"
        ? `lightning:${value}`
        : shown === "lightning"
          ? `LIGHTNING:${value.toUpperCase()}`
          : shown === "onchain"
            ? `bitcoin:${value}`
            : value;

  const copy = () => {
    if (!value) return;
    void navigator.clipboard?.writeText(value).catch(() => {});
    markCopied();
  };
  const share = async () => {
    if (!value) return;
    try {
      if (navigator.share) {
        await navigator.share({ text: value });
        return;
      }
    } catch {
      // The share sheet was dismissed; nothing else to do.
      return;
    }
    copy();
  };

  const createInvoice = async () => {
    if (amount.sats <= 0) {
      setInvoiceError(t("Zadej částku."));
      amount.shake();
      return;
    }
    setCreating(true);
    setInvoiceError(null);
    try {
      const trimmed = note.trim();
      const created = await withTimeout(
        wallet.bolt11Invoice({ amountSats: amount.sats, description: trimmed || undefined }),
        INVOICE_TIMEOUT_MS,
        t("Vytvoření Lightning faktury trvalo příliš dlouho."),
      );
      setNoteFor(trimmed ? { hash: created.paymentHash, note: trimmed } : null);
      onInvoiceCreated(created);
    } catch (e) {
      surfaceError(e, setInvoiceError);
    } finally {
      setCreating(false);
    }
  };
  const newInvoice = () => {
    onCancelInvoice();
    amount.reset();
    setNote("");
    setInvoiceError(null);
  };

  const others = (
    [
      { key: "ln", label: "Lightning" },
      { key: "lightning", label: "Lightning" },
      { key: "ark", label: "Ark" },
      { key: "onchain", label: "On-chain" },
    ] as const
  ).filter((o) => o.key !== shown && (o.key === "ln" ? lnUsable : o.key === "lightning" ? !lnUsable : true));

  const subline =
    shown === "ark" && lnUsable
      ? t("Jen z Ark peněženky")
      : shown === "onchain"
        ? t("Připíše se po ručním přijetí")
        : shown === "ark" && lnName !== null && !lnServiceOk
          ? t("Lightning adresa teď nejde")
          : null;

  const actions = (
    <div className="sht-actions rcv-actions">
      <button type="button" className="secondary" onClick={copy} disabled={!value}>
        {copied ? <CopiedIcon /> : <CopyIcon />}
        {copied ? t("Zkopírováno") : t("Kopírovat")}
      </button>
      <button type="button" className="primary" onClick={() => void share()} disabled={!value}>
        <ShareIcon />
        {t("Sdílet")}
      </button>
    </div>
  );

  const qr =
    qrValue === null ? (
      // The QR's own frame, so the screen keeps its shape while the address
      // is derived.
      <div className="qr-wrap qr-wrap-placeholder" role="status">
        <div className="qr-placeholder-inner">{addressError && shown === "ark" ? addressError : t("Generuji adresu…")}</div>
      </div>
    ) : (
      <button
        type="button"
        className={`qr-wrap qr-wrap-button${pulsing ? " qr-pulse" : ""}`}
        onClick={() => {
          copy();
          onQrCopied();
          if (pulseTimer.current !== null) window.clearTimeout(pulseTimer.current);
          setPulsing(true);
          pulseTimer.current = window.setTimeout(() => setPulsing(false), 280);
        }}
        aria-label={shown === "lightning" ? t("Kopírovat fakturu") : t("Kopírovat adresu")}
      >
        <QRCodeSVG value={qrValue} size={240} />
      </button>
    );

  let body;
  if (shown === "lightning" && !invoice) {
    body = (
      <form
        className="rcv-compose"
        onSubmit={(e) => {
          e.preventDefault();
          void createInvoice();
        }}
      >
        <AmountField entry={amount} currency={currency} autoFocus label={t("Částka")} />
        <input
          className="sht-field rcv-field"
          placeholder={t("Za co? (nepovinné)")}
          value={note}
          maxLength={NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
          enterKeyHint="done"
        />
        {invoiceError && <p className="sht-error">{invoiceError}</p>}
        <button type="submit" className="primary rcv-create" disabled={creating}>
          {creating ? t("Vytvářím fakturu…") : t("Vytvořit fakturu")}
        </button>
      </form>
    );
  } else if (shown === "lightning" && invoice) {
    const sats = invoice.invoice.amountSats;
    const invoiceNote = noteFor?.hash === invoice.invoice.paymentHash ? noteFor.note : null;
    const sub = [rate ? `≈ ${formatFiat(satsToFiat(sats, rate), currency)}` : null, invoiceNote].filter(Boolean).join(" · ");
    body =
      invoice.status === "paid" && !dissolving ? (
        <p className="rcv-paid">{t("Faktura zaplacena")}</p>
      ) : (
        <>
          {qr}
          {/* No "waiting" line: the QR being up is the waiting state, and the
              payment's arrival has its own animation. */}
          <div className="sht-bigamount">
            <div className="sht-bigamount-sats">
              {fmt(sats)} <span className="sht-bigamount-unit">sats</span>
            </div>
            {sub && <div className="rcv-invoice-sub">{sub}</div>}
          </div>
          {actions}
        </>
      );
  } else {
    body = (
      <>
        {qr}
        {shown === "ln" ? (
          <button type="button" className="rcv-ln" onClick={copy} title={t("Kopírovat")}>
            <span className="rcv-ln-name">{lnName}</span>
            <span className="rcv-ln-domain">@{NAME_DOMAIN}</span>
          </button>
        ) : value ? (
          <button type="button" className="rcv-addr address" onClick={copy} title={t("Kopírovat")}>
            <TruncatedAddress value={value} />
          </button>
        ) : null}
        {subline && <p className="rcv-note">{subline}</p>}
        {actions}
        {lnName === null && shown === "ark" && (
          <button type="button" className="rcv-setup" onClick={onSetupAddress}>
            <span>
              {t("Adresa")}{" "}
              <span className="rcv-setup-addr">
                {t("jmeno")}
                <span className="rcv-ln-domain">@{NAME_DOMAIN}</span>
              </span>
            </span>
            <span className="rcv-setup-cta">{t("Nastavit")}</span>
          </button>
        )}
      </>
    );
  }

  return (
    <div className="panel rcv">
      <div key={`${shown}:${invoice ? invoice.invoice.paymentHash : ""}`} className="rcv-body">
        {body}
      </div>
      <nav className="rcv-formats" aria-label={t("Jiný formát")}>
        {shown === "lightning" && invoice && (
          <span>
            <button type="button" className="rcv-format" onClick={newInvoice}>
              {invoice.status === "paid" ? t("Nová faktura") : t("Jiná částka")}
            </button>
          </span>
        )}
        {others.map((o, i) => (
          <span key={o.key}>
            {(i > 0 || (shown === "lightning" && invoice)) && (
              <span className="rcv-dot" aria-hidden="true">
                ·
              </span>
            )}
            <button type="button" className="rcv-format" onClick={() => onFormatChange(o.key)}>
              {o.label}
            </button>
          </span>
        ))}
      </nav>
    </div>
  );
}
