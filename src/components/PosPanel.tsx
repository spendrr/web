import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
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
  receiptLines,
  saleDescription,
  saleTotal,
  totalSats,
  type PosDraft,
} from "../lib/pos/posSale";
import { dismissErrorToast, reportError } from "../lib/appErrors";
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
// switches to Převodník/Mapa or closes the hub, and a half-built receipt
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
  summary: string;
}
let savedSale: ActiveSale | null = null;

const CURRENCY_SYMBOLS: Record<FiatCurrency, string> = { czk: "Kč", eur: "€", usd: "$" };

type View = "catalog" | "keypad" | "receipt";

export default function PosPanel({
  wallet,
  rates,
  currency,
  pendingReceive,
  onInvoiceCreated,
  onCancelLightningWatch,
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

  useEffect(() => {
    savedDraft = draft;
  }, [draft]);
  useEffect(() => {
    savedSale = sale;
  }, [sale]);

  // Only the invoice this till created counts as a checkout. A Lightning
  // invoice made in Přijmout lives in the same pendingReceive slot, and the
  // till used to render it as its own sale.
  const pending =
    pendingReceive?.kind === "lightning" && sale && pendingReceive.invoice.paymentHash === sale.paymentHash
      ? pendingReceive
      : null;
  const inCheckout = pending !== null;
  useEffect(() => {
    onCheckoutChange(inCheckout);
  }, [inCheckout, onCheckoutChange]);
  useEffect(() => () => onCheckoutChange(false), [onCheckoutChange]);

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

  const addItem = (id: string) => update((d) => ({ ...d, cart: { ...d.cart, [id]: (d.cart[id] ?? 0) + 1 } }));

  const changeQty = (itemId: string, delta: number) =>
    update((d) => {
      const qty = (d.cart[itemId] ?? 0) + delta;
      const cart = { ...d.cart };
      if (qty > 0) cart[itemId] = qty;
      else delete cart[itemId];
      return { ...d, cart };
    });

  const removeCustom = (id: string) => update((d) => ({ ...d, custom: d.custom.filter((c) => c.id !== id) }));

  const pressKey = (key: string) => update((d) => ({ ...d, entry: applyKey(d.entry, key, currency) }));

  // Moves the keypad amount onto the receipt as its own line and starts a
  // fresh entry, for ringing up several ad-hoc amounts in one sale.
  const commitEntry = useCallback((d: PosDraft): PosDraft => {
    const amount = entryValue(d.entry);
    if (amount <= 0) return { ...d, entry: "" };
    return { ...d, entry: "", custom: [...d.custom, { id: crypto.randomUUID(), amount, currency }] };
  }, [currency]);

  const clearAll = () => {
    update(() => EMPTY_DRAFT);
    setView(items.length > 0 ? "catalog" : "keypad");
  };

  const charge = useCallback(async () => {
    if (!rates || total === null) {
      reportError(t("Kurz měny není momentálně dostupný."));
      return;
    }
    if (!Number.isInteger(sats) || sats <= 0) {
      reportError(t("Zadej platnou částku."));
      return;
    }
    const committed = commitEntry(draft);
    const summary = saleDescription(
      receiptLines(committed, items, currency, rates, customLabel),
      formatFiat,
    );
    setBusy(true);
    dismissErrorToast();
    try {
      const inv = await wallet.bolt11Invoice(summary ? { amountSats: sats, description: summary } : { amountSats: sats });
      setDraft(committed);
      setSale({ paymentHash: inv.paymentHash, total, currency, sats: inv.amountSats, summary });
      onInvoiceCreated(inv);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  }, [rates, total, sats, commitEntry, draft, items, currency, customLabel, wallet, onInvoiceCreated, t]);

  // Paid: the sale is done, start the next one from an empty receipt.
  const nextCustomer = useCallback(() => {
    onCancelLightningWatch();
    setSale(null);
    setDraft(EMPTY_DRAFT);
    setView(items.length > 0 ? "catalog" : "keypad");
  }, [onCancelLightningWatch, items.length]);

  // Not paid yet: cancel the invoice but keep the receipt, since the usual
  // reason is fixing it (wrong item, customer adds something).
  const cancelCheckout = useCallback(() => {
    onCancelLightningWatch();
    setSale(null);
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
      if (managing || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
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

  if (pending && sale) {
    return (
      <Checkout
        wide={wide}
        sale={sale}
        invoice={pending.invoice.invoice}
        paid={pending.status === "paid"}
        onCancel={cancelCheckout}
        onNext={nextCustomer}
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
        onDone={() => {
          onManagingChange(false);
          if (items.length > 0 && view === "keypad" && lines.length === 0 && !draft.entry) setView("catalog");
        }}
      />
    );
  }

  const shownView: View = view === "receipt" && lines.length === 0 ? "catalog" : view;
  const entryAmount = entryValue(draft.entry);

  const modeToggle = (
    <div className="mode-toggle pos-mode" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={shownView === "keypad"}
        className={shownView === "keypad" ? "active" : ""}
        onClick={() => setView("keypad")}
      >
        {t("Částka")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={shownView !== "keypad"}
        className={shownView !== "keypad" ? "active" : ""}
        onClick={() => setView("catalog")}
      >
        {t("Ceník")}
      </button>
    </div>
  );

  const catalog =
    items.length === 0 ? (
      <div className="pos-empty">
        <p>{t("Ceník je prázdný. Přidej zboží, které prodáváš, a pak ho jen ťukáš.")}</p>
        <button type="button" className="secondary small" onClick={() => onManagingChange(true)}>
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
      <div className="pos-entry">
        <span className="pos-entry-amount">
          {formatEntry(draft.entry)} <span className="pos-entry-currency">{CURRENCY_SYMBOLS[currency]}</span>
        </span>
        <button
          type="button"
          className="secondary small pos-entry-add"
          disabled={busy || entryAmount <= 0}
          onClick={() => update(commitEntry)}
        >
          {t("+ Další částka")}
        </button>
      </div>
      <div className="pos-keypad">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((key) => (
          <button type="button" key={key} className="pos-key" onClick={() => pressKey(key)} disabled={busy}>
            {key}
          </button>
        ))}
        {/* CZK has no decimals, so the comma's slot clears the whole sale
            (receipt and typed amount) and stays on the keypad. */}
        {fractionDigits(currency) === 0 ? (
          <button
            type="button"
            className="pos-key pos-key-fn"
            onClick={() => update(() => EMPTY_DRAFT)}
            disabled={busy || (lines.length === 0 && !draft.entry)}
            aria-label={t("Vymazat účtenku")}
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
        <li key={line.key} className="pos-line">
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
              <button type="button" onClick={() => changeQty(line.itemId!, -1)} aria-label={t("Ubrat kus")}>
                −
              </button>
              <span>{line.qty}</span>
              <button type="button" onClick={() => changeQty(line.itemId!, 1)} aria-label={t("Přidat kus")}>
                +
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="pos-line-remove"
              onClick={() => removeCustom(line.customId!)}
              aria-label={t("Odebrat z účtenky")}
            >
              ×
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
    <button type="button" className="pos-charge" disabled={busy || sats <= 0} onClick={charge}>
      {busy
        ? t("Vytvářím fakturu…")
        : total !== null && total > 0
          ? tf(t("Účtovat {amount}"), { amount: formatFiat(total, currency) })
          : t("Účtovat")}
    </button>
  );

  if (wide) {
    const mainView = shownView === "receipt" ? (items.length > 0 ? "catalog" : "keypad") : shownView;
    return (
      <div className="utility-hub-panel pos pos--wide">
        <section className="pos-main">
          <div className="pos-main-head">
            {modeToggle}
            <p className="pos-kbd-hint">{t("Částku můžeš psát i na klávesnici, Enter účtuje.")}</p>
          </div>
          <div className={`pos-body pos-body--${mainView}`}>{mainView === "catalog" ? catalog : keypad}</div>
        </section>
        <aside className="pos-side" aria-label={t("Účtenka")}>
          <div className="pos-side-head">
            <span className="pos-side-title">
              {t("Účtenka")}
              {lineCount > 0 && <span className="pos-side-count">{lineCount}</span>}
            </span>
            {(lines.length > 0 || entryAmount > 0) && (
              <button type="button" className="secondary small" onClick={clearAll}>
                {t("Vymazat účtenku")}
              </button>
            )}
          </div>
          <div className="pos-side-lines">
            {lines.length === 0 && entryAmount <= 0 ? (
              <p className="pos-side-empty">{t("Účtenka je prázdná. Ťukni na položku nebo zadej částku.")}</p>
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
    <div className="utility-hub-panel pos">
      <div className="pos-total">
        {totalAmount}
        {totalSatsLine}
        {lines.length > 0 && (
          <button
            type="button"
            className={`pos-receipt-toggle${shownView === "receipt" ? " pos-receipt-toggle--open" : ""}`}
            onClick={() => setView(shownView === "receipt" ? (items.length > 0 ? "catalog" : "keypad") : "receipt")}
            aria-expanded={shownView === "receipt"}
          >
            {tf(t("{count} ks na účtence"), { count: lineCount })}
            {" · "}
            <span className="pos-receipt-toggle-action">{shownView === "receipt" ? t("Hotovo") : t("Upravit")}</span>
          </button>
        )}
      </div>

      {shownView !== "receipt" && modeToggle}

      <div className={`pos-body pos-body--${shownView}`}>
        {shownView === "catalog" && catalog}
        {shownView === "keypad" && keypad}
        {shownView === "receipt" && (
          <div className="pos-receipt">
            {receiptList(false)}
            <button type="button" className="secondary small pos-clear" onClick={clearAll}>
              {t("Vymazat účtenku")}
            </button>
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
}: {
  wide: boolean;
  sale: ActiveSale;
  invoice: string;
  paid: boolean;
  onCancel: () => void;
  onNext: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const confirmTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    },
    [],
  );

  const copy = () => {
    navigator.clipboard.writeText(invoice).then(
      () => {
        setCopied(true);
        if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
      },
      () => {},
    );
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
  const satsText = tf(t("{amount} sats"), { amount: sale.sats.toLocaleString(localeFor(lang)) });

  if (paid) {
    return (
      <div className={`utility-hub-panel pos-checkout pos-checkout--paid${wide ? " pos-checkout--wide" : ""}`} role="status">
        <div className="pos-paid-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="pos-paid-title">{t("Zaplaceno")}</div>
        <div className="pos-checkout-amount">{amount}</div>
        <div className="pos-checkout-sats">{satsText}</div>
        <button type="button" className="pos-charge" onClick={onNext}>
          {t("Další zákazník")}
        </button>
      </div>
    );
  }

  const figures = (
    <>
      <div className="pos-checkout-amount">{amount}</div>
      <div className="pos-checkout-sats">{satsText}</div>
      {sale.summary && <div className="pos-checkout-summary">{sale.summary}</div>}
    </>
  );
  const qr = (
    <button type="button" className="pos-qr-btn" onClick={copy} aria-label={t("Kopírovat fakturu")}>
      <QRCodeSVG value={invoice} size={280} />
    </button>
  );
  const status = (
    <>
      <div className="pos-waiting" aria-live="polite">
        {copied ? (
          <span>{t("Faktura zkopírována")}</span>
        ) : (
          <>
            <WaitingClockIcon />
            <span>{t("Čekám na platbu…")}</span>
          </>
        )}
      </div>
      <button type="button" className={confirmCancel ? "danger small" : "secondary small"} onClick={cancel}>
        {confirmCancel ? t("Opravdu zrušit platbu?") : t("Zrušit platbu")}
      </button>
    </>
  );

  if (wide) {
    return (
      <div className="utility-hub-panel pos-checkout pos-checkout--wide">
        <div className="pos-checkout-info">
          <div className="pos-checkout-lead">{t("Naskenuj a zaplať přes Lightning")}</div>
          {figures}
          {status}
        </div>
        {qr}
      </div>
    );
  }

  return (
    <div className="utility-hub-panel pos-checkout">
      {figures}
      {qr}
      {status}
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
}: {
  wide: boolean;
  items: PosItem[];
  currency: FiatCurrency;
  onSave: (id: string | null, name: string, price: number) => void;
  onDelete: (id: string) => void;
  onDone: () => void;
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
    const value = Number(price.replace(/\s/g, "").replace(",", "."));
    if (!trimmed) {
      setError(t("Zadej název položky."));
      return;
    }
    if (!Number.isFinite(value) || value <= 0) {
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
          inputMode="decimal"
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
                className={confirmDeleteId === item.id ? "danger small" : "pos-manage-delete"}
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
                {confirmDeleteId === item.id ? t("Smazat") : "×"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// An alarm-clock face with turning hands, not the app's usual spinning-ring
// .spinner: the ring reads as "an operation is in flight", this is "waiting
// on an external event with no fixed end". Only the hands rotate, around the
// face's exact center (12,13 in the viewBox), pinned via transform-box in
// PosPanel.css rather than left to the browser default.
function WaitingClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="pos-clock">
      <path d="M5 3L2 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M19 3l3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="13" r="8" stroke="currentColor" strokeWidth="2" />
      <line x1="12" y1="13" x2="12" y2="8.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="pos-clock-hand pos-clock-hand--minute" />
      <line x1="12" y1="13" x2="15" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="pos-clock-hand pos-clock-hand--hour" />
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
