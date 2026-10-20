import { useState } from "react";
import type { WalletClient } from "../lib/wallet/bark";
import { buildRequestUrl, generateRequestId, type PaymentRequestParams } from "../lib/send/paymentRequest";
import { decodeBolt11Expiry } from "../lib/send/destination";
import { withTimeout, isWalletCallTimeout } from "../lib/wallet/walletCall";
import { getFiatCurrency, type FiatCurrency } from "../lib/currency";
import { localeFor, useLang, useT } from "../lib/i18n";
import {
  AmountField,
  BigAmount,
  Screen,
  Sheet,
  StatusMark,
  useAmountEntry,
  useSheetClose,
} from "./sheet/PaySheet";
import { ShareLinkResult } from "./sheet/ShareLink";

// "Požadavek k platbě" — the exact opposite of the gift link. A gift link
// carries money to whoever opens it; this carries an ask from whoever opens
// it, with everything already filled in so the payer only has to confirm.
//
// Nothing here moves money and nothing here is a secret, which is why this
// flow has no confirm step, no password gate and no reclaim bookkeeping:
// the whole of it is "what amount, and for what", then a link.
//
// The link carries two ways to pay (see lib/paymentRequest.ts):
//   - the wallet's Ark address, which Spendrr itself pays instantly;
//   - a BOLT11 invoice for the same amount, so someone without Spendrr can
//     pay from any Lightning wallet.
// The invoice needs a real server round-trip and can fail or time out. That
// never blocks the link: a request with only the Ark address is still a
// perfectly good request between two Spendrr users, so a failed invoice
// downgrades the result screen's wording instead of the whole flow.

const NOTE_MAX = 140;
// The invoice is a nice-to-have on a screen the user is waiting on, so it
// gets a much shorter leash than a payment would. Past this the link is
// built without it.
const INVOICE_TIMEOUT_MS = 20_000;

type Phase = "compose" | "creating" | "result" | "error";

export default function PaymentRequestModal({
  wallet,
  address,
  rates,
  onClose,
}: {
  wallet: WalletClient;
  /** This wallet's Ark address, or null if it isn't loaded yet. */
  address: string | null;
  rates: Record<FiatCurrency, number> | null;
  onClose: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const fmt = (n: number) => n.toLocaleString(localeFor(lang));
  const cur = getFiatCurrency();
  const rate = rates ? rates[cur] : null;

  const { closing, closeThen } = useSheetClose();
  const [phase, setPhase] = useState<Phase>("compose");
  const [note, setNote] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  // False when the Lightning half of the link couldn't be created — the
  // result screen says so plainly rather than letting the requester believe
  // any wallet can pay it.
  const [hasInvoice, setHasInvoice] = useState(false);

  const amount = useAmountEntry(rate, cur, fmt, () => setErrorMsg(null));
  const amountSats = amount.sats;

  const close = () => closeThen(onClose);

  const create = async () => {
    setErrorMsg(null);
    setPhase("creating");
    const trimmedNote = note.trim() || undefined;

    let invoice: string | undefined;
    let invoiceExpiresAt: number | undefined;
    try {
      const created = await withTimeout(
        wallet.bolt11Invoice({ amountSats, description: trimmedNote }),
        INVOICE_TIMEOUT_MS,
        t("Vytvoření Lightning faktury trvalo příliš dlouho."),
      );
      invoice = created.invoice;
      invoiceExpiresAt = decodeBolt11Expiry(created.invoice) ?? undefined;
    } catch (e) {
      // Deliberately swallowed, including a timeout: an invoice this app
      // never got a reply about is just an invoice nobody will ever pay,
      // not an ambiguous outcome like a send is. Nothing has moved and
      // nothing is owed, so the worst case is an unused invoice sitting on
      // the server.
      void isWalletCallTimeout(e);
    }

    if (!address && !invoice) {
      // Neither half — there is nothing to put in the link at all.
      setErrorMsg(t("Zatím nemáme tvoji adresu ani Lightning fakturu. Zkus to za chvíli znovu."));
      setPhase("error");
      return;
    }

    const params: PaymentRequestParams = {
      address: address ?? undefined,
      invoice,
      invoiceExpiresAt,
      amountSats,
      note: trimmedNote,
      id: generateRequestId(),
    };
    setHasInvoice(!!invoice);
    setLink(buildRequestUrl(window.location.origin, params));
    setPhase("result");
  };

  let body;
  if (phase === "compose") {
    body = (
      <Screen>
        <h2 className="sht-title">{t("Požadavek k platbě")}</h2>
        <AmountField entry={amount} currency={cur} autoFocus deferFocus label={t("Částka")} />
        <p className="sht-balance">{t("Kolik chceš, aby ti poslali")}</p>
        <input
          className="sht-field"
          placeholder={t("Za co? (nepovinné)")}
          value={note}
          maxLength={NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
        />
        {errorMsg && <p className="sht-error">{errorMsg}</p>}
        <div className="sht-actions">
          <button type="button" className="secondary" onClick={close}>
            {t("Zrušit")}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              if (amountSats <= 0) {
                setErrorMsg(t("Zadej částku."));
                amount.shake();
                return;
              }
              void create();
            }}
          >
            {t("Vytvořit odkaz")}
          </button>
        </div>
      </Screen>
    );
  } else if (phase === "creating") {
    body = (
      <Screen>
        <StatusMark state="progress" />
        <h2 className="sht-title">{t("Připravuju odkaz…")}</h2>
        <BigAmount sats={amountSats} rate={rate} currency={cur} fmt={fmt} />
      </Screen>
    );
  } else if (phase === "result" && link) {
    body = (
      <Screen>
        <StatusMark state="incoming" />
        <h2 className="sht-title">{t("Požadavek je připravený")}</h2>
        <ShareLinkResult
          link={link}
          shareText={note.trim() ? `${note.trim()}: ${t("pošli mi prosím bitcoin")}` : t("Pošli mi prosím bitcoin")}
        >
          <BigAmount sats={amountSats} rate={rate} currency={cur} fmt={fmt} />
          <p className="sht-sub">
            {hasInvoice
              ? t("Komu odkaz pošleš, tomu se všechno předvyplní. Bez Spendrru zaplatí Lightning fakturou.")
              : t("Komu odkaz pošleš, tomu se všechno předvyplní. Lightning fakturu se teď nepodařilo vytvořit, takže odkaz zaplatí jen Spendrr.")}
          </p>
        </ShareLinkResult>
        <button type="button" className="secondary sht-wide" onClick={close}>
          {t("Hotovo")}
        </button>
      </Screen>
    );
  } else {
    body = (
      <Screen>
        <StatusMark state="warn" />
        <h2 className="sht-title">{t("Odkaz se nepodařilo vytvořit")}</h2>
        {errorMsg && <p className="sht-sub">{errorMsg}</p>}
        <div className="sht-actions">
          <button type="button" className="secondary" onClick={close}>
            {t("Zavřít")}
          </button>
          <button type="button" className="primary" onClick={() => setPhase("compose")}>
            {t("Zpět")}
          </button>
        </div>
      </Screen>
    );
  }

  return (
    <Sheet closing={closing} onBackdrop={phase === "compose" ? close : undefined} screenKey={phase}>
      {body}
    </Sheet>
  );
}
