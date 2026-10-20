import { afterEach, describe, expect, it, vi } from "vitest";
import type { WalletClient } from "../src/lib/wallet/bark";
import { cachedLookup, fetchMyName, lookupName, releaseMyName, saveName, setMyLnAddress } from "../src/lib/names/names";

const wallet = {
  mailboxIdentifier: async () => "02" + "aa".repeat(32),
  mailboxAuthorization: async () => "02" + "aa".repeat(32) + "00".repeat(8) + "bb".repeat(64),
} as unknown as WalletClient;

function respond(status: number, body?: unknown) {
  const fetchMock = vi.fn(async () =>
    status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("lookupName", () => {
  it("returns the address for a name that resolves", async () => {
    const f = respond(200, { name: "pavel", address: "ark1x" });
    expect(await lookupName("pavel")).toEqual({ kind: "found", name: "pavel", address: "ark1x", lnAddress: false });
    expect(f.mock.calls[0][0]).toBe("/api/names/pavel");
  });

  it("shares one request between concurrent lookups of the same name", async () => {
    const f = respond(200, { name: "sharedx", address: "ark1x" });
    const [a, b] = await Promise.all([lookupName("sharedx"), lookupName("sharedx")]);
    expect(a).toEqual(b);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("keeps a shared request alive when only one caller aborts", async () => {
    const f = respond(200, { name: "abortx", address: "ark1x" });
    const gone = new AbortController();
    const first = lookupName("abortx", gone.signal);
    const second = lookupName("abortx");
    gone.abort();
    expect(await second).toMatchObject({ kind: "found", name: "abortx" });
    await first;
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("encodes the name into the path", async () => {
    // Not a name the registry could hold, so it never gets that far (below);
    // the encoding is what protects the path for anything that does.
    const f = respond(404, { status: "free" });
    await lookupName("pa-vel_1");
    expect(f.mock.calls[0][0]).toBe("/api/names/pa-vel_1");
  });

  it("answers a syntactically invalid name locally, without a request", async () => {
    const f = respond(200, { name: "pavel", address: "ark1x" });
    for (const bad of ["x", "pa", "pavél", "a/b?c", "-ab", "ab-", "a".repeat(21), "has space", ""]) {
      expect(await lookupName(bad)).toEqual({ kind: "absent", status: "invalid" });
    }
    expect(f).not.toHaveBeenCalled();
    // reserved is the registry's call (it can have an owner): still asked
    respond(200, { name: "spendrr", address: "ark1x" });
    expect(await lookupName("spendrr")).toMatchObject({ kind: "found", name: "spendrr" });
  });

  it("does not take an answer for another name as this one's", async () => {
    respond(200, { name: "eva", address: "ark1x" });
    expect(await lookupName("pavel")).toEqual({ kind: "error" });
    respond(200, { name: "pavel", address: "ark1x" });
    expect(await lookupName("@PAVEL")).toMatchObject({ kind: "found", name: "pavel" });
  });

  it("gives up on a request that never answers, and on an already aborted one", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
      );
      const pending = lookupName("pavel");
      await vi.advanceTimersByTimeAsync(9_000);
      expect(await pending).toEqual({ kind: "error" });
      const done = new AbortController();
      done.abort();
      expect(await lookupName("pavel", done.signal)).toEqual({ kind: "error" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the request when the caller's signal aborts", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const c = new AbortController();
    const pending = lookupName("pavel", c.signal);
    c.abort();
    expect(await pending).toEqual({ kind: "error" });
  });

  it("tells free, quarantined, reserved and invalid apart", async () => {
    for (const status of ["free", "quarantined", "reserved", "invalid"]) {
      respond(404, { status });
      expect(await lookupName("pavel")).toEqual({ kind: "absent", status });
    }
  });

  it("never reads a broken or unexpected answer as free", async () => {
    for (const [status, body] of [
      [200, { name: "pavel" }],
      [200, "nope"],
      [404, { status: "banana" }],
      [404, null],
      [429, { error: "Rate limit exceeded." }],
      [502, { error: "x" }],
    ] as const) {
      respond(status, body);
      expect(await lookupName("pavel")).toEqual({ kind: "error" });
    }
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(await lookupName("pavel")).toEqual({ kind: "error" });
  });
});

describe("saveName", () => {
  it("sends the mailbox proof, name and address, and returns what the server stored", async () => {
    const f = respond(200, { name: "pavel", address: "ark1x", action: "claimed" });
    expect(await saveName(wallet, "pavel", "ark1x")).toEqual({ ok: true, name: "pavel", address: "ark1x", action: "claimed" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/names/set");
    expect(JSON.parse(init.body as string)).toMatchObject({ name: "pavel", address: "ark1x", mailboxId: expect.any(String) });
  });

  it("maps each server refusal to its own error", async () => {
    const cases: [number, unknown, string][] = [
      [409, { error: "taken" }, "taken"],
      [409, { error: "quarantined" }, "quarantined"],
      [429, { error: "rate-limited" }, "rate-limited"],
      [429, { error: "Rate limit exceeded." }, "throttled"],
      [403, { error: "Invalid mailbox authorization." }, "auth"],
      [403, { error: "banned" }, "banned"],
      [403, { error: "clock" }, "clock"],
      [400, { error: "Reserved name." }, "reserved"],
      [400, { error: "reserved" }, "reserved"],
      [400, { error: "Invalid address." }, "bad-address"],
      [400, { error: "Invalid name." }, "invalid"],
      [500, null, "network"],
    ];
    for (const [status, body, expected] of cases) {
      respond(status, body);
      expect(await saveName(wallet, "x", "y")).toEqual({ ok: false, error: expected });
    }
  });

  it("reports a network failure instead of throwing", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(await saveName(wallet, "x", "y")).toEqual({ ok: false, error: "network" });
  });

  it("does not report success on a 200 that lacks the stored name", async () => {
    respond(200, {});
    expect(await saveName(wallet, "x", "y")).toEqual({ ok: false, error: "network" });
  });
});

describe("fetchMyName", () => {
  it("returns the name, or null for a wallet with none", async () => {
    respond(200, { name: "pavel", address: "ark1x" });
    expect(await fetchMyName(wallet)).toEqual({ name: "pavel", address: "ark1x", lnAddress: false });
    respond(404, { error: "No name." });
    expect(await fetchMyName(wallet)).toBeNull();
  });

  it("throws when it cannot tell, so a failure is never read as 'no name'", async () => {
    for (const status of [403, 429, 500, 502]) {
      respond(status, { error: "x" });
      await expect(fetchMyName(wallet)).rejects.toThrow();
    }
  });
});

describe("setMyLnAddress", () => {
  it("sends the mailbox proof and the wanted state, and returns what the server set", async () => {
    const f = respond(200, { lnAddress: true });
    expect(await setMyLnAddress(wallet, true)).toEqual({ ok: true, lnAddress: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/names/ln");
    expect(JSON.parse(init.body as string)).toMatchObject({ enabled: true, mailboxId: expect.any(String) });
  });

  it("reports a refusal", async () => {
    respond(404, { error: "no-name" });
    expect(await setMyLnAddress(wallet, true)).toEqual({ ok: false, error: "network" });
  });
});

describe("releaseMyName", () => {
  it("treats released and already-gone the same", async () => {
    respond(204);
    expect(await releaseMyName(wallet)).toEqual({ ok: true });
    respond(404, { error: "not-found" });
    expect(await releaseMyName(wallet)).toEqual({ ok: true });
  });

  it("reports a refusal", async () => {
    respond(429, { error: "rate-limited" });
    expect(await releaseMyName(wallet)).toEqual({ ok: false, error: "rate-limited" });
  });
});

describe("cachedLookup", () => {
  it("remembers definite answers briefly, never an error", async () => {
    respond(200, { name: "cache-a", address: "ark1x" });
    await lookupName("cache-a");
    expect(cachedLookup("cache-a")).toEqual({ kind: "found", name: "cache-a", address: "ark1x", lnAddress: false });
    expect(cachedLookup("cache-a", Date.now() + 31_000)).toBeNull();

    respond(404, { status: "free" });
    await lookupName("cache-b");
    expect(cachedLookup("cache-b")).toEqual({ kind: "absent", status: "free" });

    respond(500, {});
    await lookupName("cache-c");
    expect(cachedLookup("cache-c")).toBeNull();
  });
});
