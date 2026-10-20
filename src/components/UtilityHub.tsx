import {
  lazy,
  Suspense,
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { LightningInvoice } from "@secondts/bark";
import { useT } from "../lib/i18n";
import type { WalletClient } from "../lib/wallet/bark";
import type { PendingReceive } from "./Dashboard";
import type { FiatCurrency } from "../lib/currency";
// lazy, not a static import — Leaflet (+its CSS) is ~40KB gzip that every
// other UtilityHub tab (Převodník, POS) would otherwise pay for even though
// they never touch it. Only fetched once the user actually opens "Mapa".
const BtcMapPanel = lazy(() => import("./BtcMapPanel"));
import ConverterPanel from "./ConverterPanel";
import PosPanel from "./PosPanel";
import { usePosWideLayout } from "../lib/pos/posLayout";
import "./UtilityHub.css";

// Entered from the home screen via a right swipe on the lock-gesture-area
// (Dashboard.tsx) — v2 only, since that's where this feature lives. Modeled
// on Settings.tsx's own shell (same "fully separate page, not a subview of
// home" pattern: an early-return replacing the whole render tree, own
// header + back button, no wallet balance in sight) rather than the
// receive/send/history "subview" pattern, which keeps the balance card
// visible above a back button — the user's own framing was "this should be
// a totally separate page, like Settings, not part of the home screen".
//
// Three sections, switched via a pill-shaped segmented control: Převodník
// (sats <-> fiat, ConverterPanel.tsx), btcmap.org ("Mapa", see
// BtcMapPanel.tsx), and Point of Sale (PosPanel.tsx). The Bitrefill tab
// (vouchers + phone top-ups) that used to come first is archived in
// archive/bitrefill/.
type UtilityTab = "converter" | "btcmap" | "pos";

export default function UtilityHub({
  onClose,
  wallet,
  rates,
  currency,
  pendingReceive,
  onInvoiceCreated,
  onCancelLightningWatch,
}: {
  onClose: () => void;
  wallet: WalletClient;
  // Threaded straight from Dashboard.tsx: rates/currency for the converter
  // and PosPanel, the rest for PosPanel only — see its own comment on why it
  // reuses Dashboard's existing pendingReceive watch instead of a second
  // poll loop.
  rates: Record<FiatCurrency, number> | null;
  currency: FiatCurrency;
  pendingReceive: PendingReceive | null;
  onInvoiceCreated: (invoice: LightningInvoice) => void;
  onCancelLightningWatch: () => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<UtilityTab>("converter");
  // Lifted out of PosPanel so the "Položky" entry point can live in the
  // shared header (next to "Zpět do peněženky") instead of floating inside
  // the POS tab's own content — it only makes sense while that tab is
  // active, and disappears once the management screen itself is open (that
  // screen has its own "Hotovo" close button).
  const [posManaging, setPosManaging] = useState(false);
  // PosPanel's customer-facing checkout (QR / paid) is shown without the
  // wallet's own chrome: the customer is looking at this screen, and "Zpět do
  // peněženky" or the tabs have no business being in front of them.
  const [posCheckout, setPosCheckout] = useState(false);
  const chromeHidden = tab === "pos" && posCheckout;
  // Only Pokladna widens the page on a large screen; the other tabs keep
  // the phone column.
  const posWide = usePosWideLayout();

  // Mirrors Dashboard.tsx's own entry gesture (right swipe on
  // lock-gesture-area opens this) with a right-to-left swipe to close —
  // same direction the panel itself slides away in (Dashboard.css's
  // .utility-hub-overlay isn't --visible => translateX(-100%)), so the
  // motion matches what's on screen. Převodník only, over its whole area
  // except the amount field (a mouse drag there selects text) — NOT the Mapa
  // tab, which has its own horizontal drag (Leaflet panning, the
  // nearby-businesses card row) that a swipe-anywhere gesture would
  // constantly fight with, and not POS either (its keypad is a dense grid
  // of tap targets a stray horizontal drag could clip). The tab check
  // happens inside handlePagePointerUp itself (reading current `tab`), not
  // by conditionally attaching the listeners, so switching tabs mid-render
  // never needs to re-wire anything.
  //
  // touch-action: pan-y (CSS, only while tab === "converter") is what makes
  // this safe over scrollable content: it tells the browser to keep
  // handling vertical scroll natively (so the page still scrolls normally
  // under an open keyboard) while leaving horizontal touch movement alone
  // for these JS handlers to see as real pointerdown/pointerup instead of a
  // native pan that fires pointercancel — same root cause Dashboard.css's
  // .lock-gesture-area documents for its own gesture, just resolved with
  // pan-y here instead of a blanket "none" since (unlike that empty
  // aria-hidden div) this area needs to stay scrollable.
  //
  // No setPointerCapture — this area has real buttons (the swap button, the
  // tappable result), and capturing pointer events can retarget their click
  // away from the element itself; plain bubbling pointerdown/up is enough
  // since the drag stays within this container.
  const pageSwipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const handlePagePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const inField = e.target instanceof Element && e.target.closest("input") !== null;
    pageSwipeStartRef.current = inField ? null : { x: e.clientX, y: e.clientY };
  }, []);
  const handlePagePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const start = pageSwipeStartRef.current;
      pageSwipeStartRef.current = null;
      if (!start || tab !== "converter") return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (dx < -40 && Math.abs(dx) > Math.abs(dy) * 1.5) onClose();
    },
    [tab, onClose],
  );
  const handlePagePointerCancel = useCallback(() => {
    pageSwipeStartRef.current = null;
  }, []);

  const tabs = (
    // Same shared .mode-toggle class as the Receive panel's Ark/Lightning/
    // On-chain switch and Settings' Theme/Language/Currency toggles
    // (Dashboard.css + design-v2.css's sliding-thumb rules) — so this
    // gets the identical look and the animated pill "for free" instead
    // of a bespoke pill component with its own drifting style.
    <div className="mode-toggle" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={tab === "converter"}
        className={tab === "converter" ? "active" : ""}
        onClick={() => setTab("converter")}
      >
        {t("Převodník")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === "btcmap"}
        className={tab === "btcmap" ? "active" : ""}
        onClick={() => setTab("btcmap")}
      >
        {t("Mapa")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === "pos"}
        className={tab === "pos" ? "active" : ""}
        onClick={() => setTab("pos")}
      >
        {t("Pokladna")}
      </button>
    </div>
  );
  // A wide Pokladna puts the tabs into the header row between its two
  // buttons: three stacked rows of navigation cost the till a fifth of the
  // screen.
  const tabsInHeader = tab === "pos" && posWide;

  return (
    <div
      className={`utility-hub-page${tab === "converter" ? " utility-hub-page--swipeable" : ""}${tab === "pos" ? " utility-hub-page--pos" : ""}${tab === "pos" && posWide ? " utility-hub-page--pos-wide" : ""}`}
      onPointerDown={handlePagePointerDown}
      onPointerUp={handlePagePointerUp}
      onPointerCancel={handlePagePointerCancel}
    >
      {!chromeHidden && (
        <>
          <header className={`utility-hub-header${tabsInHeader ? " utility-hub-header--tabs" : ""}`}>
            <button className="secondary small" onClick={onClose}>
              {t("Zpět do peněženky")}
            </button>
            {tabsInHeader && tabs}
            {tab === "pos" && !posManaging ? (
              <button
                type="button"
                className="secondary small pos-edit-btn"
                onClick={() => setPosManaging(true)}
                aria-label={t("Upravit ceník")}
                title={t("Upravit ceník")}
              >
                <PencilIcon />
              </button>
            ) : (
              // Keeps the tabs centred while the editor hides the pencil.
              tabsInHeader && <span />
            )}
          </header>
          {!tabsInHeader && tabs}
        </>
      )}

      {tab === "converter" && <ConverterPanel rates={rates} currency={currency} />}
      {tab === "btcmap" && (
        <Suspense fallback={null}>
          <BtcMapPanel />
        </Suspense>
      )}
      {tab === "pos" && (
        <PosPanel
          wallet={wallet}
          rates={rates}
          currency={currency}
          pendingReceive={pendingReceive}
          onInvoiceCreated={onInvoiceCreated}
          onCancelLightningWatch={onCancelLightningWatch}
          managing={posManaging}
          onManagingChange={setPosManaging}
          onCheckoutChange={setPosCheckout}
          wide={posWide}
        />
      )}
    </div>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M13.5 8.5l3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
