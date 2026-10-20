// "Oznámení o platbách" as a sheet: what switching push on shares with our
// server, then the switch itself. The permission prompt comes from the
// browser only after the button, never on open. Copy mirrors what
// notifications.ts actually does: the Worker polls the Ark mailbox with a
// read-only authorization and relays an encrypted push.
import { useState } from "react";
import { useT } from "../lib/i18n";
import { enableNotifications, notificationPermission } from "../lib/notifications";
import { hapticSuccess } from "../lib/ui/haptics";
import type { WalletClient } from "../lib/wallet/bark";
import { Screen, Sheet, StatusMark, useSheetClose } from "./sheet/PaySheet";
import "./NotificationsSheet.css";

// Drawn bell on the sheet's ring: it rings once as the sheet lands, then the
// ring breathes (same vocabulary as StatusMark's incoming state).
function BellMark() {
  return (
    <div className="sht-mark nts-bell" aria-hidden="true">
      <svg viewBox="0 0 64 64">
        <circle className="sht-mark-track" cx="32" cy="32" r="28" />
        <circle className="sht-mark-ring nts-ring" cx="32" cy="32" r="28" />
        <g transform="translate(32 32) scale(0.68) translate(-32 -32)">
          <g className="nts-bell-body">
            <path className="sht-mark-glyph" d="M20 39c2-2 3-5 3-9v-2c0-5 4-9 9-9s9 4 9 9v2c0 4 1 7 3 9z" />
            <path className="sht-mark-glyph" d="M28.5 44.5a3.5 3.5 0 0 0 7 0" />
          </g>
        </g>
      </svg>
    </div>
  );
}

export default function NotificationsSheet({
  wallet,
  onClose,
}: {
  wallet: WalletClient;
  onClose: () => void;
}) {
  const t = useT();
  const { closing, closeThen } = useSheetClose();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [denied, setDenied] = useState(notificationPermission() === "denied");

  const close = () => closeThen(onClose);

  const enable = async () => {
    setBusy(true);
    const ok = await enableNotifications(wallet);
    setBusy(false);
    if (ok) {
      hapticSuccess();
      setDone(true);
    } else {
      setDenied(notificationPermission() === "denied");
    }
  };

  if (done) {
    return (
      <Sheet closing={closing} onBackdrop={close} screenKey="done">
        <Screen>
          <StatusMark state="success" />
          <h2 className="sht-title">{t("Oznámení zapnutá")}</h2>
          <p className="sht-sub">{t("Vypneš je kdykoli v Nastavení.")}</p>
          <button type="button" className="primary sht-wide" onClick={close}>
            {t("Hotovo")}
          </button>
        </Screen>
      </Sheet>
    );
  }

  return (
    <Sheet closing={closing} onBackdrop={busy ? undefined : close} screenKey="intro">
      <Screen>
        <BellMark />
        <h2 className="sht-title">{t("Oznámení o platbách")}</h2>
        <p className="sht-sub">{t("Dá vědět o příchozí platbě, i se zavřenou appkou. Připíše se po otevření.")}</p>

        <p className="nts-note">{t("Server Spendrru uvidí, že a kolik ti přišlo. Zprávy ani klíč ne.")}</p>

        {denied && <p className="nts-denied">{t("Blokováno v prohlížeči. Povol oznámení v jeho nastavení.")}</p>}

        {/* Once blocked, the browser never asks again: "Zapnout" would do
            nothing, so only the way out is left. */}
        {denied ? (
          <button type="button" className="secondary sht-wide" onClick={close}>
            {t("Zavřít")}
          </button>
        ) : (
          <div className="sht-actions">
            <button type="button" className="secondary" disabled={busy} onClick={close}>
              {t("Zrušit")}
            </button>
            <button type="button" className="primary" disabled={busy} onClick={() => void enable()}>
              {busy ? t("Povoluji…") : t("Zapnout")}
            </button>
          </div>
        )}
      </Screen>
    </Sheet>
  );
}
