// Every outbound call of the push/mailbox path carries a deadline, and a body
// that breaks after the headers arrived is a failed read, not an exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeMailboxAuthorization, readMailbox } from "../worker/mailbox";
import { UPSTREAM_TIMEOUT_MS, upstreamSignal } from "../worker/upstream";

const MAILBOX = "02" + "ab".repeat(32);
const AUTH = "cd".repeat(105);

afterEach(() => vi.unstubAllGlobals());

describe("upstream deadline", () => {
  it("readMailbox and probeMailboxAuthorization pass an abort signal to fetch", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(init.signal ?? undefined);
        return new Response(new Uint8Array(0), { status: 200 });
      }),
    );
    await readMailbox("https://ark.example", MAILBOX, AUTH, 0n);
    await probeMailboxAuthorization("https://ark.example", MAILBOX, AUTH);
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s).toBeInstanceOf(AbortSignal);
      expect(s!.aborted).toBe(false);
    }
  });

  it("a hanging server is cut off: readMailbox returns null when the signal fires", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
            // simulate the deadline firing
            setTimeout(() => (init.signal as unknown as { dispatchEvent: (e: Event) => void }).dispatchEvent(new Event("abort")), 5);
          }),
      ),
    );
    await expect(readMailbox("https://ark.example", MAILBOX, AUTH, 0n)).resolves.toBeNull();
  });

  it("a body that fails after the headers came in is a failed read, not a throw", async () => {
    const broken = new ReadableStream({
      pull(c) {
        c.error(new Error("connection reset"));
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(broken, { status: 200 })));
    await expect(readMailbox("https://ark.example", MAILBOX, AUTH, 0n)).resolves.toBeNull();
  });

  it("the deadline is a real, bounded number", () => {
    expect(UPSTREAM_TIMEOUT_MS).toBeGreaterThan(1000);
    expect(UPSTREAM_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(upstreamSignal().aborted).toBe(false);
  });
});
