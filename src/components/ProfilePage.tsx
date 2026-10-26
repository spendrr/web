import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import Avatar from "./Avatar";
import { Screen, Sheet, useSheetClose } from "./sheet/PaySheet";
import { useCopyLink } from "./sheet/ShareLink";
import { useT } from "../lib/i18n";
import { NAME_DOMAIN } from "../lib/names/handle";
import { encodeLnurl } from "../lib/send/lnurl";
import { lookupName, type LookupOutcome } from "../lib/names/names";
import "./ProfilePage.css";

// What someone sees when they open spendrr.app/@name, typically by scanning a
// profile QR: the public face of a handle, and the paying side of it.
//
// Two audiences on the same screen:
//   - a Spendrr user: one button that hands the payment to the send form. The
//     beta gets "@name" (its review screen shows the avatar and catches a
//     changed address); everyone else gets the plain Ark address, which the
//     ordinary send form already understands.
//   - anyone else: the Lightning address first when the owner turned it on
//     (almost every other wallet speaks Lightning, few speak Ark), then the Ark
//     address behind the name, as a QR and a copy button.
// With the Lightning address on, the name is titled as the full
// "pavel@spendrr.app" and "@pavel" is shown as the Spendrr shortcut.
//
// Nothing on this screen is a secret and nothing here spends anything; the
// payment itself always happens in the send flow, behind its own review.

export default function ProfilePage({
  name,
  hasWallet,
  walletReady,
  onPay,
  onDismiss,
}: {
  name: string;
  /** A vault exists on this device, so Spendrr is installed here. */
  hasWallet: boolean;
  /** A wallet session is open right now, so paying is one tap away. */
  walletReady: boolean;
  /** Hands the destination (a @name or an address) to the send flow. */
  onPay: (destination: string) => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const { closing, closeThen } = useSheetClose();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<LookupOutcome | null>(null);
  // With a Lightning address, the Ark one is only for the rare payer whose
  // wallet speaks Ark but not Lightning: folded away behind a link.
  const [showArk, setShowArk] = useState(false);

  useEffect(() => {
    let cancelled = false;
    lookupName(name).then((r) => {
      if (!cancelled) setResult(r);
    });
    return () => {
      cancelled = true;
    };
  }, [name, attempt]);

  const address = result?.kind === "found" ? result.address : null;
  const { copied, copy, error: copyError } = useCopyLink(address);

  let body;
  let screenKey = "loading";
  if (result === null) {
    body = (
      <Screen>
        <h2 className="sht-title">@{name}</h2>
        <p className="sht-sub">{t("Načítám…")}</p>
      </Screen>
    );
  } else if (result.kind === "found") {
    screenKey = "found";
    body = (
      <Screen>
        <Avatar seed={result.address} size={96} />
        {result.lnAddress ? (
          <>
            <h2 className="sht-title pfp-name">
              {result.name}
              <span className="pfp-name-domain">@{NAME_DOMAIN}</span>
            </h2>
            <p className="sht-sub pfp-name-hint">
              {t("Ve Spendrru stačí napsat")} <strong>@{result.name}</strong>
            </p>
          </>
        ) : (
          <h2 className="sht-title pfp-name">@{result.name}</h2>
        )}
        {hasWallet ? (
          <>
            {/* Spendrr is on this device, so the pay button is the way in; the
                QR stays for paying from another phone, with nothing around it. */}
            <div className="pfp-qr">
              <QRCodeSVG value={result.address} size={220} />
            </div>
            <button
              type="button"
              className="primary sht-wide"
              onClick={() => closeThen(() => onPay(`@${result.name}`))}
            >
              {walletReady ? t("Zaplatit") : t("Odemknout a zaplatit")}
            </button>
            {!walletReady && (
              <p className="sht-sub">{t("Nejdřív odemkni peněženku, pak se platba předvyplní sama.")}</p>
            )}
          </>
        ) : (
          <>
            <p className="sht-sub">
              {result.lnAddress
                ? t("Zaplatit můžeš z jakékoli Lightning peněženky.")
                : t("Platit můžeš ze Spendrru nebo z jiné Ark peněženky.")}
            </p>
            {result.lnAddress && <LightningSection name={result.name} />}
            {result.lnAddress && !showArk ? (
              <button type="button" className="sht-link" onClick={() => setShowArk(true)}>
                {t("Platíš z Ark peněženky? Ukázat Ark adresu")}
              </button>
            ) : (
              <div className="pfp-ark">
                <span className="pfp-ark-label">{t("Ark adresa")}</span>
                <div className="pfp-ark-qr">
                  <QRCodeSVG value={result.address} size={172} />
                </div>
                {/* The QR is the address; the text is only a check that it is the
                    right one, so a short head…tail beats three lines of bech32. The
                    full value goes to the clipboard, and appears in full only if
                    copying failed and it has to be selected by hand. */}
                <button
                  type="button"
                  className={`pfp-ark-copy${copied ? " is-copied" : ""}`}
                  onClick={copy}
                  aria-label={copied ? t("Zkopírováno") : t("Kopírovat adresu")}
                  title={result.address}
                >
                  <span className="pfp-ark-addr">
                    {result.address.slice(0, 10)}
                    <span className="pfp-ark-dots">...</span>
                    {result.address.slice(-6, -5)}
                    <span className="pfp-ark-tail">{result.address.slice(-5)}</span>
                  </span>
                  <span className="pfp-ark-icon" aria-hidden="true">
                    {copied ? <CheckIcon /> : <CopyIcon />}
                  </span>
                </button>
                {copyError && (
                  <>
                    <p className="sht-sub pfp-note">{t("Kopírování selhalo. Označ adresu a zkopíruj ji ručně.")}</p>
                    <div className="pfp-ark-full">{result.address}</div>
                  </>
                )}
                {!result.lnAddress && <p className="pfp-ark-note">{t("Lightning tahle adresa zatím neumí.")}</p>}
              </div>
            )}
          </>
        )}
        <button type="button" className="sht-link" onClick={() => closeThen(onDismiss)}>
          {hasWallet ? t("Teď ne") : t("Zavřít")}
        </button>
      </Screen>
    );
  } else if (result.kind === "absent") {
    screenKey = "absent";
    body = (
      <Screen>
        <h2 className="sht-title">@{name}</h2>
        <p className="sht-sub">
          {result.status === "quarantined"
            ? t("Tohle jméno se teď nedá použít.")
            : result.status === "free"
              ? t("Takové jméno nikdo nemá. Zkontroluj překlepy.")
              : t("Neplatné jméno.")}
        </p>
        <button type="button" className="secondary sht-wide" onClick={() => closeThen(onDismiss)}>
          {t("Zavřít")}
        </button>
      </Screen>
    );
  } else {
    screenKey = "error";
    body = (
      <Screen>
        <h2 className="sht-title">@{name}</h2>
        <p className="sht-sub">{t("Jméno se nepodařilo načíst. Zkontroluj připojení a zkus to znovu.")}</p>
        <div className="sht-actions">
          <button type="button" className="secondary" onClick={() => closeThen(onDismiss)}>
            {t("Zavřít")}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              setResult(null);
              setAttempt((n) => n + 1);
            }}
          >
            {t("Zkusit znovu")}
          </button>
        </div>
      </Screen>
    );
  }

  return (
    <Sheet closing={closing} onBackdrop={() => closeThen(onDismiss)} screenKey={screenKey}>
      {body}
    </Sheet>
  );
}

// Shown only when the name's owner opted into Lightning (docs/ln-address-plan.md
// section 4.3) and only on the "no Ark wallet" branch above — anyone who does
// have an Ark wallet gets the cheaper direct @name payment instead, which the
// send flow already resolves without ever touching Lightning (see
// handle.ts's parseHandleDestination). This is purely for a wallet that can't
// speak Ark at all: the same bech32-encoded payRequest URL a LUD-06 QR always
// is (LUD-01), so any LNURL-aware wallet can scan it.
function LightningSection({ name }: { name: string }) {
  const t = useT();
  const lnAddressText = `${name}@${NAME_DOMAIN}`;
  const { copied, copy, error: copyError } = useCopyLink(lnAddressText);
  const lnurlQrValue = `lightning:${encodeLnurl(`${window.location.origin}/.well-known/lnurlp/${name}`)}`;
  return (
    <div className="pfp-ark pfp-ln">
      <span className="pfp-ark-label">{t("Lightning adresa")}</span>
      <div className="pfp-ark-qr">
        <QRCodeSVG value={lnurlQrValue} size={172} />
      </div>
      <button
        type="button"
        className={`pfp-ark-copy${copied ? " is-copied" : ""}`}
        onClick={copy}
        aria-label={copied ? t("Zkopírováno") : t("Kopírovat adresu")}
        title={lnAddressText}
      >
        <span className="pfp-ark-addr">{lnAddressText}</span>
        <span className="pfp-ark-icon" aria-hidden="true">
          {copied ? <CheckIcon /> : <CopyIcon />}
        </span>
      </button>
      {copyError && (
        <>
          <p className="sht-sub pfp-note">{t("Kopírování selhalo. Označ adresu a zkopíruj ji ručně.")}</p>
          <div className="pfp-ark-full">{lnAddressText}</div>
        </>
      )}
      {/* The standalone page (src/tip/): pick an amount in EUR, CZK, USD or sats and get an invoice. */}
      <a className="sht-link" href={`/tip/${encodeURIComponent(name)}`}>
        {t("Zvolit částku")}
      </a>
      <p className="pfp-ark-note">
        {t(
          "Platbu přijme a hned pošle dál služba Spendrr. Nemůže ji utratit ani přesměrovat, ale vidí její výši.",
        )}
      </p>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <rect x="8" y="8" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path
        d="M16 8V6.5a2.5 2.5 0 0 0-2.5-2.5h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M5 13l4 4 10-10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
