// "Smazat peněženku z prohlížeče" as a two-step sheet. Step 1 says what goes
// away; step 2 is a hold-to-confirm button (HOLD_MS), so a stray tap can never
// wipe the wallet. Releasing early, leaving the button, or losing the pointer
// cancels and the fill drains back. Keyboard: hold Space or Enter.
//
// `pendingExit` drops the "funds stay reachable from your seed" reassurance:
// mid-exit it is false (see App.tsx, resetPendingExit). Not blocked outright,
// someone with a compromised device may still need to wipe it.
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { hapticSuccess, hapticTap } from "../lib/ui/haptics";
import { Screen, Sheet, StatusMark, useSheetClose } from "./sheet/PaySheet";
import "./DeleteWalletSheet.css";

const HOLD_MS = 2000;

export default function DeleteWalletSheet({
  pendingExit,
  onConfirm,
  onCancel,
}: {
  pendingExit: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const { closing, closeThen } = useSheetClose();
  const [step, setStep] = useState<"warn" | "hold">("warn");
  const [holding, setHolding] = useState(false);
  const timerRef = useRef<number | null>(null);
  const firedRef = useRef(false);

  const stop = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setHolding(false);
  }, []);

  const start = useCallback(() => {
    if (firedRef.current || timerRef.current !== null) return;
    hapticTap();
    setHolding(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      firedRef.current = true;
      setHolding(false);
      hapticSuccess();
      closeThen(onConfirm);
    }, HOLD_MS);
  }, [closeThen, onConfirm]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const cancel = () => closeThen(onCancel);

  if (step === "warn") {
    return (
      <Sheet closing={closing} onBackdrop={cancel} screenKey="warn">
        <Screen>
          <StatusMark state="warn" />
          <h2 className="sht-title">{t("Smazat peněženku z prohlížeče")}</h2>
          <p className="sht-sub">
            {pendingExit
              ? t("Nevratně smaže zašifrovanou peněženku (i otisk prstu) z tohoto prohlížeče. Bez zapsané seed phrase ztratíš přístup k prostředkům.")
              : t("Nevratně smaže zašifrovanou peněženku (i otisk prstu) z tohoto prohlížeče. Prostředky zůstanou dostupné přes seed phrase, bez ní ne.")}
          </p>
          {pendingExit && (
            <p className="sht-error">
              {t("POZOR: běží nouzový exit. Jeho rozpracovaný stav existuje jen tady a obnova ze seed phrase ho nevrátí. Počkej, až doběhne.")}
            </p>
          )}
          <div className="sht-actions">
            <button type="button" className="secondary" onClick={cancel}>
              {t("Zpět")}
            </button>
            <button type="button" className="danger" onClick={() => setStep("hold")}>
              {t("Pokračovat")}
            </button>
          </div>
        </Screen>
      </Sheet>
    );
  }

  return (
    <Sheet closing={closing} onBackdrop={cancel} screenKey="hold">
      <Screen>
        <h2 className="sht-title">{t("Podrž pro smazání")}</h2>
        <p className="sht-sub">
          {pendingExit
            ? t("Smažeš peněženku i s rozpracovaným exitem a riskuješ prostředky v něm.")
            : t("Podrž tlačítko 2 sekundy. Pustíš-li dřív, nic se nestane.")}
        </p>
        <button
          type="button"
          className={`dws-hold${holding ? " is-holding" : ""}`}
          style={{ ["--dws-hold-ms" as string]: `${HOLD_MS}ms` }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture?.(e.pointerId);
            start();
          }}
          onPointerUp={stop}
          onPointerCancel={stop}
          onLostPointerCapture={stop}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if ((e.key === " " || e.key === "Enter") && !e.repeat) {
              e.preventDefault();
              start();
            }
          }}
          onKeyUp={(e) => {
            if (e.key === " " || e.key === "Enter") stop();
          }}
          onBlur={stop}
        >
          <span className="dws-hold-fill" aria-hidden="true" />
          <span className="dws-hold-label">{holding ? t("Drž…") : t("Podrž pro smazání")}</span>
        </button>
        <button type="button" className="secondary sht-wide" onClick={cancel}>
          {t("Zpět")}
        </button>
      </Screen>
    </Sheet>
  );
}
