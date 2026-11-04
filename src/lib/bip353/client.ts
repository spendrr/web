// App side of a BIP 353 lookup: ask our Worker for the DNSSEC proof, check it
// here, read the payment record out of it. The Worker is transport only
// (worker/bip353.ts); everything it hands back is verified against the DNS root
// trust anchor, so the four outcomes below are all this module ever reports:
//
//   found    a validated payment record
//   absent   the name has no payment record (the Worker said so, or the record
//            holds no bitcoin: URI). Nothing is proven by this: a lying Worker
//            can say "absent", which only denies the payment (or, for a bare
//            user@domain, sends it down the Lightning address path as before).
//   invalid  a record exists but failed our checks (bad signature, expired,
//            ambiguous, unsupported). Never to be worked around.
//   error    transport trouble, nothing was decided; retrying is safe
import { Bip353Error, type Bip353ErrorCode } from "./errors";
import { verifyTxtProof } from "./dnssec";
import { parsePaymentInstruction, type PaymentInstruction } from "./instruction";
import { parseHumanName } from "./name";

export type Bip353Outcome =
  | { kind: "found"; instruction: PaymentInstruction; validUntil: number }
  | { kind: "absent" }
  | { kind: "invalid"; code: Bip353ErrorCode }
  | { kind: "error" };

const TIMEOUT_MS = 8_000;
const MAX_BODY_CHARS = 100_000;
const CACHE_MS = 30_000;
const CACHE_MAX = 50;

const cache = new Map<string, { at: number; outcome: Bip353Outcome }>();
const inflight = new Map<string, Promise<Bip353Outcome>>();

export interface ResolveOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function fromBase64(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// The request carries only its own deadline, never a caller's signal: it is
// shared by every caller asking for the same name, so one of them leaving must
// not fail the others (a caller that left simply ignores the answer).
async function fetchProof(name: string, o: ResolveOptions): Promise<Uint8Array | "absent" | "error"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await (o.fetchImpl ?? fetch)(`/api/bip353?n=${encodeURIComponent(name)}`, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    if (res.status === 404) return "absent";
    if (!res.ok) return "error";
    const text = await res.text();
    if (text.length > MAX_BODY_CHARS) return "error";
    const body = JSON.parse(text) as { proof?: unknown };
    if (typeof body.proof !== "string") return "error";
    return fromBase64(body.proof) ?? "error";
  } catch {
    return "error";
  } finally {
    clearTimeout(timer);
  }
}

async function run(name: string, dnsName: string, o: ResolveOptions): Promise<Bip353Outcome> {
  const proof = await fetchProof(name, o);
  if (proof === "absent") return { kind: "absent" };
  if (proof === "error") return { kind: "error" };
  try {
    const nowMs = (o.now ?? Date.now)();
    const verified = await verifyTxtProof(proof, dnsName, { nowSeconds: Math.floor(nowMs / 1000) });
    return { kind: "found", instruction: parsePaymentInstruction(verified.records), validUntil: verified.validUntil };
  } catch (e) {
    if (!(e instanceof Bip353Error)) return { kind: "error" };
    if (e.code === "no_record") return { kind: "absent" };
    if (e.code === "resolver") return { kind: "error" };
    return { kind: "invalid", code: e.code };
  }
}

export async function resolveBip353(name: string, o: ResolveOptions = {}): Promise<Bip353Outcome> {
  if (o.signal?.aborted) return { kind: "error" };
  let dnsName: string;
  try {
    dnsName = parseHumanName(name).dnsName;
  } catch {
    return { kind: "invalid", code: "malformed" };
  }
  const now = (o.now ?? Date.now)();
  const hit = cache.get(dnsName);
  if (hit && now - hit.at < CACHE_MS && (hit.outcome.kind !== "found" || hit.outcome.validUntil * 1000 > now)) return hit.outcome;

  let pending = inflight.get(dnsName);
  if (!pending) {
    pending = run(name, dnsName, o)
      .then((outcome) => {
        // Only definite answers are remembered; a transport error must not
        // stick, and an invalid one is re-checked on every attempt.
        if (outcome.kind === "found" || outcome.kind === "absent") {
          cache.delete(dnsName);
          cache.set(dnsName, { at: (o.now ?? Date.now)(), outcome });
          if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
        }
        return outcome;
      })
      .finally(() => inflight.delete(dnsName));
    inflight.set(dnsName, pending);
  }
  return pending;
}

export function clearBip353Cache(): void {
  cache.clear();
  inflight.clear();
}
