// readBodyCapped must stop reading at the cap even when Content-Length is
// missing or forged; the old request.text() version buffered the whole body first.
import { describe, expect, it } from "vitest";
import { isCanonicalBase64, readBodyCapped } from "../worker/requestGuard";

function streamOf(chunks: Uint8Array[], onPull?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.();
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request("https://spendrr.app/x", { method: "POST", body, headers, duplex: "half" } as RequestInit);
}

describe("readBodyCapped", () => {
  it("returns the text of a body within the cap", async () => {
    const r = await readBodyCapped(post('{"a":"č"}'), 100);
    expect(r).toEqual({ ok: true, text: '{"a":"č"}' });
  });

  it("reads an empty body as empty text", async () => {
    const r = await readBodyCapped(new Request("https://spendrr.app/x", { method: "POST" }), 10);
    expect(r).toEqual({ ok: true, text: "" });
  });

  it("accepts exactly the cap and refuses one byte more", async () => {
    expect((await readBodyCapped(post("x".repeat(10)), 10)).ok).toBe(true);
    expect(await readBodyCapped(post("x".repeat(11)), 10)).toEqual({ ok: false, status: 413 });
  });

  it("refuses on a declared Content-Length over the cap without reading", async () => {
    let pulled = 0;
    const body = streamOf([new Uint8Array(5)], () => pulled++);
    const r = await readBodyCapped(post(body, { "Content-Length": "999" }), 10);
    expect(r).toEqual({ ok: false, status: 413 });
    // a ReadableStream pre-fills its queue once on construction; nothing beyond that
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("stops pulling once the cap is passed when Content-Length is absent or lies", async () => {
    let pulled = 0;
    const chunks = Array.from({ length: 1000 }, () => new Uint8Array(1024));
    const body = streamOf(chunks, () => pulled++);
    const r = await readBodyCapped(post(body, { "Content-Length": "1" }), 4096);
    expect(r).toEqual({ ok: false, status: 413 });
    expect(pulled).toBeLessThan(20);
  });

  it("counts bytes, not characters", async () => {
    // 4 x "č" is 8 bytes
    expect((await readBodyCapped(post("čččč"), 8)).ok).toBe(true);
    expect(await readBodyCapped(post("čččč"), 7)).toEqual({ ok: false, status: 413 });
  });

  it("decodes a multi-byte character split across chunks", async () => {
    const bytes = new TextEncoder().encode("č"); // 2 bytes
    const r = await readBodyCapped(post(streamOf([bytes.slice(0, 1), bytes.slice(1)])), 10);
    expect(r).toEqual({ ok: true, text: "č" });
  });

  it("reports a failing stream as 400", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error("boom"));
      },
    });
    expect(await readBodyCapped(post(body), 10)).toEqual({ ok: false, status: 400 });
  });
});

describe("isCanonicalBase64", () => {
  it("accepts everything btoa produces, for every length", () => {
    for (let n = 1; n <= 300; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + n) & 0xff);
      expect(isCanonicalBase64(btoa(String.fromCharCode(...bytes)))).toBe(true);
    }
  });

  it("refuses what the old regex refused", () => {
    for (const s of ["", "=AAA", "AA A", "AA\n", "AAA-", "é", "AAAA\n", "AA=A", " AAAA"]) {
      expect(isCanonicalBase64(s)).toBe(false);
    }
  });

  it("also refuses bad lengths and non-canonical padding", () => {
    for (const s of ["A", "AA", "AAA", "A===", "AA===", "AB=="]) {
      expect(isCanonicalBase64(s)).toBe(false);
    }
  });

  it("handles a 15 MB payload", () => {
    const s = btoa("x".repeat(11 * 1024 * 1024));
    expect(isCanonicalBase64(s)).toBe(true);
    expect(isCanonicalBase64(s.slice(0, -1) + "!")).toBe(false);
  });
});

describe("readBodyCapped memory shape", () => {
  it("reads a 20 MB body in one go and returns it intact", async () => {
    const big = "a".repeat(20 * 1024 * 1024);
    const r = await readBodyCapped(post(big), 21 * 1024 * 1024);
    expect(r.ok).toBe(true);
    expect(r.ok && r.text.length).toBe(big.length);
  });
});
