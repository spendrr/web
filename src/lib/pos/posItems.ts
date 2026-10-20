// Merchant-defined price list for the Point of Sale terminal (PosPanel.tsx).
// Purely local, device-only convenience data — not wallet funds, not synced
// to the cloud backup — so plain localStorage is enough; there's nothing
// here worth the IndexedDB/vault treatment the seed gets.
//
// Every item carries the currency its price was entered in. It used to be a
// bare number read in whatever currency Settings had at the moment, so
// switching Kč to € silently turned a 55 Kč espresso into a 55 € one.
// Items saved before the field existed have no currency on disk; they are
// stamped with the currency active the first time they are loaded (the one
// they were almost certainly typed in) and written back, once.

import type { FiatCurrency } from "../currency";

const STORAGE_KEY = "btc-wallet-pos-items";

export interface PosItem {
  id: string;
  name: string;
  price: number;
  currency: FiatCurrency;
}

function isCurrency(value: unknown): value is FiatCurrency {
  return value === "czk" || value === "eur" || value === "usd";
}

function isStoredItem(value: unknown): value is Omit<PosItem, "currency"> & { currency?: unknown } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.price === "number" &&
    Number.isFinite(v.price) &&
    v.price > 0
  );
}

export function loadPosItems(legacyCurrency: FiatCurrency): PosItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    let migrated = false;
    const items = parsed.filter(isStoredItem).map((item) => {
      if (isCurrency(item.currency)) return item as PosItem;
      migrated = true;
      return { id: item.id, name: item.name, price: item.price, currency: legacyCurrency };
    });
    if (migrated) savePosItems(items);
    return items;
  } catch {
    return [];
  }
}

function savePosItems(items: PosItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Best-effort — a quota error or disabled storage just means the
    // catalog doesn't persist across reloads; the sell flow still works.
  }
}

export function addPosItem(items: PosItem[], name: string, price: number, currency: FiatCurrency): PosItem[] {
  const next = [...items, { id: crypto.randomUUID(), name, price, currency }];
  savePosItems(next);
  return next;
}

export function updatePosItem(items: PosItem[], id: string, name: string, price: number, currency: FiatCurrency): PosItem[] {
  const next = items.map((item) => (item.id === id ? { ...item, name, price, currency } : item));
  savePosItems(next);
  return next;
}

export function removePosItem(items: PosItem[], id: string): PosItem[] {
  const next = items.filter((item) => item.id !== id);
  savePosItems(next);
  return next;
}
