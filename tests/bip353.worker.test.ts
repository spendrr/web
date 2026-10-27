import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleBip353, type Bip353Deps } from "../worker/bip353";
import { CLASS_IN, concat, decodeProof, encodeName, encodeRr, putU16, readName, type Rr } from "../src/lib/bip353/dnsWire";
import { verifyTxtProof } from "../src/lib/bip353/dnssec";
import { parsePaymentInstruction } from "../src/lib/bip353/instruction";

const fx = JSON.parse(readFileSync(new URL("./fixtures/bip353/matt_mattcorallo_com.json", import.meta.url), "utf8")) as {
  name: string;
  dnsName: string;
  capturedAt: number;
  proofB64: string;
};
const RRS = decodeProof(new Uint8Array(Buffer.from(fx.proofB64, "base64")));

// A DoH server that answers from the captured records, like a resolver would.
function dohFrom(rrs: Rr[], log: string[] = [], opts: { failPrimary?: boolean; failAll?: boolean; rcode?: number; servfailPrimary?: boolean; garbageFallback?: boolean } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    log.push(url);
    if (opts.failAll || (opts.failPrimary && url.includes("cloudflare"))) return new Response("boom", { status: 500 });
    if (opts.garbageFallback && url.includes("dns.google")) return new Response(new Uint8Array([1, 2, 3]) as BodyInit, { status: 200 });
    const q = new Uint8Array(init!.body as ArrayBuffer);
    const { name, next } = readName(q, 12);
    const type = (q[next]! << 8) | q[next + 1]!;
    const hits = rrs.filter((r) => r.name === name && (r.type === type || (r.type === 46 && ((r.rdata[0]! << 8) | r.rdata[1]!) === type)));
    const header = Uint8Array.from([0, 0, 0x81, 0x80 | (opts.servfailPrimary && url.includes("cloudflare") ? 2 : (opts.rcode ?? 0)), 0, 1, ...putU16(hits.length), 0, 0, 0, 0]);
    const question = concat([encodeName(name), Uint8Array.from([...putU16(type), ...putU16(CLASS_IN)])]);
    return new Response(concat([header, question, ...hits.map(encodeRr)]) as BodyInit, { status: 200 });
  }) as typeof fetch;
}

function deps(over: Partial<Bip353Deps> = {}, counter = { limited: 0 }): Bip353Deps {
  const store = new Map<string, Response>();
  return {
    ip: "203.0.113.7",
    limiter: {
      limit: async () => {
        counter.limited++;
        return { success: true };
      },
    },
    cache: {
      match: async (req) => store.get(req.url)?.clone(),
      put: async (req, res) => void store.set(req.url, res.clone()),
    },
    inFlight: new Map(),
    fetchImpl: dohFrom(RRS),
    ...over,
  };
}

const get = (n: string) => new Request(`https://spendrr.app/api/bip353?n=${encodeURIComponent(n)}`);

describe("GET /api/bip353", () => {
  it("returns a proof the app-side verifier accepts", async () => {
    const res = await handleBip353(get(fx.name), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { proof } = (await res.json()) as { proof: string };
    const v = await verifyTxtProof(new Uint8Array(Buffer.from(proof, "base64")), fx.dnsName, { nowSeconds: fx.capturedAt });
    expect(parsePaymentInstruction(v.records).offer).toMatch(/^lno1/);
  });

  it("fails over to the fallback resolver when the primary answers SERVFAIL", async () => {
    const log: string[] = [];
    const res = await handleBip353(get(fx.name), deps({ fetchImpl: dohFrom(RRS, log, { servfailPrimary: true }) }));
    expect(res.status).toBe(200);
    expect(log.some((u) => u.includes("dns.google"))).toBe(true);
  });

  it("maps garbage from the fallback to 502, not a cached 400", async () => {
    const res = await handleBip353(get(fx.name), deps({ fetchImpl: dohFrom(RRS, [], { failPrimary: true, garbageFallback: true }) }));
    expect(res.status).toBe(502);
  });

  it("answers repeats from the edge cache without the limiter or the resolver", async () => {
    const counter = { limited: 0 };
    const log: string[] = [];
    const d = deps({ fetchImpl: dohFrom(RRS, log) }, counter);
    await handleBip353(get(fx.name), d);
    const queries = log.length;
    expect(counter.limited).toBe(1);
    expect((await handleBip353(get(fx.name.toUpperCase()), d)).status).toBe(200);
    expect(counter.limited).toBe(1);
    expect(log.length).toBe(queries);
  });

  it("uses a bounded number of DoH queries", async () => {
    const log: string[] = [];
    await handleBip353(get(fx.name), deps({ fetchImpl: dohFrom(RRS, log) }));
    // TXT + DNSKEY per suffix + DS per non-root suffix, for a 7-label name.
    expect(log.length).toBeLessThanOrEqual(21);
  });

  it("falls back to the second resolver", async () => {
    const log: string[] = [];
    const res = await handleBip353(get(fx.name), deps({ fetchImpl: dohFrom(RRS, log, { failPrimary: true }) }));
    expect(res.status).toBe(200);
    expect(log.some((u) => u.includes("dns.google"))).toBe(true);
  });

  it("is 502 when every resolver fails, and does not leak upstream text", async () => {
    const res = await handleBip353(get(fx.name), deps({ fetchImpl: dohFrom(RRS, [], { failAll: true }) }));
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('{"error":"resolver"}');
  });

  it("is 502 on a resolver SERVFAIL", async () => {
    const res = await handleBip353(get(fx.name), deps({ fetchImpl: dohFrom(RRS, [], { rcode: 2 }) }));
    expect(res.status).toBe(502);
  });

  it("is 404 when the name has no TXT record", async () => {
    const res = await handleBip353(get("nobody@mattcorallo.com"), deps());
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('{"error":"no_record"}');
  });

  it("is 429 on a miss when the limiter refuses", async () => {
    const res = await handleBip353(get(fx.name), deps({ limiter: { limit: async () => ({ success: false }) } }));
    expect(res.status).toBe(429);
  });

  it("is 400 for bad input before touching the limiter or the resolver", async () => {
    const counter = { limited: 0 };
    const log: string[] = [];
    const d = deps({ fetchImpl: dohFrom(RRS, log) }, counter);
    for (const bad of ["", "alice", "a@localhost", "a@1.2.3.4", "a@x.com/evil", "a@".padEnd(400, "x")]) {
      const res = await handleBip353(get(bad), d);
      expect(res.status, bad).toBe(400);
    }
    expect((await handleBip353(new Request("https://spendrr.app/api/bip353"), d)).status).toBe(400);
    expect(counter.limited).toBe(0);
    expect(log.length).toBe(0);
  });

  it("rejects a name that is too deep for the subrequest budget", async () => {
    const res = await handleBip353(get("a@" + Array(11).fill("b").join(".") + ".com"), deps());
    expect(res.status).toBe(400);
  });
});
