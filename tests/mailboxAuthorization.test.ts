// Regression coverage for 2026-09-21: verifyMailboxAuthorization() used to
// accept anything, because the Ark server reports a refused request as HTTP 200
// with an empty body and `grpc-status: 3` in the headers and readMailbox()
// reads that as "no messages". These tests pin the header-based behaviour.
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeMailboxAuthorization } from "../worker/mailbox";
import { verifyMailboxAuthorization } from "../worker/mailboxShared";

const ID = "02" + "ab".repeat(32);
const le64 = (n: number) => {
  let hex = "";
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) {
    hex += Number(v & 0xffn).toString(16).padStart(2, "0");
    v >>= 8n;
  }
  return hex;
};
const future = () => Math.floor(Date.now() / 1000) + 3600;
const AUTH = (expiry = future(), id = ID) => id + le64(expiry) + "cd".repeat(64);

function serverReplies(status: number, headers: Record<string, string> = {}, body = "") {
  const cancel = vi.fn(async () => {});
  const res = {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    body: { cancel },
  } as unknown as Response;
  void body;
  const fetchMock = vi.fn(async () => res);
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, cancel };
}

afterEach(() => vi.unstubAllGlobals());

describe("probeMailboxAuthorization", () => {
  it("refuses when the server signals an error in the headers, even on HTTP 200", async () => {
    serverReplies(200, { "grpc-status": "3", "grpc-message": "invalid mailbox authorization signature" });
    expect(await probeMailboxAuthorization("https://ark.example", ID, AUTH())).toBe(false);
  });

  it("refuses any non-zero gRPC status", async () => {
    for (const status of ["1", "2", "3", "7", "13", "16"]) {
      serverReplies(200, { "grpc-status": status });
      expect(await probeMailboxAuthorization("https://ark.example", ID, AUTH())).toBe(false);
    }
  });

  it("accepts a status of 0, or no status header at all (a streamed response keeps it in trailers)", async () => {
    serverReplies(200, { "grpc-status": "0" });
    expect(await probeMailboxAuthorization("https://ark.example", ID, AUTH())).toBe(true);
    serverReplies(200, {});
    expect(await probeMailboxAuthorization("https://ark.example", ID, AUTH())).toBe(true);
  });

  it("refuses on a non-2xx response and on a network error", async () => {
    serverReplies(503);
    expect(await probeMailboxAuthorization("https://ark.example", ID, AUTH())).toBe(false);
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(await probeMailboxAuthorization("https://ark.example", ID, AUTH())).toBe(false);
  });

  it("never downloads the mailbox: the body is cancelled, not read", async () => {
    const { cancel } = serverReplies(200, { "grpc-status": "0" });
    await probeMailboxAuthorization("https://ark.example", ID, AUTH());
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("verifyMailboxAuthorization", () => {
  it("does not reach the Ark server for input that cannot be valid", async () => {
    const { fetchMock } = serverReplies(200, {});
    expect(await verifyMailboxAuthorization("zz", "zz")).toBe(false);
    expect(await verifyMailboxAuthorization(ID, AUTH(future(), "03" + "ef".repeat(32)))).toBe(false); // other mailbox
    expect(await verifyMailboxAuthorization(ID, AUTH(Math.floor(Date.now() / 1000) - 10))).toBe(false); // expired
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses what the Ark server refuses, and accepts what it accepts", async () => {
    serverReplies(200, { "grpc-status": "3" });
    expect(await verifyMailboxAuthorization(ID, AUTH())).toBe(false);
    serverReplies(200, { "grpc-status": "0" });
    expect(await verifyMailboxAuthorization(ID, AUTH())).toBe(true);
  });
});
