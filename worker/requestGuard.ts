// Request-body reading shared by the handlers in index.ts.
// Lives in its own module because index.ts may export nothing but the default
// handler and the Durable Object classes (see priceCache.ts's header).

export type BodyResult = { ok: true; text: string } | { ok: false; status: 400 | 413 };

class BodyTooLarge extends Error {}

// Reads a request body as UTF-8 text and stops at maxBytes. The old version
// awaited request.text() and compared afterwards, so a body with no or a
// forged Content-Length (chunked) was fully buffered before the check ran:
// the cap bounded what we accepted, not what we paid to receive. Here the
// stream is cancelled as soon as the running byte count passes the cap.
export async function readBodyCapped(request: Request, maxBytes: number): Promise<BodyResult> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) return { ok: false, status: 413 };
  }
  if (request.body === null) return { ok: true, text: "" };

  // The stream only counts bytes; collecting and decoding is left to the
  // runtime's own text(). Keeping the chunks, concatenating them and decoding by
  // hand held three full copies of a 20 MB backup at once, on top of the copies
  // JSON.parse and the base64 check need, against a 128 MB isolate limit.
  let total = 0;
  const counted = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) controller.error(new BodyTooLarge());
        else controller.enqueue(chunk);
      },
    }),
  );
  try {
    return { ok: true, text: await new Response(counted).text() };
  } catch (e) {
    return { ok: false, status: e instanceof BodyTooLarge ? 413 : 400 };
  }
}

// True for canonical base64 text (standard alphabet, correct padding, no
// whitespace), i.e. exactly what btoa() produces. The backup upload used to
// check its ciphertext with /^[A-Za-z0-9+/]+=*$/, which costs ~3.2 ms per MB
// of V8 time (a backup of a few MB alone would pass the Workers Free plan's
// 10 ms CPU limit); atob/btoa run natively at ~0.4 ms per MB in total. The
// round trip is stricter than the regex (it also refuses bad lengths and
// non-canonical padding), which no real client sends: backup.ts uses btoa.
export function isCanonicalBase64(s: string): boolean {
  if (s.length === 0 || s.length % 4 !== 0) return false;
  try {
    return btoa(atob(s)) === s;
  } catch {
    return false;
  }
}
