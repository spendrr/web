import { QRCodeSVG } from "qrcode.react";
import { Screen, Sheet, useSheetClose } from "../sheet/PaySheet";
import { useCopyLink } from "../sheet/ShareLink";
import { encodeNpub } from "../../lib/chat/npub";
import { useT } from "../../lib/i18n";
import "../ProfileSheet.css";
import "./NostrIdentitySheet.css";

// The public half of the chat identity: the npub other Nostr apps know the user
// by. Public, so no password. The secret half (nsec) is deliberately not here.
// Shown short (first and last characters are enough to recognise it); the copy
// button and the QR carry the whole key.

// Header button glyph: a person, the identity the sheet shows.
export function IdentityGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8.5" r="3.6" />
      <path d="M5 20c.8-3.8 3.6-5.8 7-5.8s6.2 2 7 5.8" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <rect x="8" y="8" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M16 8V6.5a2.5 2.5 0 0 0-2.5-2.5h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
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

export default function NostrIdentitySheet({ pubkey, name, onClose }: { pubkey: string; name: string | null; onClose: () => void }) {
  const t = useT();
  const { closing, closeThen } = useSheetClose();
  const close = () => closeThen(onClose);
  const npub = encodeNpub(pubkey) ?? pubkey;
  const { copied, copy, error } = useCopyLink(npub);
  return (
    <Sheet closing={closing} onBackdrop={close} screenKey="nostr-id">
      <Screen>
        <div className="prf-body nid-body">
          <button type="button" className="prf-close" onClick={close} aria-label={t("Zavřít")}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
          <div className="prf-head nid-head">
            <h2 className="sht-title prf-handle">{name ? `@${name}` : t("Nostr klíč")}</h2>
            <p className="sht-sub nid-sub">{name ? t("Nostr klíč") : t("Veřejný klíč")}</p>
          </div>
          <button type="button" className="shl-qr" onClick={copy} aria-label={t("Kopírovat")}>
            <QRCodeSVG value={`nostr:${npub}`} size={208} />
          </button>
          <button type="button" className={`nid-key${copied ? " is-copied" : ""}`} onClick={copy} aria-label={copied ? t("Zkopírováno") : t("Kopírovat")} title={npub}>
            <span className="nid-key-text">{`${npub.slice(0, 10)}…${npub.slice(-6)}`}</span>
            <span className="nid-key-icon" aria-hidden="true">
              {copied ? <CheckIcon /> : <CopyIcon />}
            </span>
          </button>
          {error && <p className="sht-error">{error}</p>}
          <button type="button" className="primary nid-done" onClick={close}>
            {t("Hotovo")}
          </button>
          <p className="sht-sub nid-note">{t("Veřejný. Můžeš ho dát komukoli.")}</p>
        </div>
      </Screen>
    </Sheet>
  );
}
