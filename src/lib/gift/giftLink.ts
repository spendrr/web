// Pure encode/decode for the "send bitcoin as a link" fragment — split out
// so the claim screen and the sender panel share one definition and it can
// be unit/fuzz tested without a WASM handle or the DOM.
//
// The whole secret rides in the URL *fragment* (`#...`): a fragment is never
// sent to the server, never lands in Cloudflare logs, and is not fetched by
// link-preview crawlers. It is still a bearer secret — whoever holds the
// link holds the funds — so the sender UI caps the amount and the gift
// auto-returns after 7 days; this module only does the string <-> struct
// conversion.
import { fromB64, toB64 } from "../vault/vaultCrypto";

// A real path (not just a query on "/") so the claim screen can special-case
// it before booting the full app state machine. The SPA fallback serves
// index.html for it like any other route.
export const GIFT_PATH = "/g";

// Only version this module writes. decode rejects anything else outright
// rather than guessing — a future format change gets a new number and an
// explicit migration, never a silent reinterpretation of these fields.
export const GIFT_LINK_VERSION = 1;

// Advisory cap on the human message carried in the link. The claim screen
// shows it verbatim, so keep it short; longer input is truncated, not
// rejected (a stale/over-long message must never block a real claim).
const MAX_MESSAGE_CHARS = 140;

export interface GiftLinkParams {
  mnemonic: string;
  amountSats: number;
  message?: string;
  // Opaque id the sender uses to reconcile its own "sent links" list and to
  // make a double-open of the same link idempotent. Not security-relevant.
  id: string;
  // Set by a V2 sender: the recipient's new wallet is created without a password (deviceVault.ts). Only present
  // when true, so links without it decode exactly as before.
  passwordless?: boolean;
}

export type GiftLinkDecode =
  | { ok: true; gift: GiftLinkParams }
  | { ok: false; reason: "not-a-gift-link" | "bad-version" | "malformed" };

function b64urlEncodeString(s: string): string {
  const b64 = toB64(new TextEncoder().encode(s).buffer as ArrayBuffer);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecodeString(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  // atob (via fromB64) tolerates missing "=" padding on every engine this
  // app targets, so no need to re-pad.
  return new TextDecoder(undefined, { fatal: true }).decode(fromB64(b64));
}

// 8 random bytes -> 16 hex chars. Enough to not collide across one user's
// gifts; not a secret.
export function generateGiftId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Returns the fragment *including* the leading "#", ready to append to the
// gift URL.
export function encodeGiftFragment(params: GiftLinkParams): string {
  const q = new URLSearchParams();
  q.set("v", String(GIFT_LINK_VERSION));
  q.set("g", b64urlEncodeString(params.mnemonic));
  q.set("a", String(params.amountSats));
  q.set("id", params.id);
  if (params.passwordless) q.set("n", "1");
  if (params.message) {
    q.set("m", b64urlEncodeString(params.message.slice(0, MAX_MESSAGE_CHARS)));
  }
  return "#" + q.toString();
}

export function buildGiftUrl(origin: string, params: GiftLinkParams): string {
  return origin.replace(/\/+$/, "") + GIFT_PATH + encodeGiftFragment(params);
}

export function isGiftPath(pathname: string): boolean {
  return pathname === GIFT_PATH || pathname === GIFT_PATH + "/";
}

// `hash` is location.hash (with or without the leading "#"). Total function:
// any string in, a tagged result out, never throws.
export function decodeGiftFragment(hash: string): GiftLinkDecode {
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(hash.replace(/^#/, ""));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const v = q.get("v");
  if (v === null && q.get("g") === null) return { ok: false, reason: "not-a-gift-link" };
  if (v !== String(GIFT_LINK_VERSION)) return { ok: false, reason: "bad-version" };

  const gRaw = q.get("g");
  const aRaw = q.get("a");
  const id = q.get("id");
  if (!gRaw || !aRaw || !id) return { ok: false, reason: "malformed" };

  let mnemonic: string;
  try {
    mnemonic = b64urlDecodeString(gRaw).trim().replace(/\s+/g, " ");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  // Shape check only — BIP39 checksum is verified by the wallet open, which
  // is the one place with the wordlist. Reject obvious junk early so the
  // claim screen can say "bad link" instead of "wallet failed to open".
  const words = mnemonic.split(" ").filter(Boolean);
  if (words.length < 12 || words.length > 24 || !words.every((w) => /^[a-z]+$/.test(w))) {
    return { ok: false, reason: "malformed" };
  }

  // Number(aRaw) not parseInt: "12abc" must be rejected, not read as 12.
  const amountSats = Number(aRaw);
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    return { ok: false, reason: "malformed" };
  }

  if (!/^[0-9a-f]{1,32}$/i.test(id)) return { ok: false, reason: "malformed" };

  let message: string | undefined;
  const mRaw = q.get("m");
  if (mRaw) {
    try {
      message = b64urlDecodeString(mRaw).slice(0, MAX_MESSAGE_CHARS);
    } catch {
      // A corrupt message is not worth failing the whole claim for.
      message = undefined;
    }
  }

  return { ok: true, gift: { mnemonic, amountSats, message, id, ...(q.get("n") === "1" ? { passwordless: true } : {}) } };
}
