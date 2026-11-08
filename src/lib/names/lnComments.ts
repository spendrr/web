// The message a payer attached to a Lightning-address payment (Phoenix "attach
// a message", LUD-12). Only the Worker knows it: it is not in the invoice and
// not in the Ark movement. It is fixed when the invoice is issued, so each
// payment is asked once, ever, and the answer (including "none") is kept on
// this device. A failed ask is not kept.
import { useEffect, useState } from "react";
import type { WalletClient } from "../wallet/bark";
import { fetchLnaddrComment } from "./names";

export const LN_COMMENTS_KEY = "btc-wallet-ln-comments";
// Oldest entries go first; a payment older than this is simply asked again.
export const LN_COMMENTS_MAX = 300;

type Fetcher = (hash: string) => Promise<{ found: boolean; comment: string | null }>;

function load(storage: Storage): Record<string, string> {
  try {
    const raw = storage.getItem(LN_COMMENTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function save(storage: Storage, entries: Record<string, string>): void {
  const keys = Object.keys(entries);
  const kept = keys.length > LN_COMMENTS_MAX ? Object.fromEntries(keys.slice(keys.length - LN_COMMENTS_MAX).map((k) => [k, entries[k]])) : entries;
  try {
    storage.setItem(LN_COMMENTS_KEY, JSON.stringify(kept));
  } catch {
    // Storage full or blocked: the answer is just asked again next time.
  }
}

// undefined: not asked yet. null: asked, there is no comment.
export function cachedLnComment(hash: string, storage: Storage = localStorage): string | null | undefined {
  const v = load(storage)[hash];
  return v === undefined ? undefined : v === "" ? null : v;
}

const inFlight = new Map<string, Promise<string | null>>();

export function loadLnComment(hash: string, fetcher: Fetcher, storage: Storage = localStorage): Promise<string | null> {
  const known = cachedLnComment(hash, storage);
  if (known !== undefined) return Promise.resolve(known);
  const pending = inFlight.get(hash);
  if (pending) return pending;
  const p = fetcher(hash)
    .then((r) => {
      const entries = load(storage);
      delete entries[hash];
      entries[hash] = r.found ? (r.comment ?? "") : "";
      save(storage, entries);
      return r.found ? r.comment : null;
    })
    .finally(() => inFlight.delete(hash));
  inFlight.set(hash, p);
  return p;
}

export function clearLnComments(storage: Storage = localStorage): void {
  try {
    storage.removeItem(LN_COMMENTS_KEY);
  } catch {
    // Nothing to clear.
  }
}

// The comment for a payment, or null. `hash` undefined (not a Lightning
// payment, or the feature is off) never asks.
export function useLnComment(wallet: WalletClient, hash: string | undefined): string | null {
  const [comment, setComment] = useState<string | null>(() => (hash ? (cachedLnComment(hash) ?? null) : null));
  useEffect(() => {
    if (!hash) return;
    let cancelled = false;
    void loadLnComment(hash, (h) => fetchLnaddrComment(wallet, h)).then(
      (c) => {
        if (!cancelled) setComment(c);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [wallet, hash]);
  return comment;
}
