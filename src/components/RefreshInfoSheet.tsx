// Short info card shown over the wallet home screen while a VTXO refresh is
// running. Purely informational: it closes itself after
// REFRESH_SHEET_MS, and the OK button drains to show when. Touching the card
// stops the countdown, so someone reading it isn't cut off mid-sentence.
import { useEffect, useRef, useState } from "react";
import { localeFor, tf, useLang, useT } from "../lib/i18n";
import { Screen, Sheet, StatusMark, useSheetClose } from "./sheet/PaySheet";

const REFRESH_SHEET_MS = 6000;
// The countdown starts once the sheet has landed (PaySheet's SHEET_ENTER_MS).
const ENTER_MS = 520;

export default function RefreshInfoSheet({
  amountSats,
  withheld,
  onClose,
}: {
  amountSats: number;
  // True when the refreshing coins are missing from the headline balance
  // (interactive round, inputs locked); false when they are still inside it.
  withheld: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const { closing, closeThen } = useSheetClose();
  const [held, setHeld] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  // The parent passes a new onClose on every render (the dashboard re-renders
  // every few seconds); as an effect dependency that would restart the timer
  // and the sheet would outlive the drained button. Read it from a ref.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const close = () => {
    window.clearTimeout(timerRef.current);
    closeThen(() => onCloseRef.current());
  };

  useEffect(() => {
    if (held) return;
    timerRef.current = window.setTimeout(() => closeThen(() => onCloseRef.current()), ENTER_MS + REFRESH_SHEET_MS);
    return () => window.clearTimeout(timerRef.current);
  }, [held, closeThen]);

  const amount = amountSats.toLocaleString(localeFor(lang)).replace(/\s/g, " ");

  return (
    <Sheet closing={closing} onBackdrop={close} screenKey="refresh">
      <div
        onPointerDown={(e) => {
          if (!(e.target as HTMLElement).closest(".sht-refresh-ok")) setHeld(true);
        }}
      >
        <Screen>
          <StatusMark state="refresh" />
          <h2 className="sht-title">{t("Obnovuji mince")}</h2>
          <p className="sht-sub sht-refresh-sub">
            {tf(t("Prodlužuji platnost {amount} sats."), { amount })}
            {"\n"}
            {withheld ? t("Pak se vrátí do zůstatku.") : t("Nemusíš nic dělat.")}
          </p>
          <button
            type="button"
            className={`secondary sht-wide sht-refresh-ok${held ? " is-held" : ""}`}
            style={{ ["--sht-refresh-ms" as string]: `${REFRESH_SHEET_MS}ms`, ["--sht-refresh-delay" as string]: `${ENTER_MS}ms` }}
            onClick={close}
          >
            {t("OK")}
          </button>
        </Screen>
      </div>
    </Sheet>
  );
}
