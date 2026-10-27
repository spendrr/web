// What the Send form does with a BIP 353 name ("user@domain" or "₿user@domain"):
// whether a typed destination is one, and which of the methods in its record to
// pay. Pure, apart from the validators the caller injects.
//
// The record is a BIP 321 URI that may hold several methods. Cheapest first,
// like a scanned unified QR (parseScannedPayload): Ark, then a BOLT12 offer,
// then on-chain. Each is taken only if it passes the same local check the form
// applies to a typed destination, so a method for the wrong network or another
// Ark server is skipped rather than shown as invalid. A BOLT11 invoice in the
// record is ignored on purpose: a static DNS record cannot hold a fresh invoice.
import { parseHumanName } from "../bip353/name";
import type { PaymentInstruction } from "../bip353/instruction";
import { parseHandleDestination } from "../names/handle";
import { classifyStatic, isArkAddressShape } from "./destinationCheck";
import { normalizeDestination } from "./destination";

export interface Bip353Target {
  // user@domain, lowercase, without the ₿.
  name: string;
  // Typed with the ₿ prefix: the user asked for BIP 353 specifically, so a
  // missing record is an error and never a silent switch to a Lightning address.
  explicit: boolean;
}

// `bare`: whether a plain user@domain counts as a BIP 353 candidate (it is also
// a valid Lightning address; the caller falls back to that when the name has no
// record). Spendrr's own @names always go through the registry, never here.
export function bip353Target(destination: string, bare: boolean): Bip353Target | null {
  const raw = destination.trim();
  if (raw.toLowerCase().startsWith("lightning:")) return null;
  if (parseHandleDestination(raw) !== null) return null;
  const explicit = raw.startsWith("₿");
  if (!explicit && !bare) return null;
  try {
    const parsed = parseHumanName(normalizeDestination(raw));
    return { name: `${parsed.user}@${parsed.domain}`, explicit };
  } catch {
    return null;
  }
}

// `validUntil` is unix seconds (the end of the DNSSEC proof), `nowMs` Date.now().
export function bip353Expired(validUntil: number, nowMs: number): boolean {
  return validUntil * 1000 <= nowMs;
}

export type Bip353Method = "ark" | "lightning-offer" | "onchain";

export interface Bip353Pick {
  kind: Bip353Method;
  destination: string;
  amountSats?: number;
}

export interface Bip353Validators {
  // The SDK's verdict on an Ark address (is it for the server this wallet uses).
  arkAddress(address: string): Promise<boolean>;
  onchainAddress(address: string): Promise<boolean>;
}

export async function pickBip353Method(ins: PaymentInstruction, v: Bip353Validators): Promise<Bip353Pick | null> {
  if (ins.ark) {
    const ark = normalizeDestination(ins.ark);
    if (isArkAddressShape(ark) && (await v.arkAddress(ark))) return { kind: "ark", destination: ark, amountSats: ins.amountSats };
  }
  if (ins.offer) {
    const offer = normalizeDestination(ins.offer);
    if (classifyStatic(offer) === "lightning-offer") return { kind: "lightning-offer", destination: offer, amountSats: ins.amountSats };
  }
  if (ins.onchain && (await v.onchainAddress(ins.onchain))) return { kind: "onchain", destination: ins.onchain, amountSats: ins.amountSats };
  return null;
}
