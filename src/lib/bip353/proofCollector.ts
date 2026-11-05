// Builds the proof the verifier checks: for every name on the path from the
// root to the target, its DNSKEY and DS RRsets, plus the target's TXT, each
// with RRSIGs. Runs in the Worker (DoH upstream) and in the fixture capture.
//
// Nothing here is trusted and nothing is verified: it only gathers. All
// checking is in dnssec.ts, so a lying resolver or Worker yields a proof that
// fails, never a payment to the wrong place.
import { Bip353Error } from "./errors";
import { CLASS_IN, MAX_PROOF_BYTES, TYPE_DNSKEY, TYPE_DS, TYPE_RRSIG, TYPE_TXT, buildQuery, encodeProof, labelsOf, nameFromLabels, parseResponse, type Rr } from "./dnsWire";

// Wire query in, wire response out (one DoH round trip).
export type DnsQuery = (query: Uint8Array) => Promise<Uint8Array>;

const DEFAULT_MAX_LABELS = 12;

function answerOf(res: Uint8Array, name: string, type: number): Rr[] {
  // Bytes a resolver sent that are not a DNS message are the resolver failing,
  // not a malformed name (which would be a cached 400 for the caller).
  let msg: ReturnType<typeof parseResponse>;
  try {
    msg = parseResponse(res);
  } catch (e) {
    throw new Bip353Error("resolver", `bad response${e instanceof Error ? `: ${e.message}` : ""}`);
  }
  // NOERROR and NXDOMAIN are answers; anything else is the resolver failing.
  if (msg.rcode !== 0 && msg.rcode !== 3) throw new Bip353Error("resolver", `rcode ${msg.rcode}`);
  if (msg.truncated) throw new Bip353Error("resolver", "truncated");
  const out: Rr[] = [];
  for (const rr of msg.answers) {
    if (rr.name !== name || rr.class !== CLASS_IN) continue;
    if (rr.type === type) out.push(rr);
    else if (rr.type === TYPE_RRSIG && rr.rdata.length >= 2 && ((rr.rdata[0]! << 8) | rr.rdata[1]!) === type) out.push(rr);
  }
  return out;
}

export async function collectProof(target: string, query: DnsQuery, maxLabels: number = DEFAULT_MAX_LABELS): Promise<Uint8Array> {
  const labels = labelsOf(target);
  if (labels.length > maxLabels) throw new Bip353Error("malformed", "name too deep");
  const suffixes: string[] = [];
  for (let i = 0; i <= labels.length; i++) suffixes.push(nameFromLabels(labels.slice(i)));
  suffixes.reverse();
  // suffixes: ".", "com.", "example.com.", ..., target

  const jobs: Array<Promise<Rr[]>> = [];
  const ask = (name: string, type: number) =>
    jobs.push(
      query(buildQuery(name, type)).then(
        (res) => answerOf(res, name, type),
        (e) => {
          if (e instanceof Bip353Error) throw e;
          throw new Bip353Error("resolver", `query failed: ${e instanceof Error ? e.message : String(e)}${e instanceof Error && e.cause ? ` (${String((e.cause as { code?: string }).code ?? e.cause)})` : ""}`);
        },
      ),
    );
  ask(target, TYPE_TXT);
  for (const s of suffixes) {
    ask(s, TYPE_DNSKEY);
    if (s !== ".") ask(s, TYPE_DS);
  }
  const rrs = (await Promise.all(jobs)).flat();
  const proof = encodeProof(rrs);
  if (proof.length > MAX_PROOF_BYTES) throw new Bip353Error("malformed", "proof too large");
  return proof;
}
