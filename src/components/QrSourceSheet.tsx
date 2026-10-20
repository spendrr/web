import { useRef, useState } from "react";
import { Screen, Sheet, WaitingDots, useSheetClose } from "./sheet/PaySheet";
import { useT } from "../lib/i18n";

// Send's scan button branches here: the camera, or a QR already in the
// gallery. The decoder (and jsQR with it) loads only once an image is picked.
export default function QrSourceSheet({
  onCamera,
  onResult,
  onClose,
}: {
  onCamera: () => void;
  onResult: (text: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { closing, closeThen } = useSheetClose();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [reading, setReading] = useState(false);
  const [miss, setMiss] = useState(false);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || reading) return;
    setMiss(false);
    setReading(true);
    const { decodeQrFromImage } = await import("../lib/ui/qrImage");
    const text = await decodeQrFromImage(file);
    setReading(false);
    if (!text) {
      setMiss(true);
      return;
    }
    closeThen(() => onResult(text));
  };

  return (
    <Sheet closing={closing} onBackdrop={() => closeThen(onClose)} screenKey="qr-source">
      <Screen>
        <QrMark />
        <h2 className="sht-title">{t("Naskenovat QR kód")}</h2>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPick} />
        <div className="qr-source-actions">
          <button type="button" className="qr-source-btn" onClick={() => closeThen(onCamera)}>
            <CameraIcon />
            <span>{t("Fotoaparát")}</span>
          </button>
          {/* Opened straight from the tap: a picker started after the sheet's exit animation can be refused as not user-initiated. */}
          <button type="button" className="qr-source-btn" disabled={reading} onClick={() => fileRef.current?.click()}>
            {reading ? (
              <WaitingDots />
            ) : (
              <>
                <GalleryIcon />
                <span>{t("Z galerie")}</span>
              </>
            )}
          </button>
        </div>
        {miss && (
          <p className="sht-sub" role="status">
            {t("QR v obrázku nenalezen")}
          </p>
        )}
      </Screen>
    </Sheet>
  );
}

// A plain gray scan frame, no ring.
function QrMark() {
  return (
    <div className="sht-mark qrs-mark" aria-hidden="true">
      <svg viewBox="13 13 38 38">
        <path
          className="sht-mark-glyph"
          d="M17 26v-4a5 5 0 0 1 5-5h4M38 17h4a5 5 0 0 1 5 5v4M17 38v4a5 5 0 0 0 5 5h4M47 38v4a5 5 0 0 1-5 5h-4"
        />
        <rect className="sht-mark-glyph" x="27" y="27" width="10" height="10" rx="2" />
      </svg>
    </div>
  );
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.2a1 1 0 0 0 .8-.4l.9-1.2a1 1 0 0 1 .8-.4h3.6a1 1 0 0 1 .8.4l.9 1.2a1 1 0 0 0 .8.4h1.2A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12.5" r="3.2" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function GalleryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="8.6" cy="8.8" r="1.6" fill="currentColor" />
      <path d="m4.5 17 4.5-4.5 3 3 2.5-2.5 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
