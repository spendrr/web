import { CHANGELOG, changelogItemText, isBetaChangelogItem } from "../lib/changelog";
import { useT } from "../lib/i18n";
import { Screen, Sheet, useSheetClose } from "./sheet/PaySheet";
import "./WhatsNewModal.css";

// Shown once, right after the app updates to a new version (see
// lib/whatsNew.ts for the "have we seen this version" bookkeeping). Not a
// full changelog browser, just the single newest entry so it reads like a
// short release note instead of a wall of history. How to write an entry:
// the header of lib/changelog.ts. The shared bottom sheet: the home screen
// icon on top says whose update this is; the changes are a left-aligned list,
// they are read, not glanced at. Styling under `wns-`.
export default function WhatsNewModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { closing, closeThen } = useSheetClose();
  const entry = CHANGELOG[0];
  const close = () => closeThen(onClose);

  return (
    <Sheet closing={closing} onBackdrop={close} screenKey="whats-new">
      <Screen>
        <img className="wns-icon" src="/icon-192.png" width={72} height={72} alt="" />
        <p className="wns-eyebrow">
          {t("Nová verze")} {__APP_VERSION__}
        </p>
        <h2 className="sht-title wns-title">{t(entry.title)}</h2>
        <ul className="wns-items">
          {entry.items.map((item, i) => (
            <li key={i}>
              {isBetaChangelogItem(item) && <span className="wns-beta">{t("V betě")}</span>}
              {t(changelogItemText(item))}
            </li>
          ))}
        </ul>
        <button type="button" className="sht-wide wns-ok" onClick={close}>
          {t("Chápu")}
        </button>
      </Screen>
    </Sheet>
  );
}
