// Shown instead of opening the wallet when another tab or window (or the
// installed app) already has it open; see walletTabLock.ts for why two open
// copies are not allowed. Closes itself as soon as the other copy is locked
// or closed, so coming back to this tab after locking the other one just
// leaves the unlock screen ready.
import { useEffect } from "react";
import { useT } from "../lib/i18n";
import { walletTabLock } from "../lib/wallet/walletTabLock";
import { Screen, Sheet, StatusMark, useSheetClose } from "./sheet/PaySheet";

const RECHECK_MS = 1500;

export default function WalletOpenElsewhereSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { closing, closeThen } = useSheetClose();

  useEffect(() => {
    let stopped = false;
    const timer = window.setInterval(() => {
      void walletTabLock.heldElsewhere().then((held) => {
        if (!held && !stopped) {
          stopped = true;
          window.clearInterval(timer);
          closeThen(onClose);
        }
      });
    }, RECHECK_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [closeThen, onClose]);

  const close = () => closeThen(onClose);

  return (
    <Sheet closing={closing} onBackdrop={close} screenKey="open-elsewhere">
      <Screen>
        <StatusMark state="warn" />
        <h2 className="sht-title">{t("Peněženka je otevřená v jiném okně")}</h2>
        <p className="sht-sub">
          {t("Najednou může být otevřená jen na jednom místě. Zamkni ji v tom druhém okně nebo ho zavři a pak ji odemkni tady.")}
        </p>
        <button type="button" className="secondary sht-wide" onClick={close}>
          {t("Rozumím")}
        </button>
      </Screen>
    </Sheet>
  );
}
