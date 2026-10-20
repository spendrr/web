import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOOK_MAX_SKEW_S,
  hookSignature,
  relayHealthy,
  relayRegister,
  relayUnregister,
  resetRelayHealthForTests,
  SWEEP_INTERVAL_MS,
  verifyHook,
} from "../worker/pushRelay";

const SECRET = "hook-secret";
const ENV = {
  PUSH_RELAY_URL: "https://relay.internal",
  PUSH_RELAY_TOKEN: "t",
  PUSH_RELAY_HOOK_SECRET: SECRET,
  CF_ACCESS_CLIENT_ID: "id",
  CF_ACCESS_CLIENT_SECRET: "s",
};
const ID = "02" + "ab".repeat(32);
const AUTH = "cd".repeat(105);

afterEach(() => {
  vi.unstubAllGlobals();
  resetRelayHealthForTests();
});

describe("relay pokes", () => {
  const now = 1_800_000_000;
  const signed = async (body: string, ts = String(now)) => [ts, await hookSignature(SECRET, ts, body)] as const;

  const poke = (ids: unknown, shard = "shard-3") => JSON.stringify({ shards: { [shard]: ids } });

  it("accepts a signed, fresh poke and dedupes its ids", async () => {
    const body = poke([ID, ID]);
    const [ts, sig] = await signed(body);
    expect(await verifyHook(ENV, ts, sig, body, now)).toEqual(new Map([["shard-3", [ID]]]));
  });

  it("refuses a wrong signature, a changed body, an old poke and no secret", async () => {
    const body = poke([ID]);
    const [ts, sig] = await signed(body);
    expect(await verifyHook(ENV, ts, sig.replace(/.$/, sig.endsWith("0") ? "1" : "0"), body, now)).toBeNull();
    expect(await verifyHook(ENV, ts, sig, poke([ID.replace("ab", "ac")]), now)).toBeNull();
    expect(await verifyHook(ENV, ts, sig, body, now + HOOK_MAX_SKEW_S + 1)).toBeNull();
    expect(await verifyHook({ ...ENV, PUSH_RELAY_HOOK_SECRET: undefined }, ts, sig, body, now)).toBeNull();
    expect(await verifyHook(ENV, null, sig, body, now)).toBeNull();
  });

  it("refuses malformed ids and shards even when signed", async () => {
    const bodies = [
      ...[[], ["nothex"], [ID.toUpperCase()], Array(501).fill(ID), "x"].map((ids) => poke(ids)),
      poke([ID], "other"),
      JSON.stringify({ shards: {} }),
      JSON.stringify({ shards: [[ID]] }),
      JSON.stringify({ ids: [ID] }),
      JSON.stringify({ shards: { "shard-1": Array(300).fill(ID), "shard-2": Array(201).fill(ID) } }),
    ];
    for (const body of bodies) {
      const [ts, sig] = await signed(body);
      expect(await verifyHook(ENV, ts, sig, body, now)).toBeNull();
    }
  });
});

describe("relay health", () => {
  beforeEach(() => resetRelayHealthForTests());

  it("is healthy only when up and warm, and asks once a minute", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, warm: true })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await relayHealthy(ENV, 0)).toBe(true);
    expect(await relayHealthy(ENV, 30_000)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer t");
    expect(headers["CF-Access-Client-Id"]).toBe("id");
  });

  it("treats a cold relay, an error and no config as not healthy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, warm: false }))));
    expect(await relayHealthy(ENV, 0)).toBe(false);
    resetRelayHealthForTests();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    expect(await relayHealthy(ENV, 0)).toBe(false);
    resetRelayHealthForTests();
    expect(await relayHealthy({}, 0)).toBe(false);
  });

  it("sweeps every 15 minutes whatever the relay's state", () => {
    expect(SWEEP_INTERVAL_MS).toBe(15 * 60_000);
  });
});

describe("relay registration", () => {
  it("sends well-formed registrations and nothing without config", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await relayRegister(ENV, ID, AUTH, "42", "shard-7")).toBe(true);
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ mailboxId: ID, authorization: AUTH, checkpoint: "42", shard: "shard-7" });
    expect(await relayRegister(ENV, "bad", AUTH, "42", "shard-7")).toBe(false);
    expect(await relayRegister(ENV, ID, AUTH, "42", "bad")).toBe(false);
    expect(await relayRegister({}, ID, AUTH, "42", "shard-7")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await relayUnregister(ENV, ID, "shard-7");
    await relayUnregister(ENV, ID, undefined);
    const bodies = fetchMock.mock.calls.slice(1).map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string));
    expect(bodies).toEqual([{ mailboxId: ID, shard: "shard-7" }, { mailboxId: ID }]);
  });
});
