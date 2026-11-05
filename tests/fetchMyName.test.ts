import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchMyName, releaseMyName } from "../src/lib/names/names";

// Every wallet here is its own object: the memory is kept per wallet.
const newWallet = () => ({ mailboxIdentifier: async () => "02aa", mailboxAuthorization: async () => "auth" }) as never;
const wallet = newWallet();
let calls: string[];
let mineName: string | null;

beforeEach(() => {
  calls = [];
  mineName = "pavel";
  vi.stubGlobal("fetch", async (path: string) => {
    calls.push(path);
    if (path === "/api/names/mine") {
      return mineName === null
        ? new Response(JSON.stringify({}), { status: 404 })
        : Response.json({ name: mineName, address: "ark1x", lnAddress: false });
    }
    return new Response(null, { status: 204 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("fetchMyName", () => {
  it("shares one read between callers asking at the same time, and remembers it for a minute", async () => {
    const [a, b] = await Promise.all([fetchMyName(wallet), fetchMyName(wallet)]);
    expect(a?.name).toBe("pavel");
    expect(b?.name).toBe("pavel");
    await fetchMyName(wallet);
    expect(calls.filter((c) => c === "/api/names/mine").length).toBe(1);
  });

  it("reads again after a write", async () => {
    const fresh = newWallet();
    await fetchMyName(fresh);
    mineName = null;
    expect((await releaseMyName(fresh)).ok).toBe(true);
    expect(await fetchMyName(fresh)).toBeNull();
    expect(calls.filter((c) => c === "/api/names/mine").length).toBe(2);
  });

  it("does not remember a failed read", async () => {
    const w = newWallet();
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    await expect(fetchMyName(w)).rejects.toThrow();
    mineName = "pavel";
    vi.stubGlobal("fetch", async () => Response.json({ name: "pavel", address: "ark1x" }));
    expect((await fetchMyName(w))?.name).toBe("pavel");
  });
});
