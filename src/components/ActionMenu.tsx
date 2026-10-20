import { useEffect, useRef, useState, type ReactNode } from "react";
import { hapticTap } from "../lib/ui/haptics";
import "./ActionMenu.css";

// A button that keeps its ordinary tap and grows a small menu when held —
// the Home screen's Přijmout / Odeslat pair.
//
// Why a hold rather than more buttons: both of the things behind it (send
// as a gift link, ask for a payment by link) are variations on the button
// they hang off, and putting either one on the home screen as its own
// control would have made the primary pair compete with something used far
// less often. The gift entry point used to be a third icon squeezed into
// the Send form's address row, where it had nothing to do with the field it
// sat next to.
//
// The tap is never sacrificed to the hold: the menu opens on a timer, and
// the click that ends that press is swallowed, so a hold can't also fire
// the button's own action, and a normal tap never opens the menu.

const LONG_PRESS_MS = 420;
// A press that wanders further than this is a scroll, not a hold.
const MOVE_TOLERANCE_PX = 10;

export interface ActionMenuItem {
  key: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  onSelect: () => void;
}

export default function ActionMenuButton({
  className,
  items,
  onClick,
  children,
  /** Which edge the menu lines up with — the side its own button is on. */
  align,
  innerRef,
  /** Fires the moment the menu actually opens — e.g. to dismiss a coachmark
   * teaching this exact gesture, which has nothing left to teach once the
   * hold has already worked once, and would otherwise sit uselessly behind
   * whatever the picked item opens. */
  onOpen,
}: {
  className: string;
  items: ActionMenuItem[];
  onClick: () => void;
  children: ReactNode;
  align: "left" | "right";
  innerRef?: React.Ref<HTMLButtonElement>;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [holding, setHolding] = useState(false);
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  // Set when this press opened the menu, so the click event that follows the
  // release is ignored exactly once.
  const swallowClickRef = useRef(false);

  const cancelHold = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setHolding(false);
    startRef.current = null;
  };

  useEffect(() => cancelHold, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const openMenu = () => {
    cancelHold();
    hapticTap();
    setOpen(true);
    onOpen?.();
  };

  return (
    <div className={`amenu-host amenu-host--${align}`}>
      <button
        ref={innerRef}
        type="button"
        className={`${className} amenu-anchor${holding ? " is-holding" : ""}${open ? " is-menu-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerDown={(e) => {
          // Only a primary press arms the hold; a right-click opens the menu
          // outright via onContextMenu below.
          if (e.button !== 0) return;
          // A prior gesture's onContextMenu (a real right-click, or Android's
          // own native long-press callout firing independently of the timer
          // below) sets this to swallow that gesture's release click — but
          // that release doesn't reliably produce a click event to consume
          // it, so it can be left stuck true forever, silently no-opping the
          // very next, unrelated tap on this button. Every fresh press
          // starts its own gesture, so it also starts by clearing whatever
          // the last one left behind.
          swallowClickRef.current = false;
          startRef.current = { x: e.clientX, y: e.clientY };
          setHolding(true);
          timerRef.current = window.setTimeout(() => {
            swallowClickRef.current = true;
            openMenu();
          }, LONG_PRESS_MS);
        }}
        onPointerMove={(e) => {
          const start = startRef.current;
          if (!start) return;
          if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > MOVE_TOLERANCE_PX) cancelHold();
        }}
        onPointerUp={cancelHold}
        onPointerCancel={cancelHold}
        onPointerLeave={cancelHold}
        onContextMenu={(e) => {
          // Also suppresses the OS's own long-press callout on touch, which
          // would otherwise fight the menu for the same gesture.
          e.preventDefault();
          swallowClickRef.current = true;
          openMenu();
        }}
        onKeyDown={(e) => {
          // The keyboard equivalent of the hold, the way a split button
          // normally behaves — Enter/Space keep running the primary action.
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        onClick={() => {
          if (swallowClickRef.current) {
            swallowClickRef.current = false;
            return;
          }
          onClick();
        }}
      >
        {children}
      </button>
      {open && (
        <>
          <div className="amenu-scrim" onClick={() => setOpen(false)} />
          <div className="amenu" role="menu">
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className="amenu-item"
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                <span className="amenu-item-icon">{item.icon}</span>
                <span className="amenu-item-text">
                  <span className="amenu-item-label">{item.label}</span>
                  {item.hint && <span className="amenu-item-hint">{item.hint}</span>}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
