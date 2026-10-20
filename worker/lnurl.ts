// Pure LNURL-pay (LUD-06/16/12/21) logic for `name@spendrr.app`. No network,
// no Durable Object, no fetch — everything here is a plain function over its
// arguments so it can be unit-tested the same way NameRegistryCore is.
//
// Background: docs/ln-address-plan.md. The one real compatibility risk (a
// wallet that insists on `description_hash`) is out of scope for this file —
// it's a property of the invoice barkd returns, not of the request/response
// shapes here.

// Beta limits (docs/ln-address-plan.md section 4.2). Msat because that's what
// LNURL callbacks speak; this app only ever deals in whole sats, enforced by
// requiring the amount to be a multiple of 1000 msat.
export const MIN_SENDABLE_MSAT = 100_000; // 100 sats
export const MAX_SENDABLE_MSAT = 1_000_000_000; // 1,000,000 sats, beta ceiling
export const MAX_COMMENT_CHARS = 140; // LUD-12

// Per-name and account-wide caps on simultaneously open (unsettled) invoices —
// each one is a live hold invoice on the Ark server plus a service-key index,
// so this is a cost/abuse bound, not a UX one.
//
// An "open" slot is an invoice issued within the last OPEN_SLOT_MS and not yet
// paid. It is deliberately shorter-lived than the invoice itself (the Ark
// server's hold invoice lasts far longer, 48h by captaind's default): the
// callback is public and free, so a slot that lived as long as the invoice
// would let anyone park 20 requests on a name and switch its Lightning address
// off for that whole time. Tracking the payment (LnLedger's p: index) keeps
// going until the invoice's own expiry regardless.
export const MAX_OPEN_PER_NAME = 20;
export const MAX_OPEN_GLOBAL = 2000;
export const OPEN_SLOT_MS = 10 * 60 * 1000;
// Per payer network (IPv4 address / IPv6 /64, bumpRateLimitKey) and name, so
// one source can't take a name's whole budget on its own. Not 1: a custodial
// wallet's users all arrive from its servers' few addresses.
export const MAX_OPEN_PER_SOURCE_PER_NAME = 5;

export interface PayRequest {
  tag: "payRequest";
  callback: string;
  minSendable: number;
  maxSendable: number;
  metadata: string;
  commentAllowed: number;
}

// The metadata array LUD-06 requires, serialized once so both the payRequest
// response and the invoice memo (same text) come from one place. Kept short
// and plain — it becomes the BOLT11 description, visible in every wallet's
// payment confirmation screen.
export function lnAddressMetadata(name: string, origin: string): [string, string][] {
  return [
    ["text/plain", `Platba pro @${name} (Spendrr)`],
    ["text/identifier", `${name}${lnAddressDomain(origin)}`],
  ];
}

// The domain part of the LN address, "@spendrr.app" — derived from the
// request's own origin rather than hardcoded, so this keeps working under a
// preview/staging origin too.
function lnAddressDomain(origin: string): string {
  return `@${new URL(origin).hostname}`;
}

export function lnAddressMetadataString(name: string, origin: string): string {
  return JSON.stringify(lnAddressMetadata(name, origin));
}

export function buildPayRequest(name: string, origin: string): PayRequest {
  return {
    tag: "payRequest",
    callback: `${origin}/api/lnurlp/${name}/cb`,
    minSendable: MIN_SENDABLE_MSAT,
    maxSendable: MAX_SENDABLE_MSAT,
    metadata: lnAddressMetadataString(name, origin),
    commentAllowed: MAX_COMMENT_CHARS,
  };
}

export type AmountProblem = "missing" | "not-a-number" | "not-whole-sats" | "too-small" | "too-large";

// LUD-06 callback amount: a decimal string of millisatoshis. Must resolve to
// a whole number of sats (this app, like the invoice it requests, only ever
// deals in sats) and sit within the beta bounds.
export function parseCallbackAmountMsat(raw: string | null): { ok: true; sats: number } | { ok: false; problem: AmountProblem } {
  if (raw === null || raw === "") return { ok: false, problem: "missing" };
  if (!/^[0-9]+$/.test(raw)) return { ok: false, problem: "not-a-number" };
  const msat = Number(raw);
  if (!Number.isSafeInteger(msat)) return { ok: false, problem: "not-a-number" };
  if (msat % 1000 !== 0) return { ok: false, problem: "not-whole-sats" };
  if (msat < MIN_SENDABLE_MSAT) return { ok: false, problem: "too-small" };
  if (msat > MAX_SENDABLE_MSAT) return { ok: false, problem: "too-large" };
  return { ok: true, sats: msat / 1000 };
}

// LUD-12: `comment` is optional and, if present, must fit commentAllowed. An
// over-length comment is a hard error (this app has no truncate-silently
// policy elsewhere), a missing one is just no comment.
export function parseCallbackComment(raw: string | null): { ok: true; comment: string | null } | { ok: false } {
  if (raw === null || raw === "") return { ok: true, comment: null };
  if (raw.length > MAX_COMMENT_CHARS) return { ok: false };
  return { ok: true, comment: raw };
}

// Every LNURL error is HTTP 200 with this body — wallets that implement the
// spec correctly read `status` before the HTTP status, and several real
// implementations treat a non-200 as "unreachable" rather than "declined".
export function lnurlError(reason: string): { status: "ERROR"; reason: string } {
  return { status: "ERROR", reason };
}

export function lnurlErrorResponse(reason: string): Response {
  return new Response(JSON.stringify(lnurlError(reason)), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}

export function lnurlJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}

// LUD-21 verify shape. `preimage` is null until settled — never sent for a
// still-pending or expired invoice.
export interface VerifyResponse {
  status: "OK" | "ERROR";
  settled: boolean;
  preimage: string | null;
  pr: string;
}

export function buildVerifyResponse(input: { settled: boolean; preimage: string | null; pr: string }): VerifyResponse {
  return { status: "OK", settled: input.settled, preimage: input.preimage, pr: input.pr };
}

// A payment_hash as barkd/the Ark server hand it back: 64 lowercase hex chars.
export const PAYMENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

export function isPlausiblePaymentHash(hash: string): boolean {
  return PAYMENT_HASH_PATTERN.test(hash);
}

// How a non-2xx answer from BARKD_URL reads, for health purposes. The request
// passes Cloudflare's edge, the tunnel, Access, Caddy and barkd, and only
// some of those failures mean "the node is down":
//   - "unreachable": Cloudflare's own origin/tunnel errors (502-504, 52x,
//     530) — nothing behind the tunnel answered.
//   - "denied": Cloudflare Access (a redirect to its login page, or 401/403)
//     or barkd refusing the bearer. The node may be up, but this Worker can't
//     use it, which for payers is the same as down; also what a rotated or
//     mistyped secret looks like.
//   - "http-error": anything else, i.e. barkd or Caddy answering with an
//     error for this one request. The node is up.
export type BarkdFailure = "unreachable" | "denied" | "http-error";

export function classifyBarkdStatus(status: number): BarkdFailure {
  if (status >= 300 && status < 400) return "denied";
  if (status === 401 || status === 403) return "denied";
  if (status === 502 || status === 503 || status === 504) return "unreachable";
  if (status >= 520 && status <= 530) return "unreachable";
  return "http-error";
}
