import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { isMotionOn } from "../lib/ui/motion";
import type { LightningInvoice } from "@secondts/bark";
import { useT, tf, useLang, localeFor } from "../lib/i18n";
import type { WalletClient } from "../lib/wallet/bark";
import type { PendingReceive } from "./Dashboard";
import type { FiatCurrency } from "../lib/currency";
import { formatFiat } from "../lib/price";
import { loadPosItems, addPosItem, updatePosItem, removePosItem, type PosItem } from "../lib/pos/posItems";
import {
  EMPTY_DRAFT,
  applyKey,
  entryValue,
  formatEntry,
  fractionDigits,
  MAX_QTY,
  MAX_SALE_TOTAL,
  parsePrice,
  receiptLines,
  saleDescription,
  saleTotal,
  totalSats,
  type PosDraft,
} from "../lib/pos/posSale";
import { dismissErrorToast, reportError } from "../lib/appErrors";
import { swapStage } from "../lib/pos/posSwap";
import { TIP_PERCENTS, addTip, describeWithTip, loadTipsEnabled, saveTipsEnabled, tipAmount, tipFits } from "../lib/pos/posTip";
import { BooleanSwitch } from "./BooleanSwitch";
import { setTillSale } from "../lib/pos/tillSale";
import { withTimeout } from "../lib/wallet/walletCall";
import { WaitingDots } from "./sheet/PaySheet";
import "./PosPanel.css";

// Merchant-facing "ring it up, show a QR" terminal. The invoice is created
// with the exact same wallet.bolt11Invoice() call ReceivePanel's Lightning
// tab uses (Dashboard.tsx), and paid-detection is NOT reimplemented here:
// the invoice goes to Dashboard's own startLightningWatch (onInvoiceCreated)
// and this renders whatever pendingReceive says. That watch knows that
// isInvoicePaid() alone doesn't reflect a real payment, and it keeps running
// after the merchant leaves this tab, so a late payment still surfaces as a
// toast + balance bump.
//
// Layout: the whole register fits one screen without scrolling. Total on
// top (always the full amount the invoice will be for), then ONE of price
// list / keypad / receipt, picked by a Částka / Ceník switch and the
// receipt row, and the charge button pinned at the bottom. They used to be
// stacked under each other, which pushed the pay button below the fold
// with as few as 5 items.
//
// Wide (landscape tablet, desktop; usePosWideLayout): two columns instead.
// Price list or keypad on the left, the receipt always open on the right
// with the total and the charge button under it, like a shop's till. The
// customer's checkout puts the QR beside the amount rather than under it.

// Module scope, not component state: PosPanel unmounts whenever the merchant
// switches to Převodník or closes the hub, and a half-built receipt
// shouldn't vanish with it. The same goes for the sale behind a live
// invoice: pendingReceive (Dashboard) survives the unmount, but the fiat
// amount and items it was for did not, so the checkout screen used to show
// "0 Kč" over a real invoice. Memory only: gone on reload/lock, same as the
// watch itself.
let savedDraft: PosDraft = EMPTY_DRAFT;

interface ActiveSale {
  paymentHash: string;
  total: number;
  currency: FiatCurrency;
  sats: number;
  // Price list items only (saleDescription); the tip is shown on its own.
  summary: string;
  // Already in `total`. 0 without a tip.
  tip: number;
}
let savedSale: ActiveSale | null = null;

// Same budget as the Receive screen's invoice.
const INVOICE_TIMEOUT_MS = 20_000;

// Length of pos-line-out in PosPanel.css.
const LINE_LEAVE_MS = 260;

const CURRENCY_SYMBOLS: Record<FiatCurrency, string> = { czk: "Kč", eur: "€", usd: "$" };

type View = "catalog" | "keypad" | "receipt";

// Checks shared by "Účtovat" and the tip step, with the error the merchant sees.
function chargeError(
  amount: number | null,
  currency: FiatCurrency,
  rates: Record<FiatCurrency, number> | null,
  t: (key: string) => string,
): string | null {
  if (!rates || amount === null) return t("Kurz měny není momentálně dostupný.");
  if (amount > MAX_SALE_TOTAL) return t("Částka je příliš velká.");
  const amountSats = totalSats(amount, currency, rates);
  if (!Number.isInteger(amountSats) || amountSats <= 0) return t("Zadej platnou částku.");
  return null;
}

export default function PosPanel({
  wallet,
  rates,
  currency,
  pendingReceive,
  onInvoiceCreated,
  onCancelLightningWatch,
  onInvoiceCopied,
  managing,
  onManagingChange,
  onCheckoutChange,
  wide,
}: {
  wallet: WalletClient;
  rates: Record<FiatCurrency, number> | null;
  currency: FiatCurrency;
  pendingReceive: PendingReceive | null;
  onInvoiceCreated: (invoice: LightningInvoice) => void;
  onCancelLightningWatch: () => void;
  // Shown by the app's island toast, not by this screen.
  onInvoiceCopied: () => void;
  // Lifted to UtilityHub so its own header can host the "Upravit ceník" button.
  managing: boolean;
  onManagingChange: (managing: boolean) => void;
  // True while the customer-facing checkout is up, so UtilityHub can drop
  // its wallet chrome (back button, tabs, "Upravit ceník") from that screen.
  onCheckoutChange: (active: boolean) => void;
  // UtilityHub owns usePosWideLayout, since its page width changes with it.
  wide: boolean;
}) {
  const t = useT();
  const lang = useLang();

  const [items, setItems] = useState<PosItem[]>(() => loadPosItems(currency));
  const [draft, setDraft] = useState<PosDraft>(savedDraft);
  const [sale, setSale] = useState<ActiveSale | null>(savedSale);
  const [view, setView] = useState<View>(() => (items.length > 0 ? "catalog" : "keypad"));
  const [busy, setBusy] = useState(false);
  const [tipsOn, setTipsOn] = useState(loadTipsEnabled);
  // The customer is picking a tip: the invoice does not exist yet.
  const [tipping, setTipping] = useState(false);
  // Which tip choice is creating the invoice, for its busy look.
  const [tipBusy, setTipBusy] = useState<string | null>(null);

  useEffect(() => {
    savedDraft = draft;
  }, [draft]);
  useEffect(() => {
    savedSale = sale;
  }, [sale]);
  // The first moments after the tab opens: the whole panel rises in, so the
  // receipt lines and badges must not play their own "just added" entrance
  // on top of it (PosPanel.css, .pos--fresh).
  const [fresh, setFresh] = useState(true);
  useEffect(() => {
    const id = window.setTimeout(() => setFresh(false), 300);
    return () => window.clearTimeout(id);
  }, []);
  // Read by the delayed line removal, which would otherwise act on the
  // render it was scheduled in.
  const lockedRef = useRef(false);
  useEffect(() => {
    lockedRef.current = busy || sale !== null;
  }, [busy, sale]);

  // Only the invoice this till created counts as a checkout. A Lightning
  // invoice made in Přijmout lives in the same pendingReceive slot, and the
  // till used to render it as its own sale.
  const pending =
    pendingReceive?.kind === "lightning" && sale && pendingReceive.invoice.paymentHash === sale.paymentHash
      ? pendingReceive
      : null;
  const inCheckout = pending !== null;
  // Tells Dashboard which invoice this till is showing, so its paid screen is
  // not followed by the island toast for the same payment.
  const saleHash = sale?.paymentHash ?? null;
  useEffect(() => {
    setTillSale(saleHash);
    return () => setTillSale(null);
  }, [saleHash]);
  // Layout effects: the hub's header must change in the same commit as the
  // stage swap, or the transition captures it half way.
  // The tip step is customer-facing too.
  const customerFacing = inCheckout || tipping;
  useLayoutEffect(() => {
    onCheckoutChange(customerFacing);
  }, [customerFacing, onCheckoutChange]);
  useLayoutEffect(() => () => onCheckoutChange(false), [onCheckoutChange]);

  const customLabel = t("Částka");
  const lines = useMemo(() => receiptLines(draft, items, currency, rates, customLabel), [draft, items, currency, rates, customLabel]);
  const total = saleTotal(lines, draft.entry);
  const sats = totalSats(total, currency, rates);
  const lineCount = lines.reduce((sum, line) => sum + line.qty, 0);
  const rateMissing = !rates || total === null;

  const update = useCallback(
    (fn: (prev: PosDraft) => PosDraft) => {
      if (busy) return;
      dismissErrorToast();
      setDraft(fn);
    },
    [busy],
  );

  const addItem = (id: string) =>
    update((d) => ((d.cart[id] ?? 0) >= MAX_QTY ? d : { ...d, cart: { ...d.cart, [id]: (d.cart[id] ?? 0) + 1 } }));

  const changeQty = (itemId: string, delta: number) =>
    update((d) => {
      const qty = Math.min(MAX_QTY, (d.cart[itemId] ?? 0) + delta);
      const cart = { ...d.cart };
      if (qty > 0) cart[itemId] = qty;
      else delete cart[itemId];
      return { ...d, cart };
    });

  // A removed line fades out and folds away first (PosPanel.css, same length), then the draft changes.
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const leave = (key: string, apply: () => void) => {
    if (busy || sale) return;
    if (!isMotionOn() || leaving.has(key)) {
      apply();
      return;
    }
    // The fold starts from the row's real height, not a guessed ceiling: from
    // a ceiling the first part of it moves nothing and the rest snaps.
    const row = document.querySelector<HTMLElement>(`.pos-line[data-line-key="${CSS.escape(key)}"]`);
    row?.style.setProperty("--pos-line-h", `${row.getBoundingClientRect().height}px`);
    setLeaving((s) => new Set(s).add(key));
    window.setTimeout(() => {
      // An invoice started in the meantime owns the receipt: the line stays.
      if (!lockedRef.current) apply();
      setLeaving((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }, LINE_LEAVE_MS);
  };

  const removeCustom = (id: string) => update((d) => ({ ...d, custom: d.custom.filter((c) => c.id !== id) }));

  const pressKey = (key: string) => update((d) => ({ ...d, entry: applyKey(d.entry, key, currency) }));

  // Moves the keypad amount onto the receipt as its own line and starts a
  // fresh entry, for ringing up several ad-hoc amounts in one sale.
  const commitEntry = useCallback((d: PosDraft): PosDraft => {
    const amount = entryValue(d.entry);
    if (amount <= 0) return { ...d, entry: "" };
    return { ...d, entry: "", custom: [...d.custom, { id: crypto.randomUUID(), amount, currency }] };
  }, [currency]);

  // Two taps, like cancelling a payment: one stray tap must not throw away a
  // receipt being rung up. Any change to the receipt disarms it, and so do a
  // few seconds without the second tap.
  // Armed for the draft it was tapped on: any later draft is a new object.
  const [clearArmedFor, setClearArmedFor] = useState<PosDraft | null>(null);
  const confirmClear = clearArmedFor === draft;
  const clearTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
    },
    [],
  );
  const clearAll = () => {
    if (clearTimer.current !== null) window.clearTimeout(clearTimer.current);
    if (!confirmClear) {
      setClearArmedFor(draft);
      clearTimer.current = window.setTimeout(() => setClearArmedFor(null), 4000);
      return;
    }
    update(() => EMPTY_DRAFT);
    setView(items.length > 0 ? "catalog" : "keypad");
  };
  const clearButton = (
    <button
      type="button"
      className={`secondary small pos-clear${confirmClear ? " pos-clear--confirm" : ""}`}
      onClick={clearAll}
    >
      {confirmClear ? t("Opravdu vymazat?") : t("Vymazat účtenku")}
    </button>
  );

  // Creates the invoice for the sale plus `tip` and opens the checkout.
  const createInvoice = useCallback(
    async (tip: number, tipNote: string, busyKey: string | null) => {
      const grand = total === null ? null : addTip(total, tip, currency);
      const error = chargeError(grand, currency, rates, t);
      if (error || grand === null || total === null) {
        reportError(error ?? t("Zadej platnou částku."));
        return;
      }
      const grandSats = totalSats(grand, currency, rates);
      const committed = commitEntry(draft);
      const summary = saleDescription(receiptLines(committed, items, currency, rates, customLabel));
      const description = describeWithTip(summary, tipNote);
      setBusy(true);
      setTipBusy(busyKey);
      dismissErrorToast();
      try {
        // A timeout is not a failure (the invoice may still exist), but an unused
        // invoice is harmless, so it just ends the wait with a retryable error.
        const inv = await withTimeout(
          wallet.bolt11Invoice(description ? { amountSats: grandSats, description } : { amountSats: grandSats }),
          INVOICE_TIMEOUT_MS,
          t("Vytvoření Lightning faktury trvalo příliš dlouho."),
        );
        // The lock stays until the sale is set: the swap may run a frame later
        // (View Transition), and a second tap or Enter in that gap would create
        // a second invoice and orphan the first.
        swapStage(() => {
          try {
            setDraft(committed);
            setTipping(false);
            setSale({ paymentHash: inv.paymentHash, total: grand, currency, sats: inv.amountSats, summary, tip });
            onInvoiceCreated(inv);
          } finally {
            setBusy(false);
            setTipBusy(null);
          }
        }, "checkout");
      } catch (e) {
        setBusy(false);
        setTipBusy(null);
        reportError(e);
      }
    },
    [rates, total, commitEntry, draft, items, currency, customLabel, wallet, onInvoiceCreated, t],
  );

  const charge = useCallback(async () => {
    const error = chargeError(total, currency, rates, t);
    if (error) {
      reportError(error);
      return;
    }
    if (!tipsOn) {
      await createInvoice(0, "", null);
      return;
    }
    // The typed amount goes on the receipt now, so "Zpět" from the tip step
    // finds it there, as after a cancelled checkout.
    dismissErrorToast();
    swapStage(() => {
      setDraft(commitEntry(draft));
      setTipping(true);
    }, "checkout");
  }, [total, tipsOn, createInvoice, commitEntry, draft, rates, currency, t]);

  const leaveTip = () => {
    if (busy) return;
    swapStage(() => setTipping(false), "checkout");
  };

  // Paid: the sale is done, start the next one from an empty receipt.
  const nextCustomer = useCallback(() => {
    swapStage(() => {
      onCancelLightningWatch();
      setSale(null);
      setDraft(EMPTY_DRAFT);
      setView(items.length > 0 ? "catalog" : "keypad");
    }, "checkout");
  }, [onCancelLightningWatch, items.length]);

  // Not paid yet: cancel the invoice but keep the receipt, since the usual
  // reason is fixing it (wrong item, customer adds something).
  const cancelCheckout = useCallback(() => {
    swapStage(() => {
      onCancelLightningWatch();
      setSale(null);
    }, "checkout");
  }, [onCancelLightningWatch]);

  const saveItem = (id: string | null, name: string, price: number) => {
    setItems((prev) => (id ? updatePosItem(prev, id, name, price, currency) : addPosItem(prev, name, price, currency)));
  };

  const deleteItem = (id: string) => {
    setItems((prev) => removePosItem(prev, id));
    setDraft((d) => {
      if (!(id in d.cart)) return d;
      const cart = { ...d.cart };
      delete cart[id];
      return { ...d, cart };
    });
  };

  // A hardware keyboard (desktop, a tablet's keyboard case) runs the till
  // without the mouse: digits and a comma type an amount, Backspace deletes,
  // Escape clears it, + puts it on the receipt, Enter charges, and Enter on
  // the paid screen starts the next customer. Not while a field has focus
  // (the price list editor) and not with a modifier held, so browser
  // shortcuts keep working. Enter's preventDefault also stops a price tile
  // that kept focus after a click from being rung up again.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    onKeyRef.current = (e) => {
      if (managing || tipping || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (pending) {
        if (e.key === "Enter" && pending.status === "paid") {
          e.preventDefault();
          nextCustomer();
        }
        return;
      }
      const decimal = (e.key === "," || e.key === ".") && fractionDigits(currency) > 0;
      if (/^[0-9]$/.test(e.key) || decimal) {
        e.preventDefault();
        pressKey(decimal ? "." : e.key);
        if (view !== "keypad") setView("keypad");
      } else if (e.key === "Backspace" && draft.entry) {
        e.preventDefault();
        pressKey("back");
      } else if (e.key === "Escape" && draft.entry) {
        update((d) => ({ ...d, entry: "" }));
      } else if (e.key === "+") {
        e.preventDefault();
        update(commitEntry);
      } else if (e.key === "Enter") {
        // Enter on any other focused control (back, tabs, pencil, chips, the
        // charge button itself) keeps its own action; only a tile or key that
        // kept focus after a tap is taken over, so it is not rung up twice.
        if (target?.closest("button, a, [role=tab]") && !target.closest(".pos-tile, .pos-key")) return;
        e.preventDefault();
        if (!busy && sats > 0) void charge();
      }
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Icons only while every label fits whole (.pos-chips--compact). Set on
  // the element directly, before paint, and checked again when the till
  // changes width, the receipt count grows a digit, or the till comes back
  // from the checkout, tip step or editor (a new row).
  const chipsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = chipsRef.current;
    if (!row) return;
    const fit = () => {
      row.classList.remove("pos-chips--compact");
      const cut = [...row.querySelectorAll<HTMLElement>(".pos-chip-label")].some((label) => {
        const range = document.createRange();
        range.selectNodeContents(label);
        return range.getBoundingClientRect().width > label.getBoundingClientRect().width + 0.5;
      });
      row.classList.toggle("pos-chips--compact", cut);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(row.parentElement ?? row);
    return () => observer.disconnect();
  }, [lineCount, lang, wide, inCheckout, tipping, managing]);

  if (pending && sale) {
    return (
      <Checkout
        wide={wide}
        sale={sale}
        invoice={pending.invoice.invoice}
        paid={pending.status === "paid"}
        onCancel={cancelCheckout}
        onNext={nextCustomer}
        onCopied={onInvoiceCopied}
      />
    );
  }

  if (tipping && total !== null) {
    return (
      <TipStep
        wide={wide}
        total={total}
        currency={currency}
        busyKey={busy ? tipBusy : null}
        onPick={(tip, note, key) => void createInvoice(tip, note, key)}
        onBack={leaveTip}
      />
    );
  }

  if (managing) {
    return (
      <ManageItems
        wide={wide}
        items={items}
        currency={currency}
        onSave={saveItem}
        onDelete={deleteItem}
        tipsOn={tipsOn}
        onTipsChange={(on) => {
          setTipsOn(on);
          saveTipsEnabled(on);
        }}
        onDone={() =>
          swapStage(() => {
            onManagingChange(false);
            if (items.length > 0 && view === "keypad" && lines.length === 0 && !draft.entry) setView("catalog");
          }, "manage")
        }
      />
    );
  }

  // The wide layout has no receipt chip: its receipt is always open beside.
  const shownView: View = wide && view === "receipt" ? "catalog" : view;
  const entryAmount = entryValue(draft.entry);

  // One row of view chips: Ceník, Částka and (phone only) Účtenka. Every
  // chip keeps its label and its slot, so a chip never moves under the
  // finger. An empty receipt still opens (a dead chip reads as broken). The
  // wide layout keeps the receipt open beside the till, so it gets just the
  // first two.
  const chip = (target: View, label: string, icon: ReactNode, count?: number) => (
    <button
      type="button"
      aria-pressed={shownView === target}
      aria-label={count ? `${label} (${count})` : label}
      className={`pos-chip${shownView === target ? " pos-chip--on" : ""}`}
      onClick={() => setView(target)}
    >
      {icon}
      <span className="pos-chip-label" aria-hidden="true">{label}</span>
      {count ? <span className="pos-chip-count">{count}</span> : null}
    </button>
  );
  const chips = (
    <div ref={chipsRef} className="pos-chips" role="group" aria-label={t("Pohled")}>
      {chip("catalog", t("Ceník"), <GridIcon />)}
      {chip("keypad", t("Částka"), <KeypadIcon />)}
      {!wide && chip("receipt", t("Účtenka"), <ListIcon />, lineCount)}
    </div>
  );

  const catalog =
    items.length === 0 ? (
      <div className="pos-empty">
        <p>{t("Ceník je prázdný")}</p>
        <button type="button" className="secondary small" onClick={() => swapStage(() => onManagingChange(true), "manage")}>
          {t("Přidat položky")}
        </button>
      </div>
    ) : (
      <div className="pos-grid">
        {items.map((item) => {
          const qty = draft.cart[item.id] ?? 0;
          return (
            <button
              type="button"
              key={item.id}
              className={`pos-tile${qty > 0 ? " pos-tile--active" : ""}`}
              onClick={() => addItem(item.id)}
            >
              <span className="pos-tile-name">{item.name}</span>
              <span className="pos-tile-price">{formatFiat(item.price, item.currency)}</span>
              {qty > 0 && (
                <span className="pos-tile-qty" aria-label={tf(t("{count} ks na účtence"), { count: qty })}>
                  ×{qty}
                </span>
              )}
            </button>
          );
        })}
      </div>
    );

  const keypad = (
    <>
      <div className="pos-hero">
        <span className="pos-hero-amount">
          {formatEntry(draft.entry)} <span className="pos-hero-currency">{CURRENCY_SYMBOLS[currency]}</span>
        </span>
        <span className="pos-hero-sub">
          {lines.length > 0 && total !== null
            ? tf(t("Celkem {amount}"), { amount: formatFiat(total, currency) })
            : rateMissing
              ? t("Kurz měny není momentálně dostupný.")
              : sats > 0
                ? tf(t("≈ {amount} sats"), { amount: sats.toLocaleString(localeFor(lang)) })
                : " "}
        </span>
        {/* Always in the layout, hidden until there is an amount: showing it
            on the first digit moved the big number up under the finger. */}
        <button
          type="button"
          className={`pos-hero-add${entryAmount > 0 ? "" : " pos-hero-add--idle"}`}
          disabled={busy || entryAmount <= 0}
          tabIndex={entryAmount > 0 ? 0 : -1}
          aria-hidden={entryAmount > 0 ? undefined : true}
          onClick={() => update(commitEntry)}
        >
          {t("Přidat částku")}
        </button>
      </div>
      <div className="pos-keypad">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((key) => (
          <button type="button" key={key} className="pos-key" onClick={() => pressKey(key)} disabled={busy}>
            {key}
          </button>
        ))}
        {/* CZK has no decimals, so the comma's slot clears the typed amount
            only: clearing the whole receipt sits behind "Vymazat účtenku",
            never a key next to 0 and 7. */}
        {fractionDigits(currency) === 0 ? (
          <button
            type="button"
            className="pos-key pos-key-fn"
            onClick={() => update((d) => ({ ...d, entry: "" }))}
            disabled={busy || !draft.entry}
            aria-label={t("Smazat částku")}
          >
            C
          </button>
        ) : (
          <button type="button" className="pos-key" onClick={() => pressKey(".")} disabled={busy}>
            ,
          </button>
        )}
        <button type="button" className="pos-key" onClick={() => pressKey("0")} disabled={busy}>
          0
        </button>
        <button
          type="button"
          className="pos-key pos-key-fn"
          onClick={() => pressKey("back")}
          disabled={busy || !draft.entry}
          aria-label={t("Smazat")}
        >
          <BackspaceIcon />
        </button>
      </div>
    </>
  );

  // Wide: a real receipt, "4 × 55 Kč" under the name and line totals in
  // their own right-hand column, plus the amount still being typed (dashed),
  // since the total under it already counts it.
  const receiptList = (wide: boolean) => (
    <ul className="pos-receipt-list">
      {lines.map((line) => (
        <li key={line.key} data-line-key={line.key} className={`pos-line${leaving.has(line.key) ? " pos-line--leaving" : ""}`}>
          <div className="pos-line-text">
            <span className="pos-line-name">{line.label}</span>
            {!wide ? (
              <span className="pos-line-amount">{formatFiat(line.amount, line.currency)}</span>
            ) : (
              line.itemId &&
              line.qty > 1 && (
                <span className="pos-line-amount">
                  {line.qty} × {formatFiat(line.amount / line.qty, line.currency)}
                </span>
              )
            )}
          </div>
          {line.itemId ? (
            <div className="pos-stepper">
              <button type="button" onClick={() => (line.qty <= 1 ? leave(line.key, () => changeQty(line.itemId!, -1)) : changeQty(line.itemId!, -1))} aria-label={t("Ubrat kus")}>
                <MinusIcon />
              </button>
              <span>{line.qty}</span>
              <button type="button" onClick={() => changeQty(line.itemId!, 1)} aria-label={t("Přidat kus")}>
                <PlusIcon />
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="pos-line-remove"
              onClick={() => leave(line.key, () => removeCustom(line.customId!))}
              aria-label={t("Odebrat z účtenky")}
            >
              <CrossIcon />
            </button>
          )}
          {wide && <span className="pos-line-total">{formatFiat(line.amount, line.currency)}</span>}
        </li>
      ))}
      {wide && entryAmount > 0 && (
        <li className="pos-line pos-line--entry">
          <div className="pos-line-text">
            <span className="pos-line-name">{customLabel}</span>
          </div>
          <span className="pos-line-total">{formatFiat(entryAmount, currency)}</span>
        </li>
      )}
    </ul>
  );

  const totalAmount = <div className="pos-total-amount">{total === null ? "…" : formatFiat(total, currency)}</div>;
  const totalSatsLine = (
    <div className="pos-total-sats">
      {rateMissing
        ? t("Kurz měny není momentálně dostupný.")
        : sats > 0
          ? tf(t("≈ {amount} sats"), { amount: sats.toLocaleString(localeFor(lang)) })
          : " "}
    </div>
  );

  const chargeButton = (
    // While the invoice is made the button looks like the send sheet's: the
    // sheen (motion.css .sending) and a verb with waiting dots.
    <button
      type="button"
      className={`pos-charge${busy ? " confirm-arm armed sending" : ""}`}
      disabled={busy || sats <= 0}
      onClick={charge}
    >
      {busy ? (
        <span className="sht-waiting">
          {t("Vytvářím fakturu")}
          <WaitingDots />
        </span>
      ) : rateMissing && (lines.length > 0 || entryAmount > 0) ? (
        t("Kurz není dostupný")
      ) : total !== null && total > 0 ? (
        tf(t("Účtovat {amount}"), { amount: formatFiat(total, currency) })
      ) : (
        t("Účtovat")
      )}
    </button>
  );

  if (wide) {
    const mainView = shownView === "receipt" ? (items.length > 0 ? "catalog" : "keypad") : shownView;
    return (
      <div className={`utility-hub-panel pos pos--wide${fresh ? " pos--fresh" : ""}`}>
        <section className="pos-main">
          <div className="pos-main-head">
            {chips}
          </div>
          <div key={mainView} className={`pos-body pos-body--${mainView}`}>{mainView === "catalog" ? catalog : keypad}</div>
        </section>
        <aside className="pos-side" aria-label={t("Účtenka")}>
          <div className="pos-side-head">
            <span className="pos-side-title">
              {t("Účtenka")}
              {lineCount > 0 && <span className="pos-side-count">{lineCount}</span>}
            </span>
            {(lines.length > 0 || entryAmount > 0) && (
              clearButton
            )}
          </div>
          <div className="pos-side-lines">
            {lines.length === 0 && entryAmount <= 0 ? (
              <p className="pos-side-empty">{t("Účtenka je prázdná")}</p>
            ) : (
              receiptList(true)
            )}
          </div>
          <div className="pos-total pos-total--side">
            <div className="pos-total-row">
              <span className="pos-total-label">{t("Celkem")}</span>
              {totalAmount}
            </div>
            {totalSatsLine}
          </div>
          {chargeButton}
        </aside>
      </div>
    );
  }

  return (
    <div className={`utility-hub-panel pos${fresh ? " pos--fresh" : ""}`}>
      {chips}

      <div key={shownView} className={`pos-body pos-body--${shownView}`}>
        {shownView === "catalog" && catalog}
        {shownView === "keypad" && keypad}
        {shownView === "receipt" && (
          <div className="pos-receipt">
            {lines.length === 0 ? (
              <p className="pos-receipt-empty">{t("Účtenka je prázdná")}</p>
            ) : (
              <>
                {receiptList(false)}
                {clearButton}
              </>
            )}
          </div>
        )}
      </div>

      {chargeButton}
    </div>
  );
}

// Customer-facing: nothing from the wallet around it (UtilityHub hides its
// header and tabs), the amount from the sale that created this invoice.
function Checkout({
  wide,
  sale,
  invoice,
  paid,
  onCancel,
  onNext,
  onCopied,
}: {
  wide: boolean;
  sale: ActiveSale;
  invoice: string;
  paid: boolean;
  onCancel: () => void;
  onNext: () => void;
  onCopied: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const confirmTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    },
    [],
  );

  const copy = () => {
    navigator.clipboard.writeText(invoice).then(onCopied, () => reportError(t("Kopírování se nepovedlo.")));
  };

  // Two taps, so a stray one can't kill an invoice the customer may be
  // paying at that very moment. Falls back after a few seconds.
  const cancel = () => {
    if (!confirmCancel) {
      setConfirmCancel(true);
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirmCancel(false), 4000);
      return;
    }
    onCancel();
  };

  const amount = formatFiat(sale.total, sale.currency);
  const tipLine =
    sale.tip > 0 ? (
      <div className="pos-checkout-tip">
        {tf(t("{base} + dýško {tip}"), {
          base: formatFiat(addTip(sale.total, -sale.tip, sale.currency), sale.currency),
          tip: formatFiat(sale.tip, sale.currency),
        })}
      </div>
    ) : null;
  const satsText = tf(t("{amount} sats"), { amount: sale.sats.toLocaleString(localeFor(lang)) });

  if (paid) {
    return (
      <div className={`utility-hub-panel pos-checkout pos-checkout--paid${wide ? " pos-checkout--wide" : ""}`} role="status">
        {/* On a phone the button sits where "Účtovat" was, under the thumb. */}
        <div className="pos-paid-body">
          <div className="pos-paid-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path className="pos-paid-check" pathLength="1" d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="pos-paid-title">{t("Zaplaceno")}</div>
          <div className="pos-checkout-amount">{amount}</div>
          {tipLine}
          <div className="pos-checkout-sats">{satsText}</div>
        </div>
        <button type="button" className="pos-charge" onClick={onNext}>
          {t("Další zákazník")}
        </button>
      </div>
    );
  }

  const figures = (
    <div className="pos-figures">
      <div className="pos-checkout-amount">{amount}</div>
      {tipLine}
      <div className="pos-checkout-sats">{satsText}</div>
      {sale.summary && <div className="pos-checkout-summary">{sale.summary}</div>}
    </div>
  );
  const qr = (
    <button type="button" className="pos-qr-btn" onClick={copy} aria-label={t("Kopírovat fakturu")}>
      {/* Same encoding as Příjem (ReceiveScreen): scheme plus an upper-case
          invoice (bech32 allows it) puts the code in the QR's alphanumeric
          mode, far less dense than the lower-case invoice was. The quiet zone
          is part of the SVG (2 modules, plus the card's padding), so the card's
          rounded corners never touch a finder pattern. Copy still hands out the plain invoice. */}
      <QRCodeSVG value={`LIGHTNING:${invoice.toUpperCase()}`} size={280} marginSize={2} />
    </button>
  );
  const lead = <div className="pos-checkout-lead">{t("Naskenuj a zaplať přes Lightning")}</div>;
  const status = (
    <div className="pos-status">
      <button type="button" className={confirmCancel ? "danger small" : "secondary small"} onClick={cancel}>
        {confirmCancel ? t("Opravdu zrušit platbu?") : t("Zrušit platbu")}
      </button>
    </div>
  );

  if (wide) {
    return (
      <div className="utility-hub-panel pos-checkout pos-checkout--wide">
        {/* One grid, so the text column is exactly as tall as the QR card:
            the instruction sits on its top edge, the status on its bottom. */}
        <div className="pos-checkout-grid">
          <div className="pos-checkout-info">
            {lead}
            {figures}
            {status}
          </div>
          {qr}
        </div>
      </div>
    );
  }

  return (
    <div className="utility-hub-panel pos-checkout">
      {lead}
      {figures}
      {qr}
      {status}
    </div>
  );
}

// Customer-facing, before the invoice: percentages of the sale, an own
// amount, or none. The merchant gets back to the receipt with "Zpět".
function TipStep({
  wide,
  total,
  currency,
  busyKey,
  onPick,
  onBack,
}: {
  wide: boolean;
  total: number;
  currency: FiatCurrency;
  busyKey: string | null;
  onPick: (tip: number, note: string, key: string) => void;
  onBack: () => void;
}) {
  const t = useT();
  const [custom, setCustom] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = busyKey !== null;
  const tipNote = t("dýško");

  const submitCustom = (e: FormEvent) => {
    e.preventDefault();
    const value = parsePrice(text, currency);
    if (value === null || !tipFits(total, value, currency)) {
      setError(t("Zadej platnou částku."));
      return;
    }
    onPick(value, tipNote, "custom");
  };

  const busyClass = (key: string) => (busyKey === key ? " confirm-arm armed sending" : "");

  return (
    <div className={`utility-hub-panel pos-checkout pos-tip${wide ? " pos-tip--wide" : ""}`}>
      <div className="pos-checkout-lead">{t("Přidat dýško?")}</div>
      <div className="pos-figures">
        <div className="pos-checkout-amount">{formatFiat(total, currency)}</div>
      </div>
      <div className="pos-tip-choices">
        {custom ? (
          <form className="pos-tip-custom" onSubmit={submitCustom}>
            <input
              className="utility-hub-input"
              type="text"
              inputMode={fractionDigits(currency) === 0 ? "numeric" : "decimal"}
              maxLength={12}
              autoFocus
              disabled={busy}
              placeholder={tf(t("Dýško ({symbol})"), { symbol: CURRENCY_SYMBOLS[currency] })}
              aria-label={t("Dýško")}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
              }}
            />
            {error && <p className="utility-hub-error">{error}</p>}
            <button type="submit" className={`pos-charge${busyClass("custom")}`} disabled={busy}>
              {t("Potvrdit")}
            </button>
          </form>
        ) : (
          <>
            <div className="pos-tip-grid">
              {TIP_PERCENTS.map((percent) => {
                const tip = tipAmount(total, percent, currency);
                const key = `p${percent}`;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`pos-tip-option${busyClass(key)}`}
                    disabled={busy || tip <= 0 || !tipFits(total, tip, currency)}
                    onClick={() => onPick(tip, `${tipNote} ${percent} %`, key)}
                  >
                    <span className="pos-tip-pct">{percent} %</span>
                    <span className="pos-tip-add">+{formatFiat(tip, currency)}</span>
                  </button>
                );
              })}
              <button type="button" className="pos-tip-option pos-tip-option--other" disabled={busy} onClick={() => setCustom(true)}>
                {t("Jiné")}
              </button>
            </div>
            <button type="button" className={`pos-tip-option pos-tip-none${busyClass("none")}`} disabled={busy} onClick={() => onPick(0, "", "none")}>
              {t("Bez dýška")}
            </button>
          </>
        )}
      </div>
      <div className="pos-status">
        {/* One quiet link: back to the choices from an own amount, else back
            to the receipt. */}
        <button type="button" className="secondary small" disabled={busy} onClick={custom ? () => setCustom(false) : onBack}>
          {custom ? t("Zpět") : t("Upravit účtenku")}
        </button>
      </div>
    </div>
  );
}

function ManageItems({
  wide,
  items,
  currency,
  onSave,
  onDelete,
  onDone,
  tipsOn,
  onTipsChange,
}: {
  wide: boolean;
  items: PosItem[];
  currency: FiatCurrency;
  onSave: (id: string | null, name: string, price: number) => void;
  onDelete: (id: string) => void;
  onDone: () => void;
  tipsOn: boolean;
  onTipsChange: (on: boolean) => void;
}) {
  const t = useT();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const startEdit = (item: PosItem) => {
    setEditingId(item.id);
    setName(item.name);
    // Editing re-saves the price in the till's current currency, so start
    // from the stored number only when that is the same currency.
    setPrice(item.currency === currency ? String(item.price).replace(".", ",") : "");
    setError(null);
    setConfirmDeleteId(null);
    nameRef.current?.focus();
  };

  const resetForm = () => {
    setEditingId(null);
    setName("");
    setPrice("");
    setError(null);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    const value = parsePrice(price, currency);
    if (!trimmed) {
      setError(t("Zadej název položky."));
      return;
    }
    if (value === null) {
      setError(t("Zadej platnou cenu."));
      return;
    }
    onSave(editingId, trimmed, value);
    resetForm();
  };

  return (
    <div className={`utility-hub-panel pos-manage${wide ? " pos-manage--wide" : ""}`}>
      <div className="pos-manage-header">
        <h2 className="pos-manage-title">{t("Ceník")}</h2>
        <button type="button" className="secondary small" onClick={onDone}>
          {t("Hotovo")}
        </button>
      </div>

      <div className="pos-manage-side">
        <form className="utility-hub-card pos-manage-form" onSubmit={submit}>
          <div className="utility-hub-card-title">{editingId ? t("Upravit položku") : t("Nová položka")}</div>
          <input
            ref={nameRef}
            className="utility-hub-input"
            type="text"
            placeholder={t("Název položky")}
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="utility-hub-input"
            type="text"
            inputMode={fractionDigits(currency) === 0 ? "numeric" : "decimal"}
            maxLength={12}
            placeholder={tf(t("Cena ({symbol})"), { symbol: CURRENCY_SYMBOLS[currency] })}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          {error && <p className="utility-hub-error">{error}</p>}
          <div className="pos-manage-actions">
            {editingId && (
              <button type="button" className="secondary" onClick={resetForm}>
                {t("Zrušit")}
              </button>
            )}
            <button type="submit" className="utility-hub-submit">
              {editingId ? t("Uložit") : t("Přidat položku")}
            </button>
          </div>
        </form>

        <div className="utility-hub-card pos-manage-tips">
          <div className="pos-manage-tips-copy">
            <div className="boolean-switch-copy">{t("Dýško")}</div>
            <div className="pos-manage-tips-hint">{t("Nabídnout před platbou")}</div>
          </div>
          <BooleanSwitch checked={tipsOn} onChange={onTipsChange} label={t("Dýško")} />
        </div>
      </div>

      {items.length === 0 ? (
        <p className="muted">{t("Zatím žádné položky.")}</p>
      ) : (
        <ul className="pos-manage-list">
          {items.map((item) => (
            <li key={item.id} className={`pos-manage-row${editingId === item.id ? " pos-manage-row--editing" : ""}`}>
              <button type="button" className="pos-manage-row-text" onClick={() => startEdit(item)}>
                <span className="pos-manage-name">{item.name}</span>
                <span className="pos-manage-price">{formatFiat(item.price, item.currency)}</span>
              </button>
              <button
                type="button"
                className={confirmDeleteId === item.id ? "pos-manage-delete pos-manage-delete--confirm" : "pos-manage-delete"}
                onClick={() => {
                  if (confirmDeleteId !== item.id) {
                    setConfirmDeleteId(item.id);
                    return;
                  }
                  setConfirmDeleteId(null);
                  if (editingId === item.id) resetForm();
                  onDelete(item.id);
                }}
                aria-label={confirmDeleteId === item.id ? undefined : t("Smazat položku")}
              >
                {confirmDeleteId === item.id ? t("Smazat") : <CrossIcon />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MinusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function BackspaceIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8.5 5H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8.5L2 12l6.5-7Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      {/* Centred on the whole inside, arrow tip included, not on the box
          part alone: centred on the box it reads as pushed right. */}
      <path d="M11 9l6 6M17 9l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function KeypadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {[5, 12, 19].flatMap((x) => [5, 12, 19].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.8" />))}
    </svg>
  );
}

function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8 6h12M8 12h12M8 18h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="4" cy="6" r="1.2" fill="currentColor" />
      <circle cx="4" cy="12" r="1.2" fill="currentColor" />
      <circle cx="4" cy="18" r="1.2" fill="currentColor" />
    </svg>
  );
}

// The same cross as the profile sheet's close button (an SVG, so it is
// centred by geometry and not by the font's glyph metrics).
function CrossIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
