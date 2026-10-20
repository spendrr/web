import { useState } from "react";
import { encryptVaultBytes, saveVault, zeroBytes } from "../lib/vault/crypto";
import { clearDeviceVault, decryptDeviceVaultBytes } from "../lib/vault/deviceVault";
import { isPasswordStrong, passwordProblem } from "../lib/vault/password";
import { clearNeedsSeedBackup, markNeedsSeedBackup } from "../lib/gift/giftStore";
import { useT } from "../lib/i18n";
import { Screen, Sheet, StatusMark } from "./sheet/PaySheet";

// Turns a passwordless gift wallet (deviceVault.ts) into an ordinary one: the user picks a password, the seed is
// re-encrypted under it, and then the 12 words are shown once with a "write it down" confirmation. Not dismissable:
// it is shown on every open until it is done.
//
// Order matters: once the password vault is saved the device vault is dropped, so a close in the middle leaves a
// normal password wallet plus the existing "back up your seed" banner (markNeedsSeedBackup) instead of a half state.
export default function PasswordSetupSheet({ reason, onDone }: { reason: "gift" | "spend"; onDone: () => void }) {
  const t = useT();
  const [stage, setStage] = useState<"pw" | "seed">("pw");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [words, setWords] = useState<string[]>([]);
  const [written, setWritten] = useState(false);

  const mismatch = pw2.length > 0 && pw !== pw2;
  const problem = passwordProblem(pw);
  const ok = isPasswordStrong(pw) && pw === pw2;

  const submitPassword = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      const bytes = await decryptDeviceVaultBytes();
      try {
        // The words are shown on the next screen; the vault itself is written first.
        const phrase = new TextDecoder().decode(bytes);
        const vault = await encryptVaultBytes(bytes, pw);
        saveVault(vault);
        markNeedsSeedBackup();
        setWords(phrase.trim().split(/\s+/));
      } finally {
        zeroBytes(bytes);
      }
      await clearDeviceVault();
      setPw("");
      setPw2("");
      setStage("seed");
    } catch (e) {
      console.error("[password setup]", e);
      setError(t("Heslo se nepodařilo nastavit."));
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    clearNeedsSeedBackup();
    setWords([]);
    onDone();
  };

  let body;
  if (stage === "pw") {
    body = (
      <Screen>
        <StatusMark state="neutral" />
        <h2 className="sht-title">{t("Heslo k peněžence")}</h2>
        <p className="sht-sub">
          {reason === "gift"
            ? t("Tahle peněženka vznikla z dárku. Zatím ji nic nechrání.")
            : t("Větší platby se potvrzují heslem. Nastav si ho a platbu pak zopakuj.")}
        </p>
        <input
          className="sht-field"
          type="password"
          placeholder={t("Heslo (min. 8 znaků)")}
          value={pw}
          autoFocus
          autoComplete="new-password"
          onChange={(e) => setPw(e.target.value)}
        />
        <input
          className="sht-field"
          type="password"
          placeholder={t("Heslo znovu")}
          value={pw2}
          autoComplete="new-password"
          onChange={(e) => setPw2(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submitPassword();
          }}
        />
        {mismatch && <p className="sht-error">{t("Hesla se neshodují.")}</p>}
        {!mismatch && problem && <p className="sht-sub">{t(problem)}</p>}
        {error && <p className="sht-error">{error}</p>}
        <button type="button" className="primary sht-wide" disabled={!ok || busy} onClick={() => void submitPassword()}>
          {busy ? t("Nastavuji…") : t("Pokračovat")}
        </button>
      </Screen>
    );
  } else {
    body = (
      <Screen>
        <h2 className="sht-title">{t("Zapiš si seed")}</h2>
        <p className="sht-sub">{t("Na papír, v tomhle pořadí. Bez něj o peníze přijdeš.")}</p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "6px 20px",
            textAlign: "left",
            fontVariantNumeric: "tabular-nums",
            padding: "0 8px",
          }}
        >
          {words.map((w, i) => (
            <div key={i} style={{ display: "flex", gap: 8 }}>
              <span style={{ opacity: 0.5, minWidth: 22, textAlign: "right" }}>{i + 1}</span>
              <span>{w}</span>
            </div>
          ))}
        </div>
        <label style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "center", width: "100%" }}>
          <input
            type="checkbox"
            style={{ width: 20, height: 20, flex: "none" }}
            checked={written}
            onChange={(e) => setWritten(e.target.checked)}
          />
          <span>{t("Zapsal/a jsem si ho")}</span>
        </label>
        <button type="button" className="primary sht-wide" disabled={!written} onClick={finish}>
          {t("Hotovo")}
        </button>
      </Screen>
    );
  }

  return <Sheet screenKey={stage}>{body}</Sheet>;
}
