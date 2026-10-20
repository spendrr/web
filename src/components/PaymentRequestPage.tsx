import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { isInvoiceExpired, type PaymentRequestParams } from "../lib/send/paymentRequest";
import { fetchBtcRates } from "../lib/price";
import { getFiatCurrency } from "../lib/currency";
import { localeFor, useLang, useT } from "../lib/i18n";
import { BigAmount, Screen, Sheet, StatusMark, useSheetClose } from "./sheet/PaySheet";
import { useCopyLink } from "./sheet/ShareLink";
import Avatar from "./Avatar";
import "./PaymentRequestPage.css";

// What someone sees when they open a spendrr.app/r#… link — the paying side
// of a payment request.
//
// Two audiences on the same screen, in the order they should be served:
//   - a Spendrr user: one button, everything already filled in. The link's
//     Ark address and amount go straight into the send form.
//   - anyone else: the BOLT11 invoice the requester's wallet created, as a
//     QR and as a "lightning:" link their own wallet can open. This is the
//     whole reason the link carries an invoice at all.
// Which one leads is decided by whether this device has a wallet, not by
// which the requester preferred.
//
// Nothing on this screen is a secret (see lib/paymentRequest.ts) and nothing
// here spends anything by itself: the actual payment always happens in the
// send flow, behind its own confirmation.
//
// Anyone can make one of these links, on this app's own domain, with any
// address and any note. So the note is labelled as the requester's own words,
// never presented as the app's, and the address carries its avatar: the same
// visual checksum a @handle shows (lib/avatar.ts), which the requester can
// hold up against the one in their own profile.

export default function PaymentRequestPage({
  request,
  hasWallet,
  walletReady,
  onPay,
  onDismiss,
}: {
  request: PaymentRequestParams;
  /** A vault exists on this device — Spendrr is installed here. */
  hasWallet: boolean;
  /** A wallet session is open right now, so paying is one tap away. */
  walletReady: boolean;
  /** Hands the request to the send flow, prefilled. */
  onPay: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const fmt = (n: number) => n.toLocaleString(localeFor(lang));
  const cur = getFiatCurrency();
  const { closing, closeThen } = useSheetClose();

  // Fetched here rather than handed down: this screen can render before any
  // wallet session exists (that is its whole point — the payer may not have
  // Spendrr at all), so there is no Dashboard above it holding rates.
  // Best-effort like every other price read in this app: the fiat line just
  // stays absent if it fails, and nothing waits on it.
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void fetchBtcRates()
      .then((r) => {
        if (live) setRate(r[cur]);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [cur]);

  // Re-checked on a timer rather than read once: someone can sit on this
  // screen longer than the invoice lasts, and a QR that silently goes stale
  // under them is exactly the confusion this label exists to prevent.
  const [now, setNow] = useState(() => Date.now());
  const invoiceAlreadyExpired = !!request.invoice && isInvoiceExpired(request, now);
  useEffect(() => {
    // Nothing left to detect once there's no invoice, or it's already known
    // expired — re-rendering every 15s past that point (re-running the QR
    // and everything else on the screen) would just burn cycles forever on
    // a page someone might leave open a long time (e.g. a merchant display).
    if (!request.invoice || invoiceAlreadyExpired) return;
    const h = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(h);
  }, [request.invoice, invoiceAlreadyExpired]);

  const invoiceUsable = !!request.invoice && !invoiceAlreadyExpired;
  const { copied, copy } = useCopyLink(request.invoice ?? null);

  const payable = !!request.address;
  const hasInvoice = !!request.invoice;

  return (
    <Sheet closing={closing} onBackdrop={() => closeThen(onDismiss)} screenKey="request">
      <Screen>
        <StatusMark state="incoming" />
        <h2 className="sht-title">{t("Žádost o platbu")}</h2>
        <BigAmount sats={request.amountSats} rate={rate} currency={cur} fmt={fmt} />
        {request.address && (
          <div className="prq-recipient">
            <Avatar seed={request.address} size={32} />
            <span className="prq-recipient-text">
              <span className="prq-recipient-label">{t("Příjemce")}</span>
              <code className="prq-recipient-address">
                {request.address.slice(0, 10)}…{request.address.slice(-6)}
              </code>
            </span>
          </div>
        )}
        {request.note && (
          <div className="prq-note-block">
            <span className="prq-note-label">{t("Zpráva od žadatele, Spendrr ji neověřuje")}</span>
            <p className="prq-note">“{request.note}”</p>
          </div>
        )}

        {hasWallet && payable ? (
          <>
            <button type="button" className="primary sht-wide" onClick={() => closeThen(onPay)}>
              {walletReady ? t("Zaplatit") : t("Odemknout a zaplatit")}
            </button>
            {!walletReady && (
              <p className="sht-sub">{t("Nejdřív odemkni peněženku, pak se platba předvyplní sama.")}</p>
            )}
          </>
        ) : (
          <p className="sht-sub">
            {payable && hasInvoice
              ? t("Tenhle odkaz umí Spendrr zaplatit na jedno ťuknutí. Nemáš ho? Zaplať Lightningem níž.")
              : payable
                ? t("Tenhle odkaz jde zaplatit jen ve Spendrru.")
                : t("Tenhle požadavek jde zaplatit jen Lightningem.")}
          </p>
        )}

        {request.invoice && (
          <div className="prq-ln">
            <div className="prq-ln-head">
              <span className="prq-ln-label">{t("Zaplatit Lightningem")}</span>
              {!invoiceUsable && <span className="prq-ln-expired">{t("faktura vypršela")}</span>}
            </div>
            {invoiceUsable ? (
              <>
                {/* Deliberately the bare invoice, not a "lightning:" URI:
                    every Lightning wallet's scanner reads a bare BOLT11,
                    while some still choke on the scheme prefix. The prefix
                    is only used for the tap-to-open link below, where it is
                    what makes the hand-off work. */}
                <a
                  className="prq-ln-qr"
                  href={`lightning:${request.invoice}`}
                  aria-label={t("Otevřít v Lightning peněžence")}
                >
                  <QRCodeSVG value={request.invoice.toUpperCase()} size={172} />
                </a>
                <div className="prq-ln-actions">
                  <button type="button" className="secondary" onClick={copy}>
                    {copied ? t("Zkopírováno") : t("Kopírovat")}
                  </button>
                  <a className="prq-ln-open" href={`lightning:${request.invoice}`}>
                    {t("Otevřít")}
                  </a>
                </div>
              </>
            ) : (
              <p className="sht-sub">
                {payable
                  ? t("Požádej o nový odkaz, nebo zaplať ve Spendrru. Adresa nad ní platí dál.")
                  : t("Požádej o nový odkaz.")}
              </p>
            )}
          </div>
        )}

        <button type="button" className="sht-link" onClick={() => closeThen(onDismiss)}>
          {hasWallet ? t("Teď ne") : t("Zavřít")}
        </button>
      </Screen>
    </Sheet>
  );
}
