// The shared bottom-sheet vocabulary behind tap-to-pay (BumpOverlay), the
// gift-link composer and the payment-request composer.
//
// It grew out of BumpOverlay, which had all of this inline; the gift flow
// was a plain centered modal that looked like a different app. Rather than
// restyle the gift modal to *resemble* the tap-to-pay sheet, the primitives
// moved here and all three now render the literally same sheet, amount
// field, status mark and motion curves. Bump-specific pieces (the paired
// phones hero, the emoji reels, the Platím/Přijímám choice, the quiet
// bubble) deliberately stayed in BumpOverlay — they are that flow's, not
// the design system's.
//
// Styling lives in PaySheet.css under the `sht-` prefix.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { fiatToSats, formatFiat, satsToFiat } from "../../lib/price";
import type { FiatCurrency } from "../../lib/currency";
import { hapticTap } from "../../lib/ui/haptics";
import { useBackLayer } from "../../lib/ui/backLayers";
import "./PaySheet.css";

export const CURRENCY_SYMBOLS: Record<FiatCurrency, string> = { czk: "Kč", eur: "€", usd: "$" };

// How long the sheet's exit animation runs (must match PaySheet.css's
// sht-sheet-out) — closeThen waits this long before handing control back.
export const SHEET_EXIT_MS = 260;

// How long the sheet's entrance animation runs (must match PaySheet.css's
// sht-sheet-in). Autofocusing an amount field on the sheet's very first
// screen fires the second the input mounts — before the sheet has even
// started sliding in — so the keyboard's own open animation and the sheet's
// slide-in race each other, and the keyboard usually wins the race and
// finishes second: it visibly shoves the already-settled sheet up a beat
// after it looked done, reading as one extra stutter tacked onto the end of
// the entrance. Waiting this long to actually call .focus() lets the sheet
// finish landing first, so the keyboard's opening becomes the sheet's only
// remaining motion instead of a second one on top of it.
export const SHEET_ENTER_MS = 520;

// --- Sheet shell -------------------------------------------------------------

// Locks the background page in place while a sheet is up. Needed because
// none of these sheets are scrollable-body-relative — they're a fixed
// overlay over ordinary in-flow page content, and on mobile, focusing the
// autoFocus amount field opens the keyboard and the browser scrolls the
// *document* to keep that input visible, fixed positioning notwithstanding.
// Nothing ever undid that scroll, so closing the sheet left the home screen
// wherever the keyboard-open scroll had shoved it, sometimes off the top of
// the visible page entirely. `position: fixed` on the body (with `top` set
// to the negative of its current scroll) is the standard cross-browser way
// to freeze it in place; restoring `scrollTo` on cleanup puts the page back
// exactly where it was, every time, regardless of what the keyboard did.
// `scrollY` is read by the caller during render: by the time this effect
// runs, the page blur has already pinned #root, the document has collapsed
// and the browser has clamped window.scrollY to 0 (closing a sheet over a
// scrolled History jumped to the top).
export function useBodyScrollLock(scrollY: number): void {
  useLayoutEffect(() => {
    const { body } = document;
    const prev = { position: body.style.position, top: body.style.top, left: body.style.left, right: body.style.right, width: body.style.width };
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    return () => {
      body.style.position = prev.position;
      body.style.top = prev.top;
      body.style.left = prev.left;
      body.style.right = prev.right;
      body.style.width = prev.width;
      window.scrollTo(0, scrollY);
    };
  }, [scrollY]);
}

// Backdrop + sheet + height-easing + the keyed screen wrapper that gives
// each step its own enter animation. `screenKey` IS the animation trigger:
// change it and the current step cross-fades out to the next one.
export function Sheet({
  closing,
  onBackdrop,
  screenKey,
  children,
}: {
  closing?: boolean;
  onBackdrop?: () => void;
  screenKey: string;
  children: ReactNode;
}) {
  const keyboardInset = useKeyboardInset();
  // System back dismisses like the backdrop; no backdrop action (mid-send)
  // means back does nothing. Released once the exit animation starts.
  useBackLayer(!closing, onBackdrop);
  // Where the page was scrolled, read before either hook changes it.
  const [scrollY] = useState(() => window.scrollY);
  useBodyScrollLock(scrollY);
  const sheet = (
    <div
      className={`sht-backdrop${closing ? " is-closing" : ""}${keyboardInset > 80 ? " has-keyboard" : ""}`}
      style={{ ["--kb" as string]: `${keyboardInset}px` }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onBackdrop?.();
      }}
    >
      <div className={`sht-sheet${closing ? " is-closing" : ""}`} role="dialog" aria-modal="true">
        <AutoHeight>
          <div className="sht-screen" key={screenKey}>
            {children}
          </div>
        </AutoHeight>
      </div>
    </div>
  );
  return sheet;
}

// The vertical stack every screen's content sits in.
export function Screen({ children }: { children: ReactNode }) {
  return <div className="sht-stack">{children}</div>;
}

// Plays the sheet's exit animation before running `then`. Returned `closing`
// goes on the Sheet.
export function useSheetClose(): { closing: boolean; closeThen: (then: () => void) => void } {
  const [closing, setClosing] = useState(false);
  const closeThen = useCallback((then: () => void) => {
    setClosing(true);
    // Reset before `then` runs, not after: every current caller's `then`
    // unmounts the sheet, so this is currently a no-op, but leaving it
    // unreset would strand a future caller that reuses the same mounted
    // sheet (BumpOverlay's own hand-rolled version this replaced always did
    // this) — its next open would render permanently mid-exit.
    setTimeout(() => {
      setClosing(false);
      then();
    }, SHEET_EXIT_MS);
  }, []);
  return { closing, closeThen };
}

// Eases the sheet's height to whatever the current step needs, instead of
// the sheet snapping between sizes as steps swap. ResizeObserver-driven so
// it also follows in-step changes (a password field sliding in).
export function AutoHeight({ children }: { children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    setHeight(el.offsetHeight);
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="sht-autoheight" style={{ height }}>
      <div ref={innerRef}>{children}</div>
    </div>
  );
}

export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={`sht-collapse${open ? " is-open" : ""}`} aria-hidden={!open}>
      <div className="sht-collapse-inner">{children}</div>
    </div>
  );
}

// How much of the layout viewport the on-screen keyboard currently covers.
// Android Chrome's default (interactive-widget=resizes-visual) and iOS
// Safari both overlay the keyboard on the page instead of shrinking it, so
// a bottom-anchored sheet ends up with its action button under the keys.
// visualViewport shows what's actually visible; the sheet is lifted by the
// difference. Kept local to the sheet rather than changing the app-wide
// viewport meta, which would reflow every other screen.
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

// --- Amount entry ------------------------------------------------------------

export type AmountUnit = "sats" | "fiat";

export interface AmountEntry {
  text: string;
  unit: AmountUnit;
  sats: number;
  /** What the input should display (sats grouped, fiat as typed). */
  shown: string;
  /** The "≈ …" line under the input, or null when no rate is known. */
  secondary: string | null;
  setText: (raw: string) => void;
  switchUnit: () => void;
  reset: () => void;
  /** Goes on the AmountField so a refused amount can shake. */
  ref: RefObject<HTMLDivElement | null>;
  shake: () => void;
  canSwitch: boolean;
}

// One definition of "the big amount field's behaviour": digits-only in sats
// mode, up to two decimals in fiat mode, a unit toggle that converts what's
// already typed, and an iOS-passcode-style shake for a refused amount.
export function useAmountEntry(
  rate: number | null,
  currency: FiatCurrency,
  fmt: (n: number) => string,
  onChange?: () => void,
): AmountEntry {
  const [unit, setUnit] = useState<AmountUnit>("sats");
  const [text, setTextRaw] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const sats = (() => {
    if (unit === "sats") return text ? Number(text) : 0;
    const n = Number(text.replace(",", "."));
    return rate && n > 0 ? fiatToSats(n, rate) : 0;
  })();

  const setText = (raw: string) => {
    onChange?.();
    if (unit === "sats") {
      setTextRaw(raw.replace(/\D/g, "").replace(/^0+/, "").slice(0, 15));
      return;
    }
    const cleaned = raw.replace(/[^\d.,]/g, "").replace(".", ",");
    const [whole, ...rest] = cleaned.split(",");
    const decimals = rest.join("").slice(0, 2);
    setTextRaw(
      rest.length ? `${whole.replace(/^0+(?=\d)/, "")},${decimals}` : whole.replace(/^0+(?=\d)/, "").slice(0, 12),
    );
  };

  const switchUnit = () => {
    if (!rate) return;
    hapticTap();
    if (unit === "sats") {
      setUnit("fiat");
      setTextRaw(sats > 0 ? formatFiatPlain(satsToFiat(sats, rate), currency) : "");
    } else {
      setUnit("sats");
      setTextRaw(sats > 0 ? String(sats) : "");
    }
  };

  const reset = useCallback(() => {
    setUnit("sats");
    setTextRaw("");
  }, []);

  // Web Animations rather than a remount, which would drop the keyboard.
  const shake = () => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    ref.current?.animate(
      [
        { transform: "translateX(0)" },
        { transform: "translateX(-10px)" },
        { transform: "translateX(8px)" },
        { transform: "translateX(-5px)" },
        { transform: "translateX(3px)" },
        { transform: "translateX(0)" },
      ],
      { duration: 420, easing: "ease-out" },
    );
  };

  const shown = unit === "sats" ? (text ? fmt(Number(text)) : "") : text;
  const secondary =
    rate && sats > 0
      ? unit === "sats"
        ? `≈ ${formatFiat(satsToFiat(sats, rate), currency)}`
        : `≈ ${fmt(sats)} sats`
      : null;

  return { text, unit, sats, shown, secondary, setText, switchUnit, reset, ref, shake, canSwitch: !!rate };
}

export function AmountField({
  entry,
  currency,
  over,
  autoFocus,
  deferFocus,
  label,
}: {
  entry: AmountEntry;
  currency: FiatCurrency;
  /** Renders the amount in the danger color (over balance, over a cap). */
  over?: boolean;
  autoFocus?: boolean;
  /** Wait until the sheet's own entrance animation has landed before
   * actually focusing (see SHEET_ENTER_MS) — only correct when this field is
   * the sheet's first screen; a later step has nothing left to race. */
  deferFocus?: boolean;
  label: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoFocus || !deferFocus) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), SHEET_ENTER_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className={`sht-amount${over ? " is-over" : ""}`} ref={entry.ref}>
      <div className="sht-amount-row">
        <input
          ref={inputRef}
          className="sht-amount-input"
          style={{ fontSize: amountFontSize(entry.shown.length) }}
          type="text"
          inputMode={entry.unit === "sats" ? "numeric" : "decimal"}
          autoComplete="off"
          aria-label={label}
          placeholder="0"
          value={entry.shown}
          onChange={(e) => entry.setText(e.target.value)}
          autoFocus={autoFocus && !deferFocus}
        />
      </div>
      <button type="button" className="sht-unit" onClick={entry.switchUnit} disabled={!entry.canSwitch}>
        {entry.unit === "sats" ? "sats" : CURRENCY_SYMBOLS[currency]}
        {entry.canSwitch && <SwapGlyph />}
      </button>
      <p className="sht-secondary">{entry.secondary ?? " "}</p>
    </div>
  );
}

export function formatFiatPlain(amount: number, currency: FiatCurrency): string {
  const digits = currency === "czk" ? 0 : 2;
  return amount.toFixed(digits).replace(".", ",");
}

function amountFontSize(length: number): string {
  if (length <= 6) return "56px";
  if (length <= 9) return "44px";
  return "34px";
}

// --- Display blocks ----------------------------------------------------------

export function Pill({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="sht-pill">
      <span>{label}</span>
      {children}
    </div>
  );
}

// progress: spinning arc. success: the arc closes into a ring and a
// checkmark draws itself. incoming: a softly pulsing ring. warn / neutral:
// a static glyph that pops in. refresh: two arrows turning in a circle, no
// ring (VTXO refresh info card).
export function StatusMark({
  state,
}: {
  state: "progress" | "sent" | "success" | "incoming" | "warn" | "neutral" | "refresh";
}) {
  if (state === "refresh") {
    return (
      <div className="sht-mark sht-mark--refresh" aria-hidden="true">
        <svg viewBox="0 0 64 64">
          <g className="sht-mark-arrows">
            <path d="M52.67 39.52A22 22 0 0 1 12.95 43" />
            <path d="M11.4 51.6L12.95 43 20.7 45.5" />
            <path d="M11.33 24.48A22 22 0 0 1 51.05 21" />
            <path d="M52.6 12.4L51.05 21 43.3 18.5" />
          </g>
        </svg>
      </div>
    );
  }
  return (
    <div className={`sht-mark sht-mark--${state}`} aria-hidden="true">
      <svg viewBox="0 0 64 64">
        <circle className="sht-mark-track" cx="32" cy="32" r="28" />
        <circle className="sht-mark-ring" cx="32" cy="32" r="28" />
        {(state === "success" || state === "sent") && <path className="sht-mark-check" d="M20 33.5l8 8 16-17" />}
        {state === "warn" && (
          <>
            <path className="sht-mark-glyph" d="M32 19v17" />
            <path className="sht-mark-glyph" d="M32 44.5v.5" />
          </>
        )}
        {state === "neutral" && <path className="sht-mark-glyph" d="M22 32h20" />}
        {state === "incoming" && <path className="sht-mark-glyph sht-mark-arrow" d="M32 20v22M23 34l9 9 9-9" />}
      </svg>
    </div>
  );
}

export function BigAmount({
  sats,
  rate,
  currency,
  fmt,
  countUp = false,
}: {
  sats: number;
  rate: number | null;
  currency: FiatCurrency;
  fmt: (n: number) => string;
  countUp?: boolean;
}) {
  const shown = useCountUp(sats, countUp);
  return (
    <div className="sht-bigamount">
      <div className="sht-bigamount-sats">
        {fmt(shown)} <span className="sht-bigamount-unit">sats</span>
      </div>
      {rate && sats > 0 && <div className="sht-bigamount-fiat">≈ {formatFiat(satsToFiat(sats, rate), currency)}</div>}
    </div>
  );
}

// Eases a number from 0 up to `target` (ease-out cubic, ~0.8s). Off under
// prefers-reduced-motion, or when not asked for.
export function useCountUp(target: number, enabled: boolean): number {
  const [value, setValue] = useState(enabled ? 0 : target);
  useEffect(() => {
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!enabled || reduced) {
      setValue(target);
      return;
    }
    const start = performance.now();
    const duration = 800;
    let frame = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      setValue(Math.round(target * (1 - (1 - p) ** 3)));
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, enabled]);
  return value;
}

export function WaitingDots() {
  return (
    <span className="sht-dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export function SwapGlyph() {
  return (
    <svg className="sht-unit-glyph" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 3v10M2.5 10.5L5 13l2.5-2.5M11 13V3M8.5 5.5L11 3l2.5 2.5" />
    </svg>
  );
}
