// "Zálohovat" on the dashboard banner for a wallet that already has a password: ask for it, then show the 12 words.
// A wallet without one never gets here (the banner opens PasswordSetupSheet, which ends on the same words screen).
import { useState } from "react";
import { clearNeedsSeedBackup, clearPendingGiftPassword } from "../lib/gift/giftStore";
import { useT } from "../lib/i18n";
import { decryptMnemonic, loadVault } from "../lib/vault/crypto";
import MnemonicGrid from "./MnemonicGrid";
import { QuillMark } from "./QuillMark";
import { Screen, Sheet, StatusMark, useSheetClose } from "./sheet/PaySheet";

// The words, the "I wrote them down" box and the way out. Shared with PasswordSetupSheet so both ways to the
// backup end on one screen. Clearing the flag is what makes the dashboard banner go away.
export function SeedWordsScreen({ words, onDone }: { words: string[]; onDone: () => void }) {
  const t = useT();
  const [written, setWritten] = useState(false);

  return (
    <Screen>
      <QuillMark />
      <h2 className="sht-title">{t("Zapiš si seed")}</h2>
      <p className="sht-sub">{t("Na papír, v tomhle pořadí. Bez něj o peníze přijdeš.")}</p>
      <MnemonicGrid tiles revealAll words={words} />
      <label className="ex-check pw-skip">
        <input type="checkbox" checked={written} onChange={(e) => setWritten(e.target.checked)} />
        {t("Zapsal/a jsem si ho")}
      </label>
      <button
        type="button"
        className="primary sht-wide"
        disabled={!written}
        onClick={() => {
          clearNeedsSeedBackup();
          onDone();
        }}
      >
        {t("Hotovo")}
      </button>
    </Screen>
  );
}

export default function SeedBackupSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { closing, closeThen } = useSheetClose();
  const [words, setWords] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reveal = async () => {
    const vault = loadVault();
    if (!vault || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const m = await decryptMnemonic(vault, password);
      // The password was right and the seed is about to be on screen, so a plaintext copy kept for a gift
      // recipient has nothing left to protect against.
      clearPendingGiftPassword();
      setPassword("");
      setWords(m.split(" "));
    } catch {
      setError(t("Nesprávné heslo."));
    } finally {
      setBusy(false);
    }
  };

  const close = () => closeThen(onClose);

  return (
    <Sheet closing={closing} onBackdrop={close} screenKey={words ? "words" : "password"}>
      {words ? (
        <SeedWordsScreen
          words={words}
          onDone={() => {
            setWords(null);
            close();
          }}
        />
      ) : (
        <Screen>
          <StatusMark state="neutral" />
          <h2 className="sht-title">{t("Potvrď heslo")}</h2>
          <p className="sht-sub">{t("Pro zobrazení seed phrase potvrď své heslo.")}</p>
          <input
            className="sht-field"
            type="password"
            placeholder={t("Heslo")}
            value={password}
            autoFocus
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void reveal();
            }}
          />
          {error && <p className="sht-error">{error}</p>}
          <button type="button" className="primary sht-wide" disabled={!password || busy} onClick={() => void reveal()}>
            {busy ? t("Ověřuji…") : t("Zobrazit")}
          </button>
        </Screen>
      )}
    </Sheet>
  );
}
