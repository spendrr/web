// Shown when the person taps "Později" on the backup intro. The wallet already exists by then and
// the dashboard banner keeps asking, so this is a single beat: say what skipping costs, make the safe path the
// primary button, and let them go on if they mean it. Closing it by the backdrop stays on the intro.
import { useT } from "../lib/i18n";
import { Screen, Sheet, StatusMark, useSheetClose } from "./sheet/PaySheet";

export default function SkipBackupSheet({
  onBackup,
  onSkip,
  onClose,
}: {
  onBackup: () => void;
  onSkip: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const { closing, closeThen } = useSheetClose();

  return (
    <Sheet closing={closing} onBackdrop={() => closeThen(onClose)} screenKey="skip-backup">
      <Screen>
        <StatusMark state="warn" />
        <h2 className="sht-title">{t("Odložit zálohu?")}</h2>
        <p className="sht-sub">
          {t("Bez 12 slov o peníze přijdeš, když ztratíš telefon. Připomeneme ti to.")}
        </p>
        <div className="sht-actions">
          <button type="button" className="secondary" onClick={() => closeThen(onSkip)}>
            {t("Přesto později")}
          </button>
          <button type="button" onClick={() => closeThen(onBackup)}>
            {t("Zálohovat teď")}
          </button>
        </div>
      </Screen>
    </Sheet>
  );
}
