// The "Dárek je připravený" sheet for a gift that already exists, opened from
// the sent-gifts list (V2): the same card, actions and Zrušit dárek as right
// after the gift was made (GiftComposeModal.tsx).
import { useEffect, useState } from "react";
import type { WalletClient } from "../lib/wallet/bark";
import { buildGiftUrl } from "../lib/gift/giftLink";
import { decryptGiftMnemonic, type OutgoingGift } from "../lib/gift/giftStore";
import { emptyMeansGone, reclaimGift } from "../lib/gift/giftReclaim";
import { localeFor, useLang, useT } from "../lib/i18n";
import { surfaceError } from "../lib/appErrors";
import { Screen, Sheet, StatusMark, useSheetClose } from "./sheet/PaySheet";
import { GiftCardResult } from "./GiftCardResult";

/** Hotovo and Zrušit dárek under the card; Zrušit asks once before it takes the gift back. */
export function GiftDoneRow({
  onDone,
  onCancelGift,
}: {
  onDone: () => void;
  onCancelGift: () => Promise<void>;
}) {
  const t = useT();
  const [cancel, setCancel] = useState<"idle" | "confirm" | "busy">("idle");
  if (cancel === "idle") {
    return (
      <div style={{ display: "flex", justifyContent: "center", gap: 28 }}>
        <button type="button" className="sht-link" onClick={onDone}>
          {t("Hotovo")}
        </button>
        <button type="button" className="sht-link" onClick={() => setCancel("confirm")}>
          {t("Zrušit dárek")}
        </button>
      </div>
    );
  }
  return (
    <>
      <p className="sht-sub">{t("Dárek se vrátí na tvůj zůstatek a odkaz přestane fungovat.")}</p>
      <div style={{ display: "flex", justifyContent: "center", gap: 28 }}>
        <button type="button" className="sht-link" disabled={cancel === "busy"} onClick={() => setCancel("idle")}>
          {t("Ne")}
        </button>
        <button
          type="button"
          className="sht-link"
          disabled={cancel === "busy"}
          onClick={() => {
            setCancel("busy");
            // Back to the question if it failed; the caller shows why.
            void onCancelGift().finally(() => setCancel("idle"));
          }}
        >
          {cancel === "busy" ? t("Vracím…") : t("Ano, zrušit")}
        </button>
      </div>
    </>
  );
}

export default function GiftReadySheet({
  wallet,
  encryptionKey,
  gift,
  onClose,
}: {
  wallet: WalletClient;
  encryptionKey: CryptoKey;
  gift: OutgoingGift;
  onClose: (changed: boolean) => void;
}) {
  const t = useT();
  const lang = useLang();
  const { closing, closeThen } = useSheetClose();
  const [link, setLink] = useState<string | null>(null);
  const [phase, setPhase] = useState<"result" | "cancelled" | "taken">("result");
  const [error, setError] = useState<string | null>(null);
  // No backdrop or system back while a take-back runs: closing then would
  // report "unchanged" and leave the list showing the gift as waiting.
  const [cancelling, setCancelling] = useState(false);

  // The same link the gift was made with (GiftComposeModal builds it the same way).
  useEffect(() => {
    let live = true;
    decryptGiftMnemonic(encryptionKey, gift.mnemonicCipher)
      .then((mnemonic) => {
        if (!live) return;
        setLink(
          buildGiftUrl(window.location.origin, {
            mnemonic,
            amountSats: gift.amountSats,
            message: gift.message,
            id: gift.id,
            passwordless: true,
          }),
        );
      })
      .catch((e) => live && surfaceError(e, setError));
    return () => {
      live = false;
    };
  }, [encryptionKey, gift]);

  const close = () => closeThen(() => onClose(phase !== "result"));

  const cancelGift = async () => {
    setError(null);
    setCancelling(true);
    try {
      const outcome = await reclaimGift(wallet, encryptionKey, gift, { terminalWhenEmpty: emptyMeansGone(gift) });
      setPhase(outcome === "reclaimed" ? "cancelled" : "taken");
    } catch (e) {
      surfaceError(e, setError);
    } finally {
      setCancelling(false);
    }
  };

  let body;
  if (phase === "cancelled") {
    body = (
      <Screen>
        <StatusMark state="sent" />
        <h2 className="sht-title">{t("Dárek je zpět")}</h2>
        <p className="sht-sub">{gift.amountSats.toLocaleString(localeFor(lang))} sats</p>
        <button type="button" className="secondary sht-wide" onClick={close}>
          {t("Hotovo")}
        </button>
      </Screen>
    );
  } else if (phase === "taken") {
    body = (
      <Screen>
        <StatusMark state="warn" />
        <h2 className="sht-title">{t("Tenhle dárek už je vyzvednutý")}</h2>
        <button type="button" className="secondary sht-wide" onClick={close}>
          {t("Zavřít")}
        </button>
      </Screen>
    );
  } else {
    body = (
      <Screen>
        <StatusMark state="sent" />
        <h2 className="sht-title">{t("Dárek je připravený")}</h2>
        {link && (
          <GiftCardResult
            link={link}
            amountSats={gift.amountSats}
            message={gift.message}
            expiresAt={gift.expiresAt}
            shareText={t("Poslal jsem ti bitcoin 🎁")}
          />
        )}
        {error && <p className="sht-error">{error}</p>}
        <GiftDoneRow onDone={close} onCancelGift={cancelGift} />
      </Screen>
    );
  }

  return (
    <Sheet closing={closing} onBackdrop={cancelling ? undefined : close} screenKey={phase}>
      {body}
    </Sheet>
  );
}
