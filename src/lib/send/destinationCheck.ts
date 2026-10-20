// Local, synchronous checks for what the Send form was typed or scanned:
// which kind of destination a string is, whether it is well formed (checksum,
// network) and what a scanned BIP21 / unified payment URI holds. Split from
// destination.ts because it needs network.ts (this build's network) and the
// bech32 primitives; destination.ts is imported by the Cloudflare Worker and
// must stay free of them.
import { BECH32M_CONST, BECH32_CHARSET, BECH32_CONST, bech32HrpExpand, bech32Polymod } from "./bitcoinAddress";
import { decodeBolt11Amount, decodeBolt11Expiry, normalizeDestination } from "./destination";
import { decodeLnurlHost } from "./lnurl";
import { IS_SIGNET } from "../network";

export type StaticKind = "lightning-invoice" | "lightning-address" | "lightning-offer" | "lnurl";

// Decodes a bech32 / bech32m string into its hrp and 5-bit words (checksum
// included at the end), or null when the characters, the case or the checksum
// are wrong. No length cap: a BOLT11 invoice and an LNURL are far past
// BIP173's 90 characters, and an Ark address is 130.
export function bech32Decode(s: string, constants: readonly number[]): { hrp: string; words: number[] } | null {
  const lower = s.toLowerCase();
  if (s !== lower && s !== s.toUpperCase()) return null;
  const pos = lower.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lower.length) return null;
  const hrp = lower.slice(0, pos);
  const words: number[] = [];
  for (const c of lower.slice(pos + 1)) {
    const w = BECH32_CHARSET.indexOf(c);
    if (w === -1) return null;
    words.push(w);
  }
  if (!constants.includes(bech32Polymod(bech32HrpExpand(hrp).concat(words)))) return null;
  return { hrp, words };
}

// ln + network + optional amount, before the separator. Mainnet builds take
// only mainnet invoices and signet builds only (test/signet) ones: a
// wrong-network invoice used to pass as "invoice" and fail in the SDK after
// the user had confirmed.
const BOLT11_HRP_RE = /^ln(bc|tbs|tb|bcrt)(?:\d+[munp]?)?$/;
// 35-bit timestamp + a 520-bit signature + the checksum, in 5-bit words: the
// least any signed invoice can be.
const BOLT11_MIN_WORDS = 7 + 104 + 6;

function isValidBolt11(v: string): boolean {
  const d = bech32Decode(v, [BECH32_CONST]);
  if (!d || d.words.length < BOLT11_MIN_WORDS) return false;
  const m = BOLT11_HRP_RE.exec(d.hrp);
  if (!m) return false;
  return IS_SIGNET ? m[1] === "tbs" || m[1] === "tb" : m[1] === "bc";
}

// A BOLT12 offer is bech32 with the "lno" hrp, but without a checksum (BOLT12
// drops it), so only the alphabet and case can be checked here. The SDK is
// the real validator.
function isPlausibleOffer(v: string): boolean {
  const lower = v.toLowerCase();
  if (v !== lower && v !== v.toUpperCase()) return false;
  return lower.length >= 20 && /^lno1[02-9ac-hj-np-z]+$/.test(lower);
}

// user@domain.tld (LUD-16 for the user part, extended a little for real-world
// providers: upper case and "+"), domain as ordinary DNS labels, at least two
// of them, the last not all digits. Deliberately not "anything with an @":
// that let "a@b..c" and "user@-x.com" through to the SDK.
const ADDRESS_USER_RE = /^[A-Za-z0-9._+-]{1,64}$/;
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidLightningAddress(v: string): boolean {
  const at = v.indexOf("@");
  if (at < 1 || at !== v.lastIndexOf("@")) return false;
  if (!ADDRESS_USER_RE.test(v.slice(0, at))) return false;
  const domain = v.slice(at + 1).toLowerCase();
  if (domain.length > 253) return false;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => DNS_LABEL_RE.test(l))) return false;
  return !/^\d+$/.test(labels[labels.length - 1]);
}

// An Ark address is bech32m, hrp "ark" (mainnet) or "tark" (test networks).
// Checked with a real mainnet address: 130 characters, checksum constant
// 0x2bc830a3. This only says "well formed"; whether it is for the server this
// wallet talks to is the SDK's call (validateArkoorAddress), which stays the
// authority. Both hrps on both builds, so the typo filter never depends on
// which network the build believes it is on.
export function isArkAddressShape(input: string): boolean {
  const v = normalizeDestination(input);
  const d = bech32Decode(v, [BECH32M_CONST]);
  return d !== null && (d.hrp === "ark" || d.hrp === "tark");
}

// Synchronous, local classification of everything that is not an Ark or
// on-chain address. A string that claims to be one of the Lightning kinds
// (an ln prefix, an @) but fails its own checks is "invalid" here, at once,
// rather than "unknown" until the SDK rejects it after the confirm screen.
// null = none of these, so the caller goes on to the address checks.
export function classifyStatic(input: string): StaticKind | "invalid" | null {
  const v = normalizeDestination(input);
  if (v.toLowerCase().startsWith("bitcoin:")) return null;
  // Before the ln* prefixes: a bech32 invoice or LNURL never contains "@",
  // so an @ settles it, and "lnbc1@example.com" is an address, not an invoice.
  if (v.includes("@")) return isValidLightningAddress(v) ? "lightning-address" : "invalid";
  const lower = v.toLowerCase();
  if (lower.startsWith("lnurl")) return decodeLnurlHost(v) !== null ? "lnurl" : "invalid";
  if (lower.startsWith("lno1")) return isPlausibleOffer(v) ? "lightning-offer" : "invalid";
  if (lower.startsWith("lnbc") || lower.startsWith("lntb")) return isValidBolt11(v) ? "lightning-invoice" : "invalid";
  return null;
}

// BIP21's amount grammar: digits, optionally a dot and digits, in BTC. No
// exponent ("1e-3" is not one, though Number() reads it), no sign. Converted
// to sats by string arithmetic, not a float multiply.
function btcAmountToSats(value: string): number | undefined {
  const m = /^(\d*)(?:\.(\d{0,8}))?$/.exec(value);
  if (!m || (m[1] === "" && !m[2])) return undefined;
  const sats = Number(m[1] || "0") * 1e8 + Number((m[2] ?? "").padEnd(8, "0"));
  return Number.isSafeInteger(sats) && sats > 0 ? sats : undefined;
}

// Whether a candidate from a URI parameter is worth offering to the form: it
// has to pass the same local checks the form itself would apply, so a broken
// or wrong-network parameter falls through to the next one instead of
// replacing a payable on-chain address with something that shows "invalid".
function usableLightning(kind: "lightning-invoice" | "lightning-offer", value: string, now: number): string | null {
  const v = normalizeDestination(value);
  if (classifyStatic(v) !== kind) return null;
  if (kind === "lightning-invoice") {
    const expiry = decodeBolt11Expiry(v);
    if (expiry !== null && expiry <= now) return null;
  }
  return v;
}

// Camera-scanned QR codes for on-chain addresses commonly encode a BIP21 URI
// (`bitcoin:bc1q...?amount=0.001&label=...`) rather than a bare address —
// classifyStatic() above deliberately doesn't unwrap these since it only
// handles synchronous cases, so the scanner does it once, up front.
//
// A BIP21 URI can also be a unified payment code: `ark=`, `lightning=` (a
// BOLT11 invoice) and `lno=` (a BOLT12 offer) beside the on-chain address,
// which may even be empty (`bitcoin:?lno=…`). Cheapest first: Ark, then
// Lightning, then on-chain. Only a parameter that passes its own local check
// is taken. An invoice that carries its own amount drops the URI's amount
// (the form refuses two that disagree). A `req-` parameter is one BIP21 says a
// wallet must refuse if it does not understand it: the raw text goes back, so
// the form shows it as invalid instead of paying something the sender marked
// as required to be understood.
export function parseScannedPayload(raw: string, now: number = Date.now()): { destination: string; amountSats?: number } {
  const text = raw.trim();
  const lower = text.toLowerCase();
  if (lower.startsWith("bitcoin:")) {
    let uri: URL;
    try {
      uri = new URL(text);
    } catch {
      return { destination: text.slice("bitcoin:".length).split("?")[0] };
    }
    const params = new Map<string, string>();
    for (const [k, val] of uri.searchParams) {
      const key = k.toLowerCase();
      if (key.startsWith("req-")) return { destination: text };
      if (!params.has(key)) params.set(key, val);
    }
    const amountBtc = params.get("amount");
    const amountSats = amountBtc ? btcAmountToSats(amountBtc) : undefined;
    const path = uri.pathname || "";
    const arkParam = params.get("ark");
    if (arkParam && isArkAddressShape(arkParam)) return { destination: normalizeDestination(arkParam), amountSats };
    const invoice = usableLightning("lightning-invoice", params.get("lightning") ?? "", now);
    if (invoice) return { destination: invoice, amountSats: decodeBolt11Amount(invoice) !== null ? undefined : amountSats };
    const offer = usableLightning("lightning-offer", params.get("lno") ?? "", now);
    if (offer) return { destination: offer, amountSats };
    return { destination: path || text.slice("bitcoin:".length).split("?")[0], amountSats };
  }
  if (lower.startsWith("lightning:")) {
    return { destination: text.slice("lightning:".length).split("?")[0] };
  }
  if (lower.startsWith("ark:")) {
    try {
      const uri = new URL(text);
      const amountParam = uri.searchParams.get("amount");
      const amountSats = amountParam ? Number(amountParam) : undefined;
      return {
        destination: uri.pathname || text.slice("ark:".length).split("?")[0],
        amountSats: amountSats !== undefined && Number.isInteger(amountSats) && amountSats > 0 ? amountSats : undefined,
      };
    } catch {
      return { destination: text.slice("ark:".length).split("?")[0] };
    }
  }
  return { destination: text };
}

