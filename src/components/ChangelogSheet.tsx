import { CHANGELOG, changelogItemText, isBetaChangelogItem } from "../lib/changelog";
import { useT } from "../lib/i18n";
import { Screen, Sheet, useSheetClose } from "./sheet/PaySheet";
import "./ChangelogSheet.css";

// Settings → O peněžence → Zobrazit changelog: every entry, newest first, on
// the shared sheet. The list scrolls on its own so the close button stays in
// reach. The post-update sheet (WhatsNewModal) shows only the newest entry.
// Styling under `clg-`.
export default function ChangelogSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { closing, closeThen } = useSheetClose();
  const close = () => closeThen(onClose);

  return (
    <Sheet closing={closing} onBackdrop={close} screenKey="changelog">
      <Screen>
        <div className="sht-mark clg-mark" aria-hidden="true">
          <svg viewBox="2.2 1.4 19.8 19.8" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19.7 15.6A8.5 8.5 0 1 1 17.5 5.5" />
            <path d="M12 7.6V12l3 2" />
            <path d="M19.55 7.2 15.7 6.8 18.4 3.5Z" strokeWidth="1" />
          </svg>
        </div>
        <h2 className="sht-title">{t("Co je nového")}</h2>
        <p className="clg-version">
          {t("Verze")} {__APP_VERSION__}
        </p>
        <div className="clg-list">
          {CHANGELOG.map((entry, i) => (
            <section key={i} className="clg-entry">
              <div className="clg-date">{entry.date}</div>
              <h3 className="clg-title">{t(entry.title)}</h3>
              <ul className="clg-items">
                {entry.items.map((item, j) => (
                  <li key={j}>
                    {isBetaChangelogItem(item) && <span className="clg-beta">{t("V betě")}</span>}
                    {t(changelogItemText(item))}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <button type="button" className="secondary sht-wide" onClick={close}>
          {t("Zavřít")}
        </button>
      </Screen>
    </Sheet>
  );
}
