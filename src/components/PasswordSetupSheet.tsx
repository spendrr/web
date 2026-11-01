import { useEffect, useRef, useState } from "react";
import { encryptVaultBytes, saveVault, zeroBytes } from "../lib/vault/crypto";
import { clearDeviceVault, decryptDeviceVaultBytes, markDeviceVaultChosen } from "../lib/vault/deviceVault";
import { isPasswordStrong, passwordProblem, passwordStrengthLevel } from "../lib/vault/password";
import { markNeedsSeedBackup } from "../lib/gift/giftStore";
import { useT } from "../lib/i18n";
import type { PasswordSetupReason } from "../lib/vault/vaultAccess";
import { SeedWordsScreen } from "./SeedBackupSheet";
import { PasswordMark } from "./PasswordMark";
import { UNLOCK_SHAKE } from "../lib/ui/shake";
import { COARSE_POINTER } from "../lib/ui/touch";
import { Screen, Sheet, useSheetClose } from "./sheet/PaySheet";

// Turns a passwordless gift wallet (deviceVault.ts) into an ordinary one: the user picks a password, the seed is
// re-encrypted under it, and then the 12 words are shown once with a "write it down" confirmation. Not dismissable:
// it is shown on every open until it is done (except when opened from the dashboard banner, see the Sheet below).
//
// Order matters: once the password vault is saved the device vault is dropped, so a close in the middle leaves a
// normal password wallet plus the existing "back up your seed" banner (markNeedsSeedBackup) instead of a half state.
export default function PasswordSetupSheet({ reason, onDone }: { reason: PasswordSetupReason; onDone: () => void }) {
  const t = useT();
  const { closing, closeThen } = useSheetClose();
  const [stage, setStage] = useState<"pw" | "seed">("pw");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [words, setWords] = useState<string[]>([]);
  // Offered everywhere except where a payment needs the password: someone who chose no password still has to be able
  // to read the words (from the banner's "Zálohovat"), which are read straight from the device vault, left as it is.
  const [skip, setSkip] = useState(false);

  const mismatch = pw2.length > 0 && pw !== pw2;
  const problem = passwordProblem(pw);
  const strong = isPasswordStrong(pw);
  const ok = skip || (strong && pw === pw2);
  // The same mark as the onboarding's password screen: the asterisks light with the password, the line goes red on a
  // wrong confirmation or a failed attempt, and one pass plays on submit.
  const level = strong ? 3 : Math.min(2, passwordStrengthLevel(pw));
  const wrongConfirm = mismatch && pw2.length >= pw.length;
  const bad = !skip && (wrongConfirm || !!error);
  const markRef = useRef<HTMLDivElement>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (bad) markRef.current?.animate(UNLOCK_SHAKE, { duration: 480, easing: "linear" });
  }, [bad]);

  const submitPassword = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      // A gift recipient who declines the password: remembered as deliberate (the sheet would otherwise return on every
      // open) and the banner keeps asking for the backup. The words are not forced on them here.
      if (skip && reason === "gift") {
        markDeviceVaultChosen();
        markNeedsSeedBackup();
        onDone();
        return;
      }
      const bytes = await decryptDeviceVaultBytes();
      if (skip) {
        try {
          setWords(new TextDecoder().decode(bytes).trim().split(/\s+/));
        } finally {
          zeroBytes(bytes);
        }
        setStage("seed");
        return;
      }
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
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        setDone(true);
        await new Promise((r) => setTimeout(r, 520));
      }
      setPw("");
      setPw2("");
      setStage("seed");
    } catch (e) {
      console.error("[password setup]", e);
      setDone(false);
      setError(t("Heslo se nepodařilo nastavit."));
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    setWords([]);
    onDone();
  };

  let body;
  if (stage === "pw") {
    body = (
      <Screen className="pw-sheet">
        <PasswordMark level={skip ? 0 : level} bad={bad} done={done} markRef={markRef} />
        <h2 className="sht-title">{t("Heslo k peněžence")}</h2>
        <p className="sht-sub">
          {reason === "gift"
            ? t("Tahle peněženka vznikla z dárku. Zatím ji nic nechrání.")
            : reason === "backup"
              ? t("Nastav si heslo a zapiš si 12 slov.")
              : t("Větší platby se potvrzují heslem. Nastav si ho a platbu pak zopakuj.")}
        </p>
        {!skip && (
          <>
            <input
              className="sht-field"
              type="password"
              placeholder={t("Heslo (min. 8 znaků)")}
              value={pw}
              autoFocus={!COARSE_POINTER}
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
          </>
        )}
        {reason !== "spend" && (
          <label className="ex-check pw-skip">
            <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
            {t("Přeskočit heslo")}
          </label>
        )}
        {skip && (
          <p className="pw-note is-warn">
            <span className="pw-note-tab">{t("Pozor")}</span>
            {t("Peněženku otevře každý s odemčeným telefonem. Větší platby si vyžádají nastavení hesla.")}
          </p>
        )}
        {error && <p className="sht-error">{error}</p>}
        <button type="button" className="primary sht-wide" disabled={!ok || busy} onClick={() => void submitPassword()}>
          {busy ? t("Nastavuji…") : t("Pokračovat")}
        </button>
      </Screen>
    );
  } else {
    body = <SeedWordsScreen words={words} onDone={finish} />;
  }

  // A gift or a payment that needs the password cannot be waved away; the banner's "Zálohovat" was the user's own
  // tap, so there the backdrop closes it (the banner stays until the words were written down).
  return (
    <Sheet
      closing={closing}
      onBackdrop={reason === "backup" ? () => closeThen(onDone) : undefined}
      screenKey={stage}
    >
      {body}
    </Sheet>
  );
}
