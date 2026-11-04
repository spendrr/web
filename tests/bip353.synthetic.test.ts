// Chains built with our own throwaway keys and a custom trust anchor, so every
// algorithm and every failure shape is covered without relying on live DNS.
// The signer here is written independently of src/lib/bip353/dnssec.ts.
import { describe, expect, it } from "vitest";
import { CLASS_IN, TYPE_DNSKEY, TYPE_DS, TYPE_RRSIG, TYPE_TXT, concat, encodeName, encodeProof, labelCount, putU16, putU32, type Rr } from "../src/lib/bip353/dnsWire";
import { keyTagOf, verifyTxtProof } from "../src/lib/bip353/dnssec";
import { Bip353Error } from "../src/lib/bip353/errors";
import type { TrustAnchor } from "../src/lib/bip353/trustAnchors";

const subtle = globalThis.crypto.subtle;
const NOW = 1_800_000_000;
const TARGET = "alice.user._bitcoin-payment.example.com.";

interface Key {
  alg: number;
  dnskey: Uint8Array;
  tag: number;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

const b64uToBytes = (s: string) => new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));

async function makeKey(alg: number, flags = 257): Promise<Key> {
  let pub: Uint8Array;
  let sign: (d: Uint8Array) => Promise<Uint8Array>;
  if (alg === 13 || alg === 14) {
    const curve = alg === 13 ? "P-256" : "P-384";
    const hash = alg === 13 ? "SHA-256" : "SHA-384";
    const kp = (await subtle.generateKey({ name: "ECDSA", namedCurve: curve }, true, ["sign", "verify"])) as CryptoKeyPair;
    pub = new Uint8Array(await subtle.exportKey("raw", kp.publicKey)).slice(1);
    sign = async (d) => new Uint8Array(await subtle.sign({ name: "ECDSA", hash }, kp.privateKey, d as BufferSource));
  } else if (alg === 15) {
    const kp = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    pub = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
    sign = async (d) => new Uint8Array(await subtle.sign({ name: "Ed25519" }, kp.privateKey, d as BufferSource));
  } else {
    const hash = alg === 8 ? "SHA-256" : "SHA-512";
    const kp = (await subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = await subtle.exportKey("jwk", kp.publicKey);
    const e = b64uToBytes(jwk.e!);
    const n = b64uToBytes(jwk.n!);
    pub = concat([Uint8Array.from([e.length]), e, n]);
    sign = async (d) => new Uint8Array(await subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, kp.privateKey, d as BufferSource));
  }
  const dnskey = concat([Uint8Array.from([...putU16(flags), 3, alg]), pub]);
  return { alg, dnskey, tag: keyTagOf(dnskey), sign };
}

const rr = (name: string, type: number, rdata: Uint8Array): Rr => ({ name, type, class: CLASS_IN, ttl: 300, rdata });

const cmp = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b));

async function rrsig(set: Rr[], signer: string, key: Key, o: { inception?: number; expiration?: number; labels?: number; alg?: number; keyTag?: number } = {}): Promise<Rr> {
  const first = set[0]!;
  const head = concat([
    Uint8Array.from([...putU16(first.type), o.alg ?? key.alg, o.labels ?? labelCount(first.name), ...putU32(300), ...putU32(o.expiration ?? NOW + 86400), ...putU32(o.inception ?? NOW - 86400), ...putU16(o.keyTag ?? key.tag)]),
    encodeName(signer),
  ]);
  // RFC 4034 6.3: canonical order, identical records counted once.
  const sorted = [...set].sort((a, b) => cmp(a.rdata, b.rdata)).filter((r, i, all) => i === 0 || cmp(all[i - 1]!.rdata, r.rdata) !== 0);
  const data = concat([head, ...sorted.map((r) => concat([encodeName(r.name), Uint8Array.from([...putU16(r.type), ...putU16(r.class), ...putU32(300), ...putU16(r.rdata.length)]), r.rdata]))]);
  const sig = await key.sign(data);
  return rr(first.name, TYPE_RRSIG, concat([head, sig]));
}

async function dsOf(owner: string, key: Key): Promise<Uint8Array> {
  const d = new Uint8Array(await subtle.digest("SHA-256", concat([encodeName(owner), key.dnskey]) as BufferSource));
  return concat([Uint8Array.from([...putU16(key.tag), key.alg, 2]), d]);
}

const txtRdata = (s: string) => {
  const b = new TextEncoder().encode(s);
  return concat([Uint8Array.from([b.length]), b]);
};

interface Built {
  rrs: Rr[];
  anchors: TrustAnchor[];
  keys: { root: Key; com: Key; ex: Key };
}

async function build(algs: { root: number; com: number; ex: number } = { root: 13, com: 13, ex: 13 }): Promise<Built> {
  const root = await makeKey(algs.root);
  const com = await makeKey(algs.com);
  const ex = await makeKey(algs.ex);
  const rootDnskey = rr(".", TYPE_DNSKEY, root.dnskey);
  const comDnskey = rr("com.", TYPE_DNSKEY, com.dnskey);
  const exDnskey = rr("example.com.", TYPE_DNSKEY, ex.dnskey);
  const comDs = rr("com.", TYPE_DS, await dsOf("com.", com));
  const exDs = rr("example.com.", TYPE_DS, await dsOf("example.com.", ex));
  const txt = rr(TARGET, TYPE_TXT, txtRdata("bitcoin:?lno=lno1abc"));
  const rrs = [
    rootDnskey,
    await rrsig([rootDnskey], ".", root),
    comDs,
    await rrsig([comDs], ".", root),
    comDnskey,
    await rrsig([comDnskey], "com.", com),
    exDs,
    await rrsig([exDs], "com.", com),
    exDnskey,
    await rrsig([exDnskey], "example.com.", ex),
    txt,
    await rrsig([txt], "example.com.", ex),
  ];
  const d = await dsOf(".", root);
  const anchors: TrustAnchor[] = [{ keyTag: root.tag, algorithm: root.alg, digestType: 2, digestHex: Buffer.from(d.slice(4)).toString("hex") }];
  return { rrs, anchors, keys: { root, com, ex } };
}

async function run(b: Built, rrs = b.rrs, now = NOW): Promise<string> {
  try {
    const r = await verifyTxtProof(encodeProof(rrs), TARGET, { nowSeconds: now, anchors: b.anchors });
    return r.records.join("|");
  } catch (e) {
    return e instanceof Bip353Error ? `err:${e.code}` : `other:${String(e)}`;
  }
}

describe("synthetic chains", () => {
  it("accepts each supported algorithm at every level", async () => {
    for (const alg of [8, 10, 13, 14, 15]) {
      const b = await build({ root: alg, com: alg, ex: alg });
      expect(await run(b), `alg ${alg}`).toBe("bitcoin:?lno=lno1abc");
    }
  });

  it("accepts mixed algorithms", async () => {
    const b = await build({ root: 8, com: 13, ex: 15 });
    expect(await run(b)).toBe("bitcoin:?lno=lno1abc");
  });

  it("joins multiple character-strings of one record", async () => {
    const b = await build();
    const i = b.rrs.findIndex((r) => r.type === TYPE_TXT);
    const rdata = concat([txtRdata("bitcoin:?lno="), txtRdata("lno1abc")]);
    const txt = rr(TARGET, TYPE_TXT, rdata);
    const rrs = [...b.rrs];
    rrs[i] = txt;
    rrs[i + 1] = await rrsig([txt], "example.com.", b.keys.ex);
    expect(await run(b, rrs)).toBe("bitcoin:?lno=lno1abc");
  });

  it("window edges are inclusive", async () => {
    const b = await build();
    expect(await run(b, b.rrs, NOW - 86400)).not.toMatch(/^err/);
    expect(await run(b, b.rrs, NOW + 86400)).not.toMatch(/^err/);
    expect(await run(b, b.rrs, NOW + 86401)).toBe("err:expired");
    expect(await run(b, b.rrs, NOW - 86401)).toBe("err:expired");
  });

  it("refuses a TXT RRset with an injected extra record", async () => {
    const b = await build();
    const rrs = [...b.rrs, rr(TARGET, TYPE_TXT, txtRdata("bitcoin:?lno=lno1evil"))];
    expect(await run(b, rrs)).toMatch(/^err:/);
  });

  it("refuses a swapped TXT under the genuine signature", async () => {
    const b = await build();
    const rrs = b.rrs.map((r) => (r.type === TYPE_TXT ? rr(TARGET, TYPE_TXT, txtRdata("bitcoin:?lno=lno1evil")) : r));
    expect(await run(b, rrs)).toBe("err:untrusted");
  });

  it("refuses a DS signed by the child instead of the parent", async () => {
    const b = await build();
    const i = b.rrs.findIndex((r) => r.type === TYPE_DS && r.name === "example.com.");
    const ds = b.rrs[i]!;
    const rrs = [...b.rrs];
    rrs[i + 1] = await rrsig([ds], "com.", b.keys.ex);
    expect(await run(b, rrs)).toBe("err:untrusted");
  });

  it("refuses an attacker zone with its own self-consistent chain under another trust anchor", async () => {
    const real = await build();
    const evil = await build();
    expect(await run({ ...evil, anchors: real.anchors })).toBe("err:untrusted");
  });

  it("refuses a signature naming a key tag that is not in the DNSKEY set", async () => {
    const b = await build();
    const i = b.rrs.findIndex((r) => r.type === TYPE_TXT);
    const txt = b.rrs[i]!;
    const rrs = [...b.rrs];
    rrs[i + 1] = await rrsig([txt], "example.com.", b.keys.ex, { keyTag: (b.keys.ex.tag + 1) & 0xffff });
    expect(await run(b, rrs)).toBe("err:untrusted");
  });

  it("refuses a wildcard-expanded answer", async () => {
    const b = await build();
    const i = b.rrs.findIndex((r) => r.type === TYPE_TXT);
    const rrs = [...b.rrs];
    rrs[i + 1] = await rrsig([b.rrs[i]!], "example.com.", b.keys.ex, { labels: labelCount(TARGET) - 1 });
    expect(await run(b, rrs)).toBe("err:untrusted");
  });

  it("refuses SHA-1 algorithms", async () => {
    const b = await build();
    const i = b.rrs.findIndex((r) => r.type === TYPE_TXT);
    const rrs = [...b.rrs];
    rrs[i + 1] = await rrsig([b.rrs[i]!], "example.com.", b.keys.ex, { alg: 7 });
    expect(await run(b, rrs)).toBe("err:unsupported");
  });

  it("refuses a revoked key even when it matches the DS", async () => {
    const root = await makeKey(13, 257 | 0x80);
    const b = await build();
    const rootDnskey = rr(".", TYPE_DNSKEY, root.dnskey);
    const rrs = b.rrs.map((r) => r);
    rrs[0] = rootDnskey;
    rrs[1] = await rrsig([rootDnskey], ".", root);
    const d = await dsOf(".", root);
    const anchors = [{ keyTag: root.tag, algorithm: 13, digestType: 2, digestHex: Buffer.from(d.slice(4)).toString("hex") }];
    expect(await run({ ...b, anchors }, rrs)).toBe("err:untrusted");
  });

  it("refuses a key without the zone-key flag", async () => {
    const b = await build();
    const ex = await makeKey(13, 256 ^ 0x100);
    const exDnskey = rr("example.com.", TYPE_DNSKEY, ex.dnskey);
    const exDs = rr("example.com.", TYPE_DS, await dsOf("example.com.", ex));
    const txt = rr(TARGET, TYPE_TXT, txtRdata("bitcoin:?lno=lno1abc"));
    const rrs = b.rrs.filter((r) => !(r.name === "example.com." || r.name === TARGET));
    rrs.push(exDs, await rrsig([exDs], "com.", b.keys.com), exDnskey, await rrsig([exDnskey], "example.com.", ex), txt, await rrsig([txt], "example.com.", ex));
    expect(await run(b, rrs)).toBe("err:untrusted");
  });

  it("refuses a DS digest of an unsupported type (SHA-1)", async () => {
    const b = await build();
    const i = b.rrs.findIndex((r) => r.type === TYPE_DS && r.name === "example.com.");
    const ds = b.rrs[i]!;
    const bad = rr(ds.name, TYPE_DS, concat([ds.rdata.slice(0, 3), Uint8Array.from([1]), ds.rdata.slice(4, 24)]));
    const rrs = [...b.rrs];
    rrs[i] = bad;
    rrs[i + 1] = await rrsig([bad], "com.", b.keys.com);
    expect(await run(b, rrs)).toBe("err:untrusted");
  });

  it("works when a sub-zone sits between the domain and the target (extra delegation)", async () => {
    const b = await build();
    const sub = "_bitcoin-payment.example.com.";
    const subKey = await makeKey(13);
    const subDnskey = rr(sub, TYPE_DNSKEY, subKey.dnskey);
    const subDs = rr(sub, TYPE_DS, await dsOf(sub, subKey));
    const txt = rr(TARGET, TYPE_TXT, txtRdata("bitcoin:?lno=lno1deep"));
    const rrs = b.rrs.filter((r) => r.name !== TARGET);
    rrs.push(subDs, await rrsig([subDs], "example.com.", b.keys.ex), subDnskey, await rrsig([subDnskey], sub, subKey), txt, await rrsig([txt], sub, subKey));
    expect(await run(b, rrs)).toBe("bitcoin:?lno=lno1deep");
  });

  async function withTxt(b: Built, extra: Rr[]): Promise<Rr[]> {
    const rrs = b.rrs.filter((r) => !(r.name === TARGET));
    const set = [rr(TARGET, TYPE_TXT, txtRdata("bitcoin:?lno=lno1abc")), ...extra];
    return [...rrs, ...set, await rrsig(set, "example.com.", b.keys.ex)];
  }

  it("ignores a TXT record that is not text next to the real one", async () => {
    const b = await build();
    const binary = rr(TARGET, TYPE_TXT, Uint8Array.from([3, 0xff, 0xfe, 0xfd]));
    expect(await run(b, await withTxt(b, [binary]))).toBe("bitcoin:?lno=lno1abc");
  });

  it("counts identical TXT records once", async () => {
    const b = await build();
    const dup = rr(TARGET, TYPE_TXT, txtRdata("bitcoin:?lno=lno1abc"));
    expect(await run(b, await withTxt(b, [dup]))).toBe("bitcoin:?lno=lno1abc");
  });

  it("a TXT in an unsigned zone is refused, not 'no record'", async () => {
    const b = await build();
    const rrs = b.rrs.filter((r) => !(r.type === TYPE_RRSIG && r.name === TARGET));
    expect(await run(b, rrs)).toBe("err:untrusted");
  });

  it("returns the earliest expiry along the chain", async () => {
    const b = await build();
    const i = b.rrs.findIndex((r) => r.type === TYPE_DNSKEY && r.name === "com.");
    const rrs = [...b.rrs];
    rrs[i + 1] = await rrsig([b.rrs[i]!], "com.", b.keys.com, { expiration: NOW + 100 });
    const r = await verifyTxtProof(encodeProof(rrs), TARGET, { nowSeconds: NOW, anchors: b.anchors });
    expect(r.validUntil).toBe(NOW + 100);
  });
});
