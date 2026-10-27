// "user@domain" (BIP 353 human-readable name, optionally with a leading "₿")
// to the DNS name that holds its payment record:
//   user.user._bitcoin-payment.domain.
//
// Pure: no network. The domain goes through URL for IDN to punycode, so what is
// looked up is exactly what DNS sees.
import { Bip353Error } from "./errors";
import { normalizeName } from "./dnsWire";

export interface HumanName {
  user: string;
  domain: string;
  dnsName: string;
}

const USER_RE = /^[a-z0-9._-]{1,64}$/;

export function parseHumanName(input: string): HumanName {
  let v = input.trim();
  if (v.startsWith("₿")) v = v.slice(1).trim();
  const at = v.indexOf("@");
  if (at < 1 || at !== v.lastIndexOf("@")) throw new Bip353Error("malformed", "not user@domain");
  const user = v.slice(0, at).toLowerCase();
  const rawDomain = v.slice(at + 1);
  if (!USER_RE.test(user) || user.startsWith(".") || user.endsWith(".") || user.includes("..")) {
    throw new Bip353Error("malformed", "bad user part");
  }
  let domain: string;
  try {
    // A bare host only: anything URL-shaped in the domain is a different
    // request than the one the user typed.
    if (/[/?#\\:\s]/.test(rawDomain)) throw new Error("not a host");
    const u = new URL("http://" + rawDomain);
    domain = u.hostname;
  } catch {
    throw new Bip353Error("malformed", "bad domain");
  }
  domain = domain.replace(/\.$/, "");
  if (!domain.includes(".")) throw new Bip353Error("malformed", "domain needs a dot");
  // Host labels: letters, digits and inner hyphens (punycode already applied).
  if (!domain.split(".").every((l) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l))) throw new Bip353Error("malformed", "bad domain label");
  // An all-digit last label is an IP address, not a name anyone published records under.
  if (/^\d+$/.test(domain.split(".").pop()!)) throw new Bip353Error("malformed", "bad domain label");
  const dnsName = normalizeName(`${user}.user._bitcoin-payment.${domain}`);
  return { user, domain, dnsName };
}
