import { useEffect, useState } from "react";
import { ErrorCircleIcon, WarningIcon } from "./BannerIcons";
import { useCopyLink } from "./sheet/ShareLink";
import { useT } from "../lib/i18n";
import { exportChatNsec } from "../lib/wallet/bark";
import { SPEND_AUTH_FAILED, SPEND_AUTH_REQUIRED, WALLET_NOT_OPEN } from "../lib/wallet/walletSession";
import { loadVaultOrPrompt, missingVaultText } from "../lib/vault/vaultAccess";
import "./NsecReveal.css";

// Settings > Zabezpečení > "Nostr klíč (nsec)": the chat's secret key, shown after the password, so the user can
// keep it or sign in with the same identity in another Nostr app. The wallet worker checks the password and
// builds the string; this screen only holds it in state while it is open and drops it when the page is hidden.
export default function NsecReveal() {
  const t = useT();
  const [password, setPassword] = useState("");
  const [nsec, setNsec] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { copied, copy, error: copyError } = useCopyLink(nsec);

  useEffect(() => {
    if (nsec === null) return;
    const hide = () => {
      if (document.hidden) setNsec(null);
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [nsec]);

  const reveal = async () => {
    const vault = loadVaultOrPrompt();
    if (!vault) {
      setError(t(missingVaultText()));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setNsec(await exportChatNsec({ vault, password }));
      setPassword("");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message === SPEND_AUTH_FAILED || message === SPEND_AUTH_REQUIRED) setError(t("Nesprávné heslo."));
      else if (message === WALLET_NOT_OPEN) setError(t("Peněženka je zamčená."));
      else setError(t("Nepodařilo se."));
    } finally {
      setBusy(false);
    }
  };

  if (nsec) {
    return (
      <div className="settings-body">
        <div className="nsec-card">
          <div className="nsec-note">
            <WarningIcon />
            <span>{t("Kdo má nsec, čte tvoje zprávy a píše tvým jménem. K penězům se nedostane.")}</span>
          </div>
          <p className="nsec-key">{nsec}</p>
        </div>
        {copyError && <p className="muted">{copyError}</p>}
        <button className="secondary nsec-copy" onClick={copy}>
          {copied ? t("Zkopírováno") : t("Kopírovat")}
        </button>
      </div>
    );
  }

  return (
    <div className="settings-body">
      <p className="muted">{t("Pro zobrazení nsec potvrď své heslo.")}</p>
      <input
        type="password"
        placeholder={t("Heslo")}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && password && !busy && void reveal()}
      />
      {error && (
        <div className="nsec-note is-error">
          <ErrorCircleIcon />
          <span>{error}</span>
        </div>
      )}
      <button disabled={busy || !password} onClick={() => void reveal()}>
        {busy ? t("Ověřuji…") : t("Zobrazit")}
      </button>
    </div>
  );
}
