import { useState } from "react";
import { useT } from "../lib/i18n";
import { loadVaultOrPrompt, missingVaultText } from "../lib/vault/vaultAccess";
import { acceptRecordSeal } from "../lib/wallet/bark";
import { checkRecordSeal, sealNeedsPassword, useUnverifiedRecords } from "../lib/wallet/recordSealClient";
import { SPEND_AUTH_FAILED, SPEND_AUTH_REQUIRED } from "../lib/wallet/walletSession";
import { Screen, Sheet, WaitingDots, useSheetClose } from "./sheet/PaySheet";
import "./SpendLimitSheet.css";
import "./RecordSealSheet.css";

// Shown while the wallet worker holds back bark records it did not sign: from before the seal existed, from an old
// backup, or from someone else. Nothing here can tell those apart, so the user decides, with the password. Closing
// it leaves them held back (sync stays blocked) and the sheet closed until the next unlock.
export function RecordSealSheet() {
  const t = useT();
  const records = useUnverifiedRecords();
  const [dismissed, setDismissed] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { closing, closeThen } = useSheetClose();
  const needsPassword = sealNeedsPassword();

  if (records.length === 0 || dismissed) {
    if (dismissed && records.length === 0) setDismissed(false);
    return null;
  }

  const label = (kind: string | null, store: string) =>
    kind === "LightningSend"
      ? t("Platba Lightning")
      : kind === "LightningReceive"
        ? t("Příjem Lightning")
        : store === "bark.v1.5"
          ? t("Kolo")
          : t("Záznam");

  const accept = async () => {
    if (busy || (needsPassword && password === "")) return;
    const vault = needsPassword ? loadVaultOrPrompt() : null;
    if (needsPassword && !vault) {
      setError(t(missingVaultText()));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await acceptRecordSeal(vault ? { vault, password } : undefined, records.map((r) => ({ store: r.store, id: r.id })));
      setPassword("");
      await checkRecordSeal();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message === SPEND_AUTH_FAILED || message === SPEND_AUTH_REQUIRED ? t("Nesprávné heslo.") : message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet closing={closing} onBackdrop={busy ? undefined : () => closeThen(() => setDismissed(true))} screenKey="seal" className="limit-sheet">
      <Screen className="limit-stack">
        <h2 className="limit-title">{t("Neznámá čekající akce")}</h2>
        <p className="limit-sub">{t("Záznamy bez podpisu. Synchronizace stojí.")}</p>
        <ul className="seal-list">
          {records.map((r) => (
            <li key={`${r.store}:${r.id}`} className="seal-row">
              <span className="seal-kind">{label(r.kind, r.store)}</span>
              <span className="seal-id">{r.id.slice(-12)}</span>
            </li>
          ))}
        </ul>
        <p className="limit-note">{t("Potvrď, jen pokud právě probíhala tvoje platba nebo obnova mincí.")}</p>
        {needsPassword && (
          <label className="limit-pw">
            <input
              className="limit-pw-input"
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && void accept()}
              placeholder={t("Heslo")}
              aria-label={t("Heslo")}
              disabled={busy}
            />
          </label>
        )}
        {error && <p className="limit-note is-danger">{error}</p>}
        <div className="sht-actions limit-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => closeThen(() => setDismissed(true))}>
            {t("Později")}
          </button>
          <button type="button" className="primary" disabled={busy || (needsPassword && password === "") || closing} onClick={() => void accept()}>
            {busy ? (
              <span className="sht-waiting">
                {t("Potvrzuji")}
                <WaitingDots />
              </span>
            ) : (
              t("Potvrdit")
            )}
          </button>
        </div>
      </Screen>
    </Sheet>
  );
}
