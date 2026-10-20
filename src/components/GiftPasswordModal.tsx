import { useState } from "react";
import { offerPasswordToManager } from "../lib/vault/credentialStore";
import { useT } from "../lib/i18n";
import "./GiftPasswordModal.css";

// Shown a few seconds after a gift-link recipient's brand-new wallet opens.
// The vault password was generated for them and never typed; this is the one
// chance to put it somewhere they control. Not dismissible except by
// confirming — a lost password here means a wallet (and its seed phrase)
// that can't be opened on any other device.
export default function GiftPasswordModal({ password, onDone }: { password: string; onDone: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  // The password sits in a real login-shaped form and "save" submits it,
  // which is what makes iOS Safari / Chrome offer to store it in their
  // password manager (navigator.credentials.store alone, the old path, only
  // does anything in Chromium). The form is never really sent anywhere:
  // onSubmit cancels the navigation, exactly like a single-page app's login,
  // so the CSP's form-action 'none' is not involved. Nothing tells us whether
  // the user accepted the browser's offer, so the buttons stay either way.
  const [revealed, setRevealed] = useState(false);
  const [offered, setOffered] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      /* clipboard blocked — the value is on screen to type */
    }
  };

  const submitToManager = (e: React.FormEvent) => {
    e.preventDefault();
    setOffered(true);
    // Chromium's own credential API on top, harmless where it is missing.
    void offerPasswordToManager("Spendrr", password);
  };

  return (
    <div className="modal-backdrop gpw-backdrop">
      <div className="modal-card gpw-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t("Ulož si heslo k peněžence")}</h2>
        </div>
        <p className="muted gpw-sub">
          {t(
            "Peněženka ti vznikla přes dárkový odkaz, heslo jsme ti vytvořili automaticky. Bez něj se do ní nedostaneš na jiném zařízení ani nezobrazíš seed frázi. Ulož si ho do správce hesel.",
          )}
        </p>

        <form onSubmit={submitToManager} className="gpw-form">
          {/* Off-screen rather than display:none: managers skip hidden
              fields, and the pair (username + new-password) is what marks
              this as an account they should offer to remember. */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            value="Spendrr"
            readOnly
            tabIndex={-1}
            aria-hidden="true"
            className="gpw-offscreen"
          />
          <div className="gpw-value-row">
            <input
              type={revealed ? "text" : "password"}
              name="password"
              autoComplete="new-password"
              value={password}
              readOnly
              aria-label={t("Heslo k peněžence")}
              className="gpw-value gpw-value-input"
            />
            <button type="button" className="secondary gpw-reveal" onClick={() => setRevealed((r) => !r)}>
              {revealed ? t("Skrýt") : t("Zobrazit")}
            </button>
          </div>
          <p className="gpw-hint">{t("Heslo zadávej přesně i s pomlčkami.")}</p>
          {offered && (
            <p className="gpw-hint">{t("Pokud prohlížeč nabídl uložení hesla, potvrď ho. Jinak si heslo zkopíruj.")}</p>
          )}
          <div className="gpw-actions">
            <button type="submit" className="gpw-primary">
              {t("Uložit do správce hesel")}
            </button>
            <button type="button" className="secondary" onClick={() => void copy()}>
              {copied ? t("Zkopírováno") : t("Zkopírovat heslo")}
            </button>
            <button type="button" className="secondary" onClick={onDone}>
              {t("Uložil/a jsem si ho")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
