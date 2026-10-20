import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import jsQR from "jsqr";
import { Screen, Sheet, StatusMark, WaitingDots, useSheetClose } from "./sheet/PaySheet";
import { useT } from "../lib/i18n";
import { hapticTap } from "../lib/ui/haptics";
import { createDarknessTracker, meanLuma } from "../lib/ui/sceneDarkness";
import { isMotionOn, withViewTransition } from "../lib/ui/motion";
import {
  boxFromCorners,
  coverMapper,
  coverVisibleRect,
  createBoxPredictor,
  createLockSpring,
  type LockBox,
  type Point,
} from "../lib/ui/qrLock";

// Frames are decoded at a capped resolution — jsQR's cost scales with pixel
// count, and scanning at full camera resolution (often 1080p+) is both
// unnecessary for a QR code held a foot from the lens and heavy enough to
// visibly compete with the rest of the UI for the main thread. The cap
// applies to the part of the frame the preview shows (see readFrame).
const MAX_SCAN_DIMENSION = 480;
// Every animation frame is too often for jsQR to need to re-run; this keeps
// the scan responsive while leaving headroom on slower phones.
const SCAN_INTERVAL_MS = 150;
// BarcodeDetector decodes natively, off the main thread, so it can look again
// soon after the last answer (it never overlaps: detectingRef).
const DETECTOR_INTERVAL_MS = 50;
// Light-on-dark codes are rare in wallets. jsQR's "attemptBoth" read every
// frame twice to find one; now only every INVERTED_EVERY-th tick does, the
// rest take one normal pass. (Not "onlyInvert" on those ticks: in jsQR 1.4.0
// it throws on every frame, code or not.) Measured over a camera-like feed,
// this keeps the per-tick cost where it was while jsQR gets the larger
// visible-only crop (readFrame).
const INVERTED_EVERY = 3;
// The browser default is 640x480, where a dense Lightning invoice held at a
// comfortable distance gets 2-3 px per module. 4:3 like that default, so the
// square preview keeps its framing (a 16:9 mode crops the sensor and would
// look zoomed in); `ideal`, so a camera without the mode picks its closest.
const CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: "environment" },
  width: { ideal: 1280 },
  height: { ideal: 960 },
  aspectRatio: { ideal: 4 / 3 },
};
// A code already in view when the camera starts can decode on the very first
// frame, closing the modal before the preview ever visibly appeared — which
// reads as a glitch rather than a scan. The result is held until the preview
// has been on screen at least this long; decoding itself isn't delayed.
const MIN_PREVIEW_MS = 300;
// The torch is toggled by a double tap on the camera preview rather than
// a button, because only a running track can say whether there is a torch at
// all, so a button could only ever pop in late. Counted by hand like
// Dashboard's lock gesture: mobile browsers take a native double tap as zoom.
const DOUBLE_TAP_MS = 350;
// How often a tiny copy of the frame is checked for a dark scene, which is
// when the torch hint shows (sceneDarkness.ts). The mean of a 32x32 thumbnail
// is plenty, and on Android, where BarcodeDetector reads the <video> itself,
// it is the only frame the page draws.
const DARK_SAMPLE_SIZE = 32;
const DARK_SAMPLE_INTERVAL_MS = 500;
// Motion design: while the brackets hold on a found code, jsQR looks for it
// again this often so they follow the code as the hand moves. A spring fills
// the frames in between; decoding every frame would compete with it.
const LOCK_TRACK_INTERVAL_MS = 80;
// How far the brackets sit outside the code's own corners.
const LOCK_PAD = 20;

// The `torch` capability/constraint isn't in lib.dom's MediaTrackCapabilities
// yet (Chromium-only, non-standard) — this narrows just enough to feature-
// detect and toggle it without casting to `any` at every call site.
type TorchCapableTrack = MediaStreamTrack & {
  applyConstraints: (constraints: MediaTrackConstraints & { advanced?: ({ torch?: boolean })[] }) => Promise<void>;
};

// Shape Detection API — not in lib.dom yet, Chromium-only (so this is an
// Android-Chrome speedup, not something iOS Safari/Firefox ever get). Where
// available it decodes hardware-accelerated straight off the <video> element,
// which is both faster and more tolerant of tricky angles/lighting than
// jsQR's pure-JS scan over a downscaled canvas frame — so it's used in
// preference to jsQR, which stays as the universal fallback.
type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
};
type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorLike;
type Inversion = "dontInvert" | "attemptBoth";

export default function QrScannerModal({
  onResult,
  onClose,
}: {
  onResult: (text: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const trackRef = useRef<TorchCapableTrack | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastScanRef = useRef(0);
  const firstFrameAtRef = useRef<number | null>(null);
  const resultTimerRef = useRef<number | null>(null);
  const doneRef = useRef(false);
  // Motion design (beta): on a hit the corner brackets jump onto the code.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const lockRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLSpanElement | null>(null);
  const lockRafRef = useRef<number | null>(null);
  const detectorRef = useRef<BarcodeDetectorLike | null>(null);
  // detect() is async — this stops a slow frame from overlapping the next
  // scan tick rather than queuing detections faster than they resolve.
  const detectingRef = useRef(false);
  const lastTapRef = useRef(0);
  const { closing, closeThen } = useSheetClose();
  // `retry` is false when trying again can't help (no camera API at all).
  const [error, setError] = useState<{ message: string; retry: boolean } | null>(null);
  // Bumped by "Zkusit znovu" to run the camera effect again.
  const [attempt, setAttempt] = useState(0);
  // The first camera frame is on screen ("Spouštím kameru…" shows until then).
  const [live, setLive] = useState(false);
  // The camera sees a dark scene, so the torch hint shows.
  const [dark, setDark] = useState(false);
  // Camera flash/torch — only some devices/browsers (mainly Android Chrome)
  // expose this, so the button only ever appears once a live track has
  // actually reported the capability rather than being shown optimistically.
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  // The guide frame's pulse ring runs for a few seconds to draw the eye to
  // where to hold the QR code, then fades out — it'd be distracting to keep
  // pulsing for as long as the scanner stays open.
  const [pulsing, setPulsing] = useState(true);
  const t = useT();

  // The pulse starts with the first frame: counted from mount, a slow
  // permission prompt used it up before the camera showed anything. It ends
  // by itself (a whole number of iterations, back at rest, see
  // .qr-scanner-frame.is-pulsing); dropping the class mid-cycle snapped the
  // frame back. This only clears the class afterwards, so a retry re-arms it.
  useEffect(() => {
    if (!live) return;
    const timer = window.setTimeout(() => setPulsing(false), 6200);
    return () => window.clearTimeout(timer);
  }, [live]);

  const toggleTorch = () => {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    track
      .applyConstraints({ advanced: [{ torch: next }] })
      .then(() => setTorchOn(next))
      .catch(() => {
        // Some devices report the capability but reject the constraint at
        // runtime (e.g. torch briefly unavailable while focusing) — leave
        // torchOn as-is rather than claiming a state that didn't take.
      });
  };

  // A double tap anywhere on the preview toggles the torch.
  const onPreviewPointerDown = (e: React.PointerEvent) => {
    if (!torchSupported || !e.isPrimary || e.button !== 0) return;
    const now = performance.now();
    if (now - lastTapRef.current < DOUBLE_TAP_MS) {
      lastTapRef.current = 0;
      hapticTap();
      toggleTorch();
    } else {
      lastTapRef.current = now;
    }
  };

  // The sheet slides out before onClose. A result still held for the
  // lock-on is dropped: delivered mid-close, it would fill the field and, for the homepage's scan shortcut,
  // onClose would then take the user home anyway. The paused video keeps its
  // last frame for the exit instead of going black; unmount stops the camera.
  const requestClose = useCallback(() => {
    if (closing) return;
    if (resultTimerRef.current !== null) window.clearTimeout(resultTimerRef.current);
    resultTimerRef.current = null;
    if (lockRafRef.current !== null) cancelAnimationFrame(lockRafRef.current);
    lockRafRef.current = null;
    doneRef.current = true;
    videoRef.current?.pause();
    closeThen(onClose);
  }, [closing, closeThen, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  const retry = () => {
    setError(null);
    setLive(false);
    setPulsing(true);
    setAttempt((n) => n + 1);
  };

  useEffect(() => {
    let cancelled = false;

    const stop = () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      if (lockRafRef.current !== null) cancelAnimationFrame(lockRafRef.current);
      lockRafRef.current = null;
      if (resultTimerRef.current !== null) window.clearTimeout(resultTimerRef.current);
      resultTimerRef.current = null;
      // Stopping the track releases the camera hardware, which turns the
      // torch off on its own — no separate applyConstraints(torch: false)
      // needed here.
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      trackRef.current = null;
    };

    // Motion design: moves the corner brackets from the guide frame onto the
    // code and keeps them on it until the result is handed over. A single
    // snap used to land where the code was in the frame that found it, and
    // the hand moving the phone during the hold left the brackets behind, so
    // jsQR now looks again every LOCK_TRACK_INTERVAL_MS (same payload only),
    // the code's position is carried forward along its recent velocity
    // between sightings, and a spring (qrLock.ts) follows. Corners are in
    // the video's own pixels, mapped through object-fit: cover. Returns how
    // long to hold before handing the result on; 0 when there is nothing to
    // animate, which keeps the old timing.
    const lockOn = (data: string, corners: Point[] | undefined, inversion: Inversion): number => {
      const video = videoRef.current, canvas = canvasRef.current;
      const viewport = viewportRef.current, lock = lockRef.current;
      if (!isMotionOn() || !corners || !video || !canvas || !viewport || !lock) return 0;
      const vw = video.videoWidth, vh = video.videoHeight;
      const ew = viewport.clientWidth, eh = viewport.clientHeight;
      if (!vw || !vh || !ew || !eh) return 0;
      const toScreen = coverMapper(vw, vh, ew, eh);
      const boxFor = (pts: Point[]) => {
        const box = boxFromCorners(pts.map(toScreen), LOCK_PAD);
        return box && box.side >= 24 ? box : null;
      };
      const first = boxFor(corners);
      if (!first) return 0;
      const seen = createBoxPredictor();
      seen.see(first, performance.now() / 1000);
      // Starts on the guide frame (inset 12% in the CSS).
      const spring = createLockSpring({ cx: ew / 2, cy: eh / 2, side: ew * 0.76, angle: 0 });
      // The guide frame, and with it the dim around it, travels with the
      // brackets, so the dim meets their outer edge on the code. Its pulse is
      // stopped first: a running CSS animation would override the inline
      // transform. The radius eases to the brackets' own (CSS transition).
      const frame = frameRef.current;
      if (frame) {
        frame.style.animation = "none";
        if (ringRef.current) ringRef.current.style.animation = "none";
        frame.style.borderRadius = "14px";
      }
      const draw = (b: LockBox) => {
        for (const el of frame ? [lock, frame] : [lock]) {
          el.style.left = `${b.cx - b.side / 2}px`;
          el.style.top = `${b.cy - b.side / 2}px`;
          el.style.width = `${b.side}px`;
          el.style.height = `${b.side}px`;
          el.style.transform = `rotate(${b.angle}deg)`;
        }
      };
      draw(spring.step(first, 0));
      lock.hidden = false;
      try {
        ringRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, fill: "forwards" });
        lock.querySelector(".qr-lock-flash")?.animate([{ opacity: 0 }, { opacity: 0.75, offset: 0.25 }, { opacity: 0 }], {
          duration: 320,
          delay: 380,
          easing: "ease-out",
        });
      } catch {
        // Decoration only; the brackets still move.
      }
      let last = performance.now();
      let lastTrack = last;
      const follow = (now: number) => {
        if (cancelled) return;
        if (now - lastTrack >= LOCK_TRACK_INTERVAL_MS) {
          lastTrack = now;
          try {
            const hit = readFrame(video, canvas, inversion);
            const next = hit && hit.data === data && hit.corners ? boxFor(hit.corners) : null;
            if (next) seen.see(next, now / 1000);
          } catch {
            // Keep following the last position.
          }
        }
        const target = seen.predict(now / 1000);
        if (target) draw(spring.step(target.box, (now - last) / 1000, target.vel));
        last = now;
        lockRafRef.current = requestAnimationFrame(follow);
      };
      lockRafRef.current = requestAnimationFrame(follow);
      window.setTimeout(hapticTap, 400);
      return 620;
    };

    // `inversion`: how jsQR should look for the same code while tracking it,
    // i.e. the pass that found it (either, when BarcodeDetector did).
    const handleResult = (data: string, corners: Point[] | undefined, inversion: Inversion) => {
      doneRef.current = true;
      const finish = () => {
        resultTimerRef.current = null;
        if (cancelled) return;
        // Freeze the brackets where they are for the flight into the field.
        if (lockRafRef.current !== null) cancelAnimationFrame(lockRafRef.current);
        lockRafRef.current = null;
        // Stopping the camera inside the transition's update keeps its last
        // frame in the outgoing snapshot instead of a black square.
        const lock = lockRef.current;
        withViewTransition(
          () =>
            flushSync(() => {
              stop();
              onResult(data);
            }),
          { "scan-lock": "1" },
          {
            name: "scan-lock",
            // The brackets become a full outline that settles into the field's.
            from: () =>
              lock && !lock.hidden
                ? {
                    el: lock,
                    override: {
                      background: "rgba(0, 0, 0, 0)",
                      borderColor: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
                      borderWidth: "4px",
                      radius: "14px",
                    },
                  }
                : null,
            to: () => {
              const el = document.querySelector(".destination-row input.just-scanned");
              return el ? { el } : null;
            },
            duration: 480,
          },
        );
      };
      // Camera keeps running during the hold so the preview stays live
      // instead of freezing/blanking.
      const lockMs = lockOn(data, corners, inversion);
      const elapsed = firstFrameAtRef.current === null ? MIN_PREVIEW_MS : performance.now() - firstFrameAtRef.current;
      const remaining = Math.max(MIN_PREVIEW_MS - elapsed, lockMs);
      if (remaining > 0) resultTimerRef.current = window.setTimeout(finish, remaining);
      else finish();
    };

    // The part of the frame the preview shows (object-fit: cover crops the
    // rest), in the video's own pixels.
    const visibleRect = (video: HTMLVideoElement) => {
      const vw = video.videoWidth, vh = video.videoHeight;
      const el = viewportRef.current;
      if (!el || !el.clientWidth || !el.clientHeight) return { x: 0, y: 0, w: vw, h: vh };
      return coverVisibleRect(vw, vh, el.clientWidth, el.clientHeight);
    };

    // Decodes the current frame with jsQR on our own canvas copy, only the
    // part the preview shows: the user aims at that, and the cropped-off
    // sides would spend the MAX_SCAN_DIMENSION budget on nothing (a square
    // preview of a 4:3 frame drops a quarter of it). Corners come back in the
    // full frame's pixels, the space lockOn() maps from.
    const readFrame = (video: HTMLVideoElement, canvas: HTMLCanvasElement, inversion: Inversion) => {
      const src = visibleRect(video);
      const scale = Math.min(1, MAX_SCAN_DIMENSION / Math.max(src.w, src.h));
      const w = Math.max(1, Math.round(src.w * scale));
      const h = Math.max(1, Math.round(src.h * scale));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(video, src.x, src.y, src.w, src.h, 0, 0, w, h);
      const frame = ctx.getImageData(0, 0, w, h);
      const code = jsQR(frame.data, w, h, { inversionAttempts: inversion });
      if (!code || !code.data) return null;
      const l = code.location;
      const kx = src.w / w, ky = src.h / h;
      const corners = l
        ? [l.topLeftCorner, l.topRightCorner, l.bottomRightCorner, l.bottomLeftCorner].map((p) => ({
            x: src.x + p.x * kx,
            y: src.y + p.y * ky,
          }))
        : undefined;
      return { data: code.data, corners };
    };

    let jsqrTicks = 0;
    const scanWithJsQR = (video: HTMLVideoElement, canvas: HTMLCanvasElement) => {
      const inversion: Inversion = ++jsqrTicks % INVERTED_EVERY === 0 ? "attemptBoth" : "dontInvert";
      let hit: ReturnType<typeof readFrame> = null;
      try {
        hit = readFrame(video, canvas, inversion);
      } catch {
        // jsQR 1.4.0 can throw from inside its decoder ("Cannot read
        // properties of undefined (reading 'height')", reliably with
        // "onlyInvert", which is why that mode isn't used). Uncaught, it
        // ended scanLoop before it rescheduled itself: a live camera that
        // never read anything again.
        return;
      }
      if (hit) handleResult(hit.data, hit.corners, inversion);
    };

    // Motion design only: where the code BarcodeDetector just found sits on
    // screen. Its own cornerPoints are not used: on an Android phone they put
    // the lock frame visibly off the code (not in the displayed video's
    // space, most likely the camera's unrotated frame). If jsQR can't see the
    // code in this frame, no corners: better no snap than a snap to the wrong
    // place.
    const locateForLock = (): Point[] | undefined => {
      const video = videoRef.current, canvas = canvasRef.current;
      if (!isMotionOn() || !video || !canvas) return undefined;
      try {
        return readFrame(video, canvas, "attemptBoth")?.corners;
      } catch {
        return undefined;
      }
    };

    // Every DARK_SAMPLE_INTERVAL_MS, the mean brightness of what the
    // preview shows from a 32x32 copy, fed to the hysteresis in sceneDarkness.ts. Only while the
    // track has a torch: the hint is about the torch.
    const sampleCtx = (() => {
      const sample = document.createElement("canvas");
      sample.width = DARK_SAMPLE_SIZE;
      sample.height = DARK_SAMPLE_SIZE;
      return sample.getContext("2d", { willReadFrequently: true });
    })();
    const trackDarkness = createDarknessTracker();
    let hasTorch = false;
    let lastSampleAt = -Infinity;
    let wasDark = false;
    const sampleDarkness = (video: HTMLVideoElement, time: number) => {
      if (!sampleCtx || !hasTorch || time - lastSampleAt < DARK_SAMPLE_INTERVAL_MS) return;
      lastSampleAt = time;
      try {
        const src = visibleRect(video);
        sampleCtx.drawImage(video, src.x, src.y, src.w, src.h, 0, 0, DARK_SAMPLE_SIZE, DARK_SAMPLE_SIZE);
        const { data } = sampleCtx.getImageData(0, 0, DARK_SAMPLE_SIZE, DARK_SAMPLE_SIZE);
        const isDark = trackDarkness(meanLuma(data), time);
        if (isDark !== wasDark) {
          wasDark = isDark;
          setDark(isDark);
        }
      } catch {
        // A failed sample leaves the hint as it was.
      }
    };

    const scanLoop = (time: number) => {
      if (cancelled || doneRef.current) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState >= video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
        if (firstFrameAtRef.current === null) {
          firstFrameAtRef.current = time;
          setLive(true);
        }
        sampleDarkness(video, time);
        const detector = detectorRef.current;
        const interval = detector ? DETECTOR_INTERVAL_MS : SCAN_INTERVAL_MS;
        if (time - lastScanRef.current >= interval && !detectingRef.current) {
          lastScanRef.current = time;
          if (detector) {
            detectingRef.current = true;
            detector
              .detect(video)
              .then((codes) => {
                detectingRef.current = false;
                if (cancelled || doneRef.current) return;
                const value = codes[0]?.rawValue;
                if (value) handleResult(value, locateForLock(), "attemptBoth");
              })
              .catch(() => {
                detectingRef.current = false;
                // The constructor doesn't reliably throw just because the
                // platform can't actually decode "qr_code" (it only
                // validates the format literal) — a real failure here is
                // the actual signal. Give up on the native path for the
                // rest of this session rather than fail silently forever.
                detectorRef.current = null;
              });
          } else {
            scanWithJsQR(video, canvas);
          }
        }
      }
      if (!doneRef.current) rafRef.current = requestAnimationFrame(scanLoop);
    };

    if (!navigator.mediaDevices?.getUserMedia) {
      setError({ message: t("Tento prohlížeč neumí číst QR kódy z kamery."), retry: false });
      return;
    }

    const BarcodeDetectorCtor = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor })
      .BarcodeDetector;
    if (BarcodeDetectorCtor) {
      try {
        detectorRef.current = new BarcodeDetectorCtor({ formats: ["qr_code"] });
      } catch {
        // Constructed but the browser doesn't actually support "qr_code" as
        // a format (e.g. an older/partial Shape Detection implementation) —
        // fall back to jsQR rather than crash.
        detectorRef.current = null;
      }
    }

    navigator.mediaDevices
      .getUserMedia({ video: CAMERA_CONSTRAINTS, audio: false })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0] as TorchCapableTrack | undefined;
        if (track) {
          trackRef.current = track;
          try {
            const caps = track.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
            if (caps?.torch) {
              hasTorch = true;
              setTorchSupported(true);
            }
          } catch {
            // getCapabilities() itself can throw on some browsers instead of
            // just omitting the field — either way, no torch button.
          }
        }
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.play().catch(() => {});
        }
        rafRef.current = requestAnimationFrame(scanLoop);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const name = e instanceof Error ? e.name : "";
        const message =
          name === "NotAllowedError" || name === "SecurityError"
            ? t("Přístup ke kameře byl zamítnut. Povol ho v nastavení prohlížeče a zkus to znovu.")
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? t("Nebyla nalezena žádná kamera.")
              : t("Kameru se nepodařilo spustit.");
        setError({ message, retry: true });
      });

    return () => {
      cancelled = true;
      // A result still held by MIN_PREVIEW_MS never got delivered — let a
      // re-run of this effect scan again instead of sitting on doneRef forever.
      if (resultTimerRef.current !== null) doneRef.current = false;
      stop();
    };
    // `attempt` only re-runs this effect ("Zkusit znovu").
  }, [onResult, t, attempt]);

  const preview = (
    <div
      className="qr-scanner-viewport"
      ref={viewportRef}
      onPointerDown={onPreviewPointerDown}
    >
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video ref={videoRef} className="qr-scanner-video" playsInline muted autoPlay />
      {/* The guide frame and the dim around it are one box (Dashboard.css), so
          the dim meets the gray outline exactly, also while it pulses and,
          in motion design, while the box follows a found code. */}
      <div className={`qr-scanner-frame${pulsing && live ? " is-pulsing" : ""}`} ref={frameRef} aria-hidden="true">
        <span className="qr-scanner-frame-ring" ref={ringRef} />
      </div>
      <div className="qr-lock" ref={lockRef} hidden aria-hidden="true">
        <i className="qr-lock-c tl" />
        <i className="qr-lock-c tr" />
        <i className="qr-lock-c bl" />
        <i className="qr-lock-c br" />
        <i className="qr-lock-flash" />
      </div>
      {!live && (
        <div className="qr-scanner-starting">
          <WaitingDots />
          <span>{t("Spouštím kameru…")}</span>
        </div>
      )}
      {torchSupported && (
        <div className={`qr-torch-hint${dark && !torchOn ? " is-shown" : ""}`} aria-hidden="true">
          <TorchIcon />
          <span>{t("Dvojitým klepnutím rozsvítíš blesk")}</span>
        </div>
      )}
    </div>
  );

  // Rendered via a portal straight into <body> — SendPanel can mount this
  // while its parent .panel-transition is still mid-animation (the "jump
  // straight to the scanner" shortcut from the homepage), and that
  // ancestor's transform-based entrance animation would otherwise become
  // the containing block for this modal's `position: fixed`, making it
  // render pinned near the top of that animating panel for the ~0.2s the
  // animation runs before snapping down to its real, viewport-centered spot.
  // Sheet portals itself only while the page blur is on (beta), so the portal
  // stays here for everyone.
  return createPortal(
    <Sheet closing={closing} onBackdrop={requestClose} screenKey={error ? "error" : "camera"}>
      {error ? (
        <Screen>
          <StatusMark state="warn" />
          <h2 className="sht-title">{t("Kamera nejde spustit")}</h2>
          <p className="sht-sub">{error.message}</p>
          <div className="sht-actions">
            <button type="button" className="secondary" onClick={requestClose}>
              {t("Zavřít")}
            </button>
            {error.retry && (
              <button type="button" onClick={retry}>
                {t("Zkusit znovu")}
              </button>
            )}
          </div>
        </Screen>
      ) : (
        <Screen>
          <h2 className="sht-title">{t("Naskenovat QR kód")}</h2>
          <p className="sht-sub">{t("Namiř kameru na QR kód s adresou nebo fakturou.")}</p>
          {preview}
          {/* The double tap has no keyboard or screen-reader equivalent;
              this invisible button is one. */}
          {torchSupported && (
            <button type="button" className="qr-torch-a11y" onClick={toggleTorch}>
              {torchOn ? t("Vypnout blesk") : t("Zapnout blesk")}
            </button>
          )}
          <button type="button" className="secondary sht-wide" onClick={requestClose}>
            {t("Zavřít")}
          </button>
        </Screen>
      )}
      <canvas ref={canvasRef} className="qr-scanner-canvas" />
    </Sheet>,
    document.body,
  );
}

// An upright, vertically-symmetric handheld flashlight (body + grip button +
// flared head + beam rays) — deliberately not a bolt shape, which is already
// LightningIcon's shorthand for the Lightning Network elsewhere in the app
// and would be confusing reused here.
function TorchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M9 14 6 8h12l-3 6" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      <rect x="9" y="14" width="6" height="8" rx="1.5" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="12" cy="18" r="1.1" fill="currentColor" />
      <path d="M12 8V3M8.5 8.5 5.5 4.5M15.5 8.5 18.5 4.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
