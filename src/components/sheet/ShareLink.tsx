// The "here is your link" result screen, shared by the gift composer and
// the payment-request composer — both end the same way: a QR that is also
// the copy button, the link itself, and Sdílet / Kopírovat.
//
// Kept next to PaySheet rather than inside it: this one knows about
// clipboards and share sheets, which the sheet primitives deliberately
// don't.
import { useEffect, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useT } from "../../lib/i18n";
import "./ShareLink.css";

export function useCopyLink(link: string | null): { copied: boolean; copy: () => void; error: string | null } {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const h = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(h);
  }, [copied]);
  const copy = () => {
    if (!link) return;
    void navigator.clipboard
      .writeText(link)
      .then(() => {
        setError(null);
        setCopied(true);
      })
      .catch(() => setError(t("Kopírování selhalo — zkopíruj odkaz ručně.")));
  };
  return { copied, copy, error };
}

export function ShareLinkResult({
  link,
  shareText,
  /** Rendered between the QR and the link — e.g. the amount. */
  children,
  qrSize = 182,
  compact = false,
  hideLink = false,
}: {
  link: string;
  shareText: string;
  children?: ReactNode;
  qrSize?: number;
  // One "Sdílet" button instead of Kopírovat + Sdílet. Copying moves onto the
  // QR (already a copy button) and the link line, which becomes one too.
  compact?: boolean;
  // The QR is the copy button; no link line under it (the caller shows the address elsewhere).
  hideLink?: boolean;
}) {
  const t = useT();
  const { copied, copy, error } = useCopyLink(link);

  const share = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ text: shareText, url: link });
        return;
      }
    } catch {
      // user cancelled the share sheet — fall through to copy
    }
    copy();
  };

  return (
    <>
      {children}
      <button
        type="button"
        className={`shl-qr${copied ? " is-copied" : ""}`}
        onClick={copy}
        aria-label={t("Zkopírovat odkaz")}
      >
        <QRCodeSVG value={link} size={qrSize} />
      </button>
      {hideLink ? null : compact ? (
        <button type="button" className="shl-link shl-link-btn" title={link} onClick={copy} aria-label={t("Zkopírovat odkaz")}>
          <span className="shl-link-text">{link}</span>
          <i className="shl-copy-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V6a2 2 0 0 1 2-2h9" />
            </svg>
          </i>
        </button>
      ) : (
        <div className="shl-link" title={link}>
          {link}
        </div>
      )}
      {/* No upfront "tap the QR to copy" instruction — redundant next to the
          Kopírovat button right below. Only speaks up as feedback once
          something has actually been copied. */}
      {copied && <p className="shl-hint">{t("Odkaz zkopírován")}</p>}
      {error && <p className="sht-error">{error}</p>}
      <div className="sht-actions">
        {!compact && (
          <button type="button" className="secondary" onClick={copy}>
            {copied ? t("Zkopírováno") : t("Kopírovat")}
          </button>
        )}
        <button type="button" className="primary" onClick={() => void share()}>
          {t("Sdílet")}
        </button>
      </div>
    </>
  );
}
