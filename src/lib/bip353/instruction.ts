// BIP 353 TXT record -> payment methods. Structure only (BIP 321 URI); whether
// an address is valid for the network, or an Ark address is ours, is decided
// where the network is known (destinationCheck), not here.
//
// Fail closed on anything ambiguous: more than one bitcoin: record, a method
// given twice, a required (req-) parameter we do not know. A silent pick
// between two candidate destinations is exactly the thing an attacker who
// can add a record would want.
import { Bip353Error } from "./errors";

export interface PaymentInstruction {
  onchain?: string;
  ark?: string;
  offer?: string;
  bolt11?: string;
  amountSats?: number;
  label?: string;
  message?: string;
}

const MAX_RECORD = 8 * 1024;
// A payment value (address, offer, invoice) is printable ASCII, no whitespace.
const VALUE_RE = /^[\x21-\x7e]{1,4096}$/;
const KNOWN = new Set(["amount", "label", "message", "lno", "ark", "lightning", "sp", "bc", "tb"]);

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, "%2B"));
  } catch {
    throw new Bip353Error("malformed", "bad percent-encoding");
  }
}

// "0.001" -> 100000. Decimal BTC, at most 8 fractional digits, no sign, no
// exponent; integer maths so no float rounding can change an amount.
export function parseBtcAmount(s: string): number {
  const m = /^(\d{1,8})(?:\.(\d{1,8}))?$/.exec(s);
  if (!m) throw new Bip353Error("malformed", "bad amount");
  const sats = Number(m[1]) * 100_000_000 + Number((m[2] ?? "").padEnd(8, "0"));
  if (!Number.isSafeInteger(sats) || sats <= 0 || sats > 21_000_000 * 100_000_000) throw new Bip353Error("malformed", "amount out of range");
  return sats;
}

export function parsePaymentInstruction(records: string[]): PaymentInstruction {
  const candidates = records.filter((r) => r.toLowerCase().startsWith("bitcoin:"));
  if (candidates.length === 0) throw new Bip353Error("no_record", "no bitcoin: record");
  if (candidates.length > 1) throw new Bip353Error("ambiguous", "more than one bitcoin: record");
  const uri = candidates[0]!;
  if (uri.length > MAX_RECORD) throw new Bip353Error("malformed", "record too large");

  const rest = uri.slice("bitcoin:".length);
  const q = rest.indexOf("?");
  const path = q < 0 ? rest : rest.slice(0, q);
  const query = q < 0 ? "" : rest.slice(q + 1);
  const out: PaymentInstruction = {};

  if (path !== "") {
    const addr = decode(path);
    if (!VALUE_RE.test(addr)) throw new Bip353Error("malformed", "bad address");
    out.onchain = addr;
  }

  const seen = new Set<string>();
  for (const pair of query === "" ? [] : query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw new Bip353Error("malformed", "bad parameter");
    const key = decode(pair.slice(0, eq)).toLowerCase();
    const value = decode(pair.slice(eq + 1));
    if (seen.has(key)) throw new Bip353Error("ambiguous", `duplicate ${key}`);
    seen.add(key);
    if (key.startsWith("req-")) throw new Bip353Error("unsupported", `required parameter ${key}`);
    if (!KNOWN.has(key)) continue;
    switch (key) {
      case "amount":
        out.amountSats = parseBtcAmount(value);
        break;
      case "label":
        out.label = value;
        break;
      case "message":
        out.message = value;
        break;
      case "lno":
      case "ark":
      case "lightning":
        if (!VALUE_RE.test(value)) throw new Bip353Error("malformed", `bad ${key}`);
        if (key === "lno") out.offer = value;
        else if (key === "ark") out.ark = value;
        else out.bolt11 = value;
        break;
      default:
        // sp, bc, tb: a method we do not pay. Listed in KNOWN only so a
        // duplicate of it is still caught above.
        break;
    }
  }
  return out;
}
