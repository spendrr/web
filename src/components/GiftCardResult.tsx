// The gift's result screen as a card (V2): swipe between motifs, tap to turn
// it over to the claim QR, then share it, save it to the gallery or print it.
// Drawing lives in lib/gift/giftCard.ts so all three outputs match the screen.
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import { QRCodeCanvas } from "qrcode.react";
import {
  A4_H_MM,
  A4_W_MM,
  CARD_W,
  MOTIFS,
  loadCardFonts,
  renderGalleryImage,
  renderPrintPage,
  renderShareImage,
  renderSide,
  type CardText,
} from "../lib/gift/giftCard";
import { MM_TO_PT, jpegPagePdf } from "../lib/gift/giftCardPdf";
import { localeFor, tf, useLang, useT } from "../lib/i18n";
import { useCopyLink } from "./sheet/ShareLink";
import "./sheet/ShareLink.css";
import "./GiftCardResult.css";

type Kind = "share" | "gallery" | "pdf";

// The sheet's screen entrance (sht-screen-in, PaySheet.css), which the card
// drawing waits out.
const ENTRANCE_MS = 450;

const shown = (e: SyntheticEvent<HTMLImageElement>) => e.currentTarget.classList.add("is-shown");

// Encoded synchronously (toDataURL, not toBlob): the share sheet has to open in
// the same task as the tap, or Safari refuses it as not user-initiated.
function canvasBytes(c: HTMLCanvasElement, type: string, quality?: number): Uint8Array {
  const url = c.toDataURL(type, quality);
  // Frees the bitmap now rather than whenever the canvas is collected (iOS caps canvas memory).
  c.width = 0;
  const bin = atob(url.slice(url.indexOf(",") + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function download(file: File) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// Android's share sheet has no "save to gallery"; a download lands in
// Downloads, which the gallery shows. iOS saves to Photos only from the share sheet.
const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

export function GiftCardResult({
  link,
  amountSats,
  message,
  expiresAt,
  shareText,
}: {
  link: string;
  amountSats: number;
  message?: string;
  expiresAt: number;
  shareText: string;
}) {
  const t = useT();
  const lang = useLang();
  const { copied, copy, error } = useCopyLink(link);
  const qrRef = useRef<HTMLCanvasElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [cur, setCur] = useState(0);
  const [flipped, setFlipped] = useState<number | null>(null);
  const [fontsReady, setFontsReady] = useState(false);
  const [busy, setBusy] = useState<Kind | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const amount = amountSats.toLocaleString(localeFor(lang));
  const until = tf(t("platí do {date}"), { date: new Date(expiresAt).toLocaleDateString(localeFor(lang)) });
  const text = useCallback(
    (occasion: string): CardText => ({
      occasion,
      amount,
      unit: "sats",
      message,
      until,
      scan: t("Naskenuj a vyber"),
      details: [until, t("pak se vrátí odesílateli")],
      warning: t("Kdo má QR, má peníze."),
    }),
    [amount, message, until, t],
  );

  useEffect(() => {
    let live = true;
    void loadCardFonts().then(() => live && setFontsReady(true));
    return () => {
      live = false;
    };
  }, []);

  // Every face drawn at the card's on-screen size and shown as an image,
  // again whenever that size changes (rotation, a resized window). Images, not
  // live canvases: the turn is a plain CSS 3D flip on the compositor, and
  // canvas layers do not honour backface-visibility reliably (Chrome showed a
  // back through an unturned card). data: URLs, because the CSP's img-src
  // allows data: and not blob:.
  //
  // The chosen card's front at once, then the other fronts and all backs one
  // per idle slot after the sheet's entrance: drawing all ten at once blocked
  // the main thread for the whole entrance and made it stutter. JPEG, which
  // encodes far faster than PNG; the card has no transparency to keep.
  const [faces, setFaces] = useState<string[]>([]);
  const curRef = useRef(0);
  useEffect(() => {
    curRef.current = cur;
  }, [cur]);
  useEffect(() => {
    if (!fontsReady) return;
    let lastW = -1;
    let run = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = (fn: () => void, ms: number) => {
      timer = setTimeout(() => {
        if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: 300 });
        else fn();
      }, ms);
    };
    const draw = (delay: number) => {
      const w = railRef.current?.firstElementChild?.clientWidth ?? 0;
      if (!w || w === lastW) return;
      lastW = w;
      const mine = ++run;
      const k = (w / CARD_W) * Math.min(3, window.devicePixelRatio || 1);
      const near = curRef.current;
      const order = MOTIFS.map((_, i) => i).sort((a, b) => Math.abs(a - near) - Math.abs(b - near));
      // Fronts before backs: a back only shows once its card is turned.
      const jobs = [...order.map((i) => i * 2), ...order.map((i) => i * 2 + 1)];
      let first = true;
      const step = () => {
        const slot = jobs.shift();
        if (slot === undefined || mine !== run) return;
        const m = MOTIFS[slot >> 1];
        const c = renderSide(slot % 2 ? "back" : "front", m, text(t(m.occasion)), qrRef.current, k, false);
        const url = c.toDataURL("image/jpeg", 0.92);
        c.width = 0;
        setFaces((prev) => {
          const next = prev.slice();
          next[slot] = url;
          return next;
        });
        later(step, first ? delay : 0);
        first = false;
      };
      requestAnimationFrame(step);
    };
    draw(ENTRANCE_MS);
    const ro = new ResizeObserver(() => draw(0));
    if (railRef.current) ro.observe(railRef.current);
    return () => {
      run++;
      clearTimeout(timer);
      ro.disconnect();
    };
  }, [fontsReady, text, t]);
  const facesDone = faces.filter(Boolean).length === MOTIFS.length * 2;


  // Files per motif and kind, made on first use and kept for the next tap.
  const files = useRef(new Map<string, File>());
  useEffect(() => {
    files.current.clear();
  }, [text]);

  const fileFor = (i: number, kind: Kind): File => {
    const key = `${i}:${kind}`;
    const hit = files.current.get(key);
    if (hit) return hit;
    const m = MOTIFS[i];
    const tx = text(t(m.occasion));
    const qr = qrRef.current;
    let f: File;
    if (kind === "share") {
      f = new File([canvasBytes(renderShareImage(m, tx), "image/jpeg", 0.92) as BlobPart], "spendrr-darek.jpg", {
        type: "image/jpeg",
      });
    } else if (kind === "gallery") {
      // JPEG like the faces: quick to encode, and Photos stores it as it is.
      f = new File([canvasBytes(renderGalleryImage(m, tx, qr), "image/jpeg", 0.92) as BlobPart], "spendrr-darek-qr.jpg", {
        type: "image/jpeg",
      });
    } else {
      const page = canvasBytes(renderPrintPage(m, tx, qr, t("Vystřihni a přelož v půlce.")), "image/jpeg", 0.92);
      const pdf = jpegPagePdf(page, A4_W_MM * MM_TO_PT, A4_H_MM * MM_TO_PT);
      f = new File([pdf as BlobPart], "spendrr-darek.pdf", { type: "application/pdf" });
    }
    files.current.set(key, f);
    return f;
  };

  // The two images of the chosen motif, made once the cards are drawn and the
  // swipe has settled, so neither the entrance nor the tap waits on them. The
  // PDF (an A4 page at 300 dpi) is made on its own tap.
  useEffect(() => {
    if (!fontsReady || !facesDone) return;
    // Separate slots, so neither holds the main thread for long.
    const make = (kind: Kind) => () => {
      try {
        fileFor(cur, kind);
      } catch {
        // Made again on the tap, which reports a failure.
      }
    };
    const timers = [setTimeout(make("share"), 600), setTimeout(make("gallery"), 900)];
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur, fontsReady, facesDone, text]);

  const onScroll = () => {
    const r = railRef.current;
    if (!r) return;
    const mid = r.scrollLeft + r.clientWidth / 2;
    let best = 0;
    let bestD = Infinity;
    [...r.children].forEach((el, i) => {
      const e = el as HTMLElement;
      const d = Math.abs(e.offsetLeft + e.offsetWidth / 2 - mid);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best !== cur) {
      setCur(best);
      setFlipped(null);
    }
  };

  const tapCard = (i: number, el: HTMLElement) => {
    if (i === cur) setFlipped((f) => (f === i ? null : i));
    else el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  };

  // Synchronous up to navigator.share, which must run inside the tap. A tap
  // while a share sheet is open is ignored here rather than by disabling the
  // buttons: App.css's button:disabled would grey them and give back the
  // offset shadow these flat buttons drop.
  const act = (kind: Kind) => {
    if (busy) return;
    setExportError(null);
    let f: File;
    try {
      f = fileFor(cur, kind);
    } catch {
      setExportError(t("Soubor se nepodařilo vytvořit."));
      return;
    }
    const canShareFile = navigator.canShare?.({ files: [f] }) ?? false;
    let pending: Promise<void>;
    if (kind === "share") {
      if (canShareFile) pending = navigator.share({ files: [f], text: `${shareText} ${link}` });
      else if (navigator.share) pending = navigator.share({ text: shareText, url: link });
      else {
        copy();
        return;
      }
    } else if (isAndroid || !canShareFile) {
      download(f);
      return;
    } else {
      pending = navigator.share({ files: [f] });
    }
    setBusy(kind);
    pending
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (kind === "share") copy();
        else setExportError(t("Sdílení se neotevřelo. Zkus to znovu."));
      })
      .finally(() => setBusy(null));
  };

  return (
    <>
      <QRCodeCanvas
        ref={qrRef}
        value={link}
        size={512}
        level="M"
        marginSize={0}
        fgColor="#16130d"
        bgColor="#f9f5ec"
        style={{ display: "none" }}
      />
      <div className="gcr-rail" ref={railRef} onScroll={onScroll}>
        {MOTIFS.map((m, i) => (
          <button
            key={m.id}
            type="button"
            className={`gcr-card${i === cur ? " is-current" : ""}${flipped === i ? " is-flipped" : ""}`}
            aria-pressed={i === cur}
            aria-label={`${t(m.name)}. ${t("Otočit kartu")}`}
            onClick={(e) => tapCard(i, e.currentTarget)}
          >
            <span className="gcr-inner">
              {/* Each face is ink until its drawing arrives, which then fades in. */}
              <span className="gcr-face">
                {faces[i * 2] && <img src={faces[i * 2]} alt="" draggable={false} onLoad={shown} />}
              </span>
              <span className="gcr-face gcr-back">
                {faces[i * 2 + 1] && <img src={faces[i * 2 + 1]} alt="" draggable={false} onLoad={shown} />}
              </span>
            </span>
          </button>
        ))}
      </div>
      {/* Card actions sit with the card; the sheet's own action is Sdílet below. */}
      <div className="gcr-tools">
        <button type="button" className="gcr-tool" onClick={() => act("gallery")}>
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 4v11" />
            <path d="m7 10 5 5 5-5" />
            <path d="M5 20h14" />
          </svg>
          {t("Uložit")}
        </button>
        <button type="button" className="gcr-tool" onClick={() => act("pdf")}>
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M7 9V3h10v6" />
            <rect x="3" y="9" width="18" height="8" rx="2" />
            <path d="M7 14h10v7H7z" />
          </svg>
          {t("Tisk")}
        </button>
      </div>
      {copied && <p className="shl-hint">{t("Odkaz zkopírován")}</p>}
      {(exportError ?? error) && <p className="sht-error">{exportError ?? error}</p>}
      <p className="sht-sub">{t("Kdo má odkaz nebo QR, má dárek.")}</p>
      <button type="button" className="primary sht-wide" onClick={() => act("share")}>
        {t("Sdílet")}
      </button>
    </>
  );
}
