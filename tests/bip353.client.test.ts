import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { clearBip353Cache, resolveBip353 } from "../src/lib/bip353/client";
import { bip353Expired, bip353Target, pickBip353Method } from "../src/lib/send/bip353Destination";
import { parseHandleDestination } from "../src/lib/names/handle";

const fx = JSON.parse(readFileSync(new URL("./fixtures/bip353/matt_mattcorallo_com.json", import.meta.url), "utf8")) as {
  name: string;
  capturedAt: number;
  proofB64: string;
};
const at = fx.capturedAt * 1000;

const ok = (proofB64: string) => (async () => new Response(JSON.stringify({ proof: proofB64 }), { status: 200 })) as unknown as typeof fetch;
const status = (s: number) => (async () => new Response("{}", { status: s })) as unknown as typeof fetch;

beforeEach(() => clearBip353Cache());

describe("resolveBip353", () => {
  it("verifies the proof from the Worker and returns the record", async () => {
    const r = await resolveBip353(fx.name, { fetchImpl: ok(fx.proofB64), now: () => at });
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.instruction.offer).toMatch(/^lno1/);
  });

  it("a corrupted proof is invalid, never found", async () => {
    const bytes = Buffer.from(fx.proofB64, "base64");
    bytes[bytes.length - 40]! ^= 1;
    const r = await resolveBip353(fx.name, { fetchImpl: ok(bytes.toString("base64")), now: () => at });
    expect(r.kind).toBe("invalid");
  });

  it("an expired chain is invalid with the expired code", async () => {
    const r = await resolveBip353(fx.name, { fetchImpl: ok(fx.proofB64), now: () => at + 400 * 86400_000 });
    expect(r).toEqual({ kind: "invalid", code: "expired" });
  });

  it("a proof for another name does not validate for this one", async () => {
    const r = await resolveBip353("someone@mattcorallo.com", { fetchImpl: ok(fx.proofB64), now: () => at });
    expect(r.kind === "absent" || r.kind === "invalid").toBe(true);
  });

  it("maps 404 to absent and every other failure to error", async () => {
    expect((await resolveBip353(fx.name, { fetchImpl: status(404), now: () => at })).kind).toBe("absent");
    clearBip353Cache();
    for (const s of [429, 500, 502, 503]) {
      expect((await resolveBip353(fx.name, { fetchImpl: status(s), now: () => at })).kind).toBe("error");
    }
    expect((await resolveBip353(fx.name, { fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch, now: () => at })).kind).toBe("error");
    expect((await resolveBip353(fx.name, { fetchImpl: ok("!!!not base64!!!"), now: () => at })).kind).toBe("error");
  });

  it("remembers a definite answer briefly, not an error", async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(JSON.stringify({ proof: fx.proofB64 }), { status: 200 });
    }) as unknown as typeof fetch;
    await resolveBip353(fx.name, { fetchImpl: counting, now: () => at });
    await resolveBip353(fx.name, { fetchImpl: counting, now: () => at + 1000 });
    expect(calls).toBe(1);
    await resolveBip353(fx.name, { fetchImpl: counting, now: () => at + 60_000 });
    expect(calls).toBe(2);
  });

  it("one caller leaving does not fail another asking for the same name", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = (async () => {
      await gate;
      return new Response(JSON.stringify({ proof: fx.proofB64 }), { status: 200 });
    }) as unknown as typeof fetch;
    const first = new AbortController();
    const a = resolveBip353(fx.name, { fetchImpl: slow, signal: first.signal, now: () => at });
    const b = resolveBip353(fx.name, { fetchImpl: slow, now: () => at });
    first.abort();
    release();
    expect((await b).kind).toBe("found");
    await a;
  });

  it("a call that starts already aborted makes no request", async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch;
    const c = new AbortController();
    c.abort();
    expect((await resolveBip353(fx.name, { fetchImpl: f, signal: c.signal })).kind).toBe("error");
    expect(calls).toBe(0);
  });

  it("rejects a malformed name without a request", async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch;
    expect((await resolveBip353("nope", { fetchImpl: f })).kind).toBe("invalid");
    expect(calls).toBe(0);
  });
});

describe("bip353Target", () => {
  it("recognises user@domain and the ₿ form", () => {
    expect(bip353Target("Matt@MattCorallo.com", true)).toEqual({ name: "matt@mattcorallo.com", explicit: false });
    expect(bip353Target("₿matt@mattcorallo.com", false)).toEqual({ name: "matt@mattcorallo.com", explicit: true });
  });
  it("bare names are opt-in; the ₿ form always counts", () => {
    expect(bip353Target("matt@mattcorallo.com", false)).toBeNull();
  });
  it("the ₿ form of a spendrr.app name is a BIP 353 name, not an @handle", () => {
    expect(parseHandleDestination("\u20bfpavel@spendrr.app")).toBeNull();
    expect(bip353Target("\u20bfpavel@spendrr.app", false)).toEqual({ name: "pavel@spendrr.app", explicit: true });
  });
  it("leaves @names, Lightning URIs and junk alone", () => {
    for (const d of ["@pavel", "pavel@spendrr.app", "lightning:a@b.com", "ark1abc", "bc1qabc", "a@localhost", "", "a@b@c.com"]) {
      expect(bip353Target(d, true), d).toBeNull();
    }
  });
});

describe("pickBip353Method", () => {
  const yes = { arkAddress: async () => true, onchainAddress: async () => true };
  const no = { arkAddress: async () => false, onchainAddress: async () => false };
  const offer = "lno1" + "q".repeat(40);
  it("prefers Ark, then an offer, then on-chain", async () => {
    expect(await pickBip353Method({ offer, onchain: "bc1qx" }, yes)).toMatchObject({ kind: "lightning-offer" });
    expect(await pickBip353Method({ onchain: "bc1qx" }, yes)).toMatchObject({ kind: "onchain", destination: "bc1qx" });
  });
  it("skips a method that fails its check and tries the next", async () => {
    expect(await pickBip353Method({ ark: "ark1notvalid", offer }, yes)).toMatchObject({ kind: "lightning-offer" });
    expect(await pickBip353Method({ offer: "lno1BAD", onchain: "bc1qx" }, yes)).toMatchObject({ kind: "onchain" });
  });
  it("is null when nothing is payable, and ignores BOLT11 and silent payments", async () => {
    expect(await pickBip353Method({ bolt11: "lnbc1xyz" }, yes)).toBeNull();
    expect(await pickBip353Method({ onchain: "bc1qx" }, no)).toBeNull();
    expect(await pickBip353Method({}, yes)).toBeNull();
  });
  it("carries the amount of the record", async () => {
    expect(await pickBip353Method({ offer, amountSats: 1234 }, yes)).toMatchObject({ amountSats: 1234 });
  });
});

describe("bip353Expired", () => {
  it("expires at validUntil, not after", () => {
    expect(bip353Expired(100, 99_999)).toBe(false);
    expect(bip353Expired(100, 100_000)).toBe(true);
    expect(bip353Expired(100, 200_000)).toBe(true);
  });
});
