// Pure encode/decode for a "payment request" link — the mirror image of
// giftLink.ts. A gift link carries money *to* whoever opens it; a request
// link carries an ask *from* whoever opens it.
//
// Unlike a gift link this fragment holds **no secret at all**: an Ark
// address, an amount, an optional note, and optionally a BOLT11 invoice —
// every one of them something the payer has to learn anyway in order to
// pay. It still rides in the URL fragment rather than the query string, for
// the same reason a gift link does: a fragment is never sent to the server,
// so this app's own Worker logs never accumulate a list of who asked whom
// for how much.
//
// Why both an address and an invoice (see also the request composer's UI):
//   - the Ark address is what Spendrr itself pays, instantly, with no
//     expiry and no round-trip to create;
//   - the BOLT11 invoice is the fallback for someone who doesn't have
//     Spendrr at all — every Lightning wallet on the planet reads one. It
//     expires, so a request page treats a missing/expired invoice as a
//     normal state, never an error.
// Either may be absent (the invoice can fail to be created, and a request
// made for a Lightning-only audience still needs an address to be payable
// in-app); at least one must be present for the link to be usable.
import { fromB64, toB64 } from "../vault/vaultCrypto";

// A real path (not just a query on "/") so the request screen can
// special-case it before booting the full app state machine, exactly like
// GIFT_PATH. The SPA fallback serves index.html for it like any other route.
export const REQUEST_PATH = "/r";

// Only version this module writes. decode rejects anything else outright
// rather than guessing — a future format change gets a new number and an
// explicit migration, never a silent reinterpretation of these fields.
export const REQUEST_LINK_VERSION = 1;

// Advisory cap on the human note carried in the link. The request screen
// shows it verbatim, so keep it short; longer input is truncated, not
// rejected.
const MAX_NOTE_CHARS = 140;

// Sanity bounds on the address/invoice strings, so a hand-edited fragment
// can't hand the SDK a megabyte of junk.
const MAX_ADDRESS_CHARS = 200;
const MAX_INVOICE_CHARS = 2000;

export interface PaymentRequestParams {
  /** Ark address to pay — what Spendrr itself uses. */
  address?: string;
  /** BOLT11 invoice for the same amount — the any-wallet fallback. */
  invoice?: string;
  /** Unix ms after which `invoice` is known to be expired; advisory. */
  invoiceExpiresAt?: number;
  amountSats: number;
  note?: string;
  /** Opaque id, for the requester's own reconciliation. Not a secret. */
  id: string;
}

export type PaymentRequestDecode =
  | { ok: true; request: PaymentRequestParams }
  | { ok: false; reason: "not-a-request-link" | "bad-version" | "malformed" };

function b64urlEncodeString(s: string): string {
  const b64 = toB64(new TextEncoder().encode(s).buffer as ArrayBuffer);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecodeString(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return new TextDecoder(undefined, { fatal: true }).decode(fromB64(b64));
}

// 8 random bytes -> 16 hex chars. Same shape as a gift id; not a secret.
export function generateRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Returns the fragment *including* the leading "#", ready to append.
// The address and invoice are bech32 (lowercase alphanumeric, no URL-unsafe
// characters), so they go in verbatim — base64 would only make the link
// longer and the QR of it denser for no benefit.
export function encodeRequestFragment(params: PaymentRequestParams): string {
  const q = new URLSearchParams();
  q.set("v", String(REQUEST_LINK_VERSION));
  q.set("a", String(params.amountSats));
  q.set("id", params.id);
  if (params.address) q.set("d", params.address);
  if (params.invoice) q.set("ln", params.invoice);
  if (params.invoiceExpiresAt) q.set("x", String(Math.floor(params.invoiceExpiresAt / 1000)));
  if (params.note) q.set("m", b64urlEncodeString(params.note.slice(0, MAX_NOTE_CHARS)));
  return "#" + q.toString();
}

export function buildRequestUrl(origin: string, params: PaymentRequestParams): string {
  return origin.replace(/\/+$/, "") + REQUEST_PATH + encodeRequestFragment(params);
}

export function isRequestPath(pathname: string): boolean {
  return pathname === REQUEST_PATH || pathname === REQUEST_PATH + "/";
}

// `hash` is location.hash (with or without the leading "#"). Total function:
// any string in, a tagged result out, never throws.
export function decodeRequestFragment(hash: string): PaymentRequestDecode {
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(hash.replace(/^#/, ""));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const v = q.get("v");
  if (v === null && q.get("a") === null) return { ok: false, reason: "not-a-request-link" };
  if (v !== String(REQUEST_LINK_VERSION)) return { ok: false, reason: "bad-version" };

  const aRaw = q.get("a");
  const id = q.get("id");
  if (!aRaw || !id) return { ok: false, reason: "malformed" };

  // Digits only, checked before Number(): parseInt would read "12abc" as 12,
  // and a bare Number() accepts "1e3" (and " 10", and "+10") as 1000 — an
  // amount that round-trips to a different string than it arrived as. This
  // number is shown to the payer and handed to the SDK, so the two must be
  // the same characters both ways.
  if (!/^[0-9]{1,16}$/.test(aRaw)) return { ok: false, reason: "malformed" };
  const amountSats = Number(aRaw);
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) return { ok: false, reason: "malformed" };
  if (!/^[0-9a-f]{1,32}$/i.test(id)) return { ok: false, reason: "malformed" };

  // Shape checks only — the real validation is the wallet's own
  // validateArkoorAddress()/invoice decode, which is the one place with the
  // checksum. Reject obvious junk early so the request screen can say "bad
  // link" instead of surfacing an SDK error.
  const dRaw = q.get("d");
  let address: string | undefined;
  if (dRaw !== null) {
    const d = dRaw.trim().toLowerCase();
    if (!d || d.length > MAX_ADDRESS_CHARS || !/^ark1[02-9ac-hj-np-z]+$/.test(d)) {
      return { ok: false, reason: "malformed" };
    }
    address = d;
  }

  const lnRaw = q.get("ln");
  let invoice: string | undefined;
  if (lnRaw !== null) {
    const ln = lnRaw.trim().toLowerCase();
    if (!ln || ln.length > MAX_INVOICE_CHARS || !/^lnbc[0-9a-z]+$/.test(ln)) {
      return { ok: false, reason: "malformed" };
    }
    invoice = ln;
  }

  // A link with neither is not payable by anything, which is a malformed
  // link rather than an empty-but-valid one.
  if (!address && !invoice) return { ok: false, reason: "malformed" };

  let invoiceExpiresAt: number | undefined;
  const xRaw = q.get("x");
  if (xRaw) {
    const secs = Number(xRaw);
    // A bad expiry must not sink an otherwise payable request — it only
    // decides whether the page says "faktura vypršela", and the Ark address
    // is unaffected by it either way.
    if (Number.isSafeInteger(secs) && secs > 0) invoiceExpiresAt = secs * 1000;
  }

  let note: string | undefined;
  const mRaw = q.get("m");
  if (mRaw) {
    try {
      note = b64urlDecodeString(mRaw).slice(0, MAX_NOTE_CHARS);
    } catch {
      // A corrupt note is not worth failing the whole request for.
      note = undefined;
    }
  }

  return { ok: true, request: { address, invoice, invoiceExpiresAt, amountSats, note, id } };
}

export function isInvoiceExpired(req: PaymentRequestParams, now = Date.now()): boolean {
  return req.invoiceExpiresAt !== undefined && now >= req.invoiceExpiresAt;
}
