import { afterEach, describe, expect, it, vi } from "vitest";
import { isNetProbeRequest, runNetProbe } from "../src/lib/connectivity/netProbeWorker";

type Answer = Response | Error;

function stubFetch(mempool: Answer, ark: Answer) {
  const calls: Request[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(req);
    const a = new URL(req.url).host === "mempool.space" ? mempool : ark;
    if (a instanceof Error) throw a;
    return a;
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isNetProbeRequest", () => {
  it("accepts only the probe shape", () => {
    expect(isNetProbeRequest({ type: "netProbe", probeId: 3 })).toBe(true);
    expect(isNetProbeRequest({ type: "netProbe" })).toBe(false);
    expect(isNetProbeRequest({ type: "netProbe", probeId: "3" })).toBe(false);
    expect(isNetProbeRequest({ id: 1, type: "ensureWasm" })).toBe(false);
    expect(isNetProbeRequest(null)).toBe(false);
  });
});

describe("runNetProbe", () => {
  it("reports both reachable on healthy answers, and echoes the id", async () => {
    const calls = stubFetch(new Response("915234\n"), new Response(new Uint8Array(10), { status: 200 }));
    expect(await runNetProbe({ type: "netProbe", probeId: 7 })).toEqual({ netProbe: 7, mempool: true, ark: true });
    const ark = calls.find((c) => c.url.startsWith("https://ark.second.tech/"))!;
    expect(ark.method).toBe("POST");
    expect(ark.headers.get("content-type")).toBe("application/grpc-web+proto");
    expect(ark.url).toBe("https://ark.second.tech/bark_server.ArkService/GetArkInfo");
  });

  it("treats a network error as unreachable", async () => {
    stubFetch(new TypeError("Failed to fetch"), new TypeError("Failed to fetch"));
    expect(await runNetProbe({ type: "netProbe", probeId: 1 })).toEqual({ netProbe: 1, mempool: false, ark: false });
  });

  // A portal or proxy that does answer, with its own page.
  it("wants a block height from mempool, not just any 200", async () => {
    stubFetch(new Response("<html>login</html>"), new Response(""));
    expect((await runNetProbe({ type: "netProbe", probeId: 1 })).mempool).toBe(false);
  });

  it("reads envoy's unreachable-backend answers as Ark down", async () => {
    stubFetch(new Response("1"), new Response("", { status: 503 }));
    expect((await runNetProbe({ type: "netProbe", probeId: 1 })).ark).toBe(false);
    stubFetch(new Response("1"), new Response("", { status: 200, headers: { "grpc-status": "14" } }));
    expect((await runNetProbe({ type: "netProbe", probeId: 1 })).ark).toBe(false);
  });

  // The server refusing this particular call still proves it is there
  // (measured: a wrong method path gets grpc-status 12 from the backend).
  it("reads any other gRPC status as Ark reachable", async () => {
    stubFetch(new Response("1"), new Response("", { status: 200, headers: { "grpc-status": "12" } }));
    expect((await runNetProbe({ type: "netProbe", probeId: 1 })).ark).toBe(true);
  });
});
