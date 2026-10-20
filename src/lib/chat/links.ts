// Links inside a chat message. Pure and unit-tested: splits a message into
// plain text, our own things (an @name, a Spendrr gift or payment request
// link, a lightning/bitcoin/Ark destination) and foreign web links.
//
// Only an http(s) URL that `new URL()` accepts becomes a foreign link, and the
// chat never fetches anything for it (no previews). Our own things are only
// recognised here; paying or claiming them goes through the wallet's normal
// flows, which check the destination again.
import { checkHandle } from "../names/handle";
import { decodeGiftFragment, isGiftPath, type GiftLinkParams } from "../gift/giftLink";
import { decodeRequestFragment, isRequestPath, type PaymentRequestParams } from "../send/paymentRequest";
import { bech32Decode, classifyStatic, isArkAddressShape, parseScannedPayload } from "../send/destinationCheck";
import { BECH32M_CONST, BECH32_CONST } from "../send/bitcoinAddress";
import { decodeBolt11Amount } from "../send/destination";

export type PayKind = "lightning" | "bitcoin" | "ark";

export type LinkSegment =
  | { t: "text"; text: string }
  | { t: "name"; name: string; raw: string }
  // Something to pay: the destination the send form gets, as the scanner
  // would hand it over.
  | { t: "pay"; kind: PayKind; destination: string; amountSats?: number; raw: string }
  | { t: "gift"; gift: GiftLinkParams; raw: string }
  | { t: "request"; request: PaymentRequestParams; raw: string }
  | { t: "url"; url: string; host: string; raw: string };

// Punctuation that ends a sentence rather than a link: "viz spendrr.app/x."
const TRAILING = /[.,!?;:)\]}"'»”’]+$/;
const LEADING = /^[(["'«“‘]+/;
// Direction overrides, isolates and zero-width characters can make a link
// read as something other than where it goes. Such a token stays text.
// oxlint-disable-next-line no-control-regex -- matching invisible characters is the point
const DECEPTIVE = /[​-‏‪-‮⁦-⁩﻿]/;

// Recognition only, synchronous: a mainnet bech32(m) address with a valid
// checksum, or the shape of a legacy one. The send form runs the full check
// (base58 checksum included) before anything is paid.
function looksLikeBitcoinAddress(s: string): boolean {
  if (/^bc1/i.test(s)) return bech32Decode(s.toLowerCase(), [BECH32_CONST, BECH32M_CONST])?.hrp === "bc";
  return /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(s);
}

function classify(core: string, ourHosts: readonly string[]): LinkSegment | null {
  if (DECEPTIVE.test(core)) return null;
  const lower = core.toLowerCase();

  if (/^@[a-z0-9-]+$/i.test(core)) {
    const name = core.slice(1).toLowerCase();
    return checkHandle(name).ok ? { t: "name", name, raw: core } : null;
  }

  if (lower.startsWith("https://") || lower.startsWith("http://")) {
    let url: URL;
    try {
      url = new URL(core);
    } catch {
      return null;
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) return null;
    // "https://bank.cz@evil.example" reads as the bank and goes elsewhere.
    if (url.username || url.password) return null;
    if (ourHosts.includes(url.host)) {
      if (isGiftPath(url.pathname)) {
        const g = decodeGiftFragment(url.hash);
        if (g.ok) return { t: "gift", gift: g.gift, raw: core };
      }
      if (isRequestPath(url.pathname)) {
        const r = decodeRequestFragment(url.hash);
        if (r.ok && (r.request.address || r.request.invoice)) return { t: "request", request: r.request, raw: core };
      }
    }
    return { t: "url", url: url.href, host: url.hostname, raw: core };
  }

  if (lower.startsWith("lightning:") || lower.startsWith("bitcoin:") || lower.startsWith("ark:")) {
    const { destination, amountSats } = parseScannedPayload(core);
    if (!destination) return null;
    if (classifyStatic(destination) === "invalid") return null;
    const kind: PayKind = lower.startsWith("lightning:")
      ? "lightning"
      : isArkAddressShape(destination)
        ? "ark"
        : classifyStatic(destination)
          ? "lightning"
          : "bitcoin";
    if (kind === "bitcoin" && !looksLikeBitcoinAddress(destination)) return null;
    return { t: "pay", kind, destination, ...(amountSats ? { amountSats } : {}), raw: core };
  }

  const stat = classifyStatic(core);
  if (stat === "lightning-invoice" || stat === "lightning-offer" || stat === "lnurl") {
    const amount = stat === "lightning-invoice" ? decodeBolt11Amount(core) : null;
    return { t: "pay", kind: "lightning", destination: core, ...(amount ? { amountSats: amount } : {}), raw: core };
  }
  if (isArkAddressShape(core)) return { t: "pay", kind: "ark", destination: core, raw: core };
  if (looksLikeBitcoinAddress(core)) {
    return { t: "pay", kind: "bitcoin", destination: core, raw: core };
  }
  return null;
}

export function parseLinks(text: string, ourHosts: readonly string[]): LinkSegment[] {
  const out: LinkSegment[] = [];
  const pushText = (s: string) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (last?.t === "text") last.text += s;
    else out.push({ t: "text", text: s });
  };
  for (const token of text.split(/(\s+)/)) {
    if (!token || /^\s+$/.test(token)) {
      pushText(token);
      continue;
    }
    const lead = token.match(LEADING)?.[0] ?? "";
    const rest = token.slice(lead.length);
    const trail = rest.match(TRAILING)?.[0] ?? "";
    const core = rest.slice(0, rest.length - trail.length);
    const seg = core ? classify(core, ourHosts) : null;
    if (!seg) {
      pushText(token);
      continue;
    }
    pushText(lead);
    out.push(seg);
    pushText(trail);
  }
  return out;
}

// The part of a host a person should read: the registrable name, roughly
// (no public suffix list here), so "login.bank.cz.evil.example" shows its
// real owner "evil.example" in bold. Two labels, three under a short
// second-level like co.uk.
export function splitHost(host: string): { sub: string; main: string } {
  const labels = host.split(".");
  if (labels.length <= 2) return { sub: "", main: host };
  const sld = labels[labels.length - 2];
  const take = /^(co|com|org|net|gov|ac|edu)$/.test(sld) && labels.length > 2 ? 3 : 2;
  return { sub: labels.slice(0, -take).join(".") + ".", main: labels.slice(-take).join(".") };
}

// A long destination in the text, shortened: "lnbc25u1p…x9f2".
export function shortDestination(raw: string): string {
  return raw.length > 22 ? `${raw.slice(0, 12)}…${raw.slice(-6)}` : raw;
}
