import { describe, expect, it } from "vitest";
import { jpegPagePdf, jpegSize } from "../src/lib/gift/giftCardPdf";

// Minimal JPEG header: SOI, an APP0 segment, then SOF0 with height 300, width 200.
function fakeJpeg(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x00, 0xc8, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
}

describe("jpegSize", () => {
  it("reads the frame size past other segments", () => {
    expect(jpegSize(fakeJpeg())).toEqual({ width: 200, height: 300 });
  });
  it("rejects something that is not a JPEG", () => {
    expect(() => jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow();
  });
});

describe("jpegPagePdf", () => {
  const pdf = jpegPagePdf(fakeJpeg(), 595.28, 841.89);
  const text = new TextDecoder("latin1").decode(pdf);

  it("points every xref entry at its object", () => {
    const xrefAt = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xrefAt, xrefAt + 4)).toBe("xref");
    const entries = text.slice(xrefAt).split("\n").slice(3, 8);
    entries.forEach((e, i) => {
      const off = Number(e.slice(0, 10));
      expect(text.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
  });

  it("embeds the image at its own size on an A4 page", () => {
    expect(text).toContain("/Width 200 /Height 300");
    expect(text).toContain("/MediaBox [0 0 595.28 841.89]");
    expect(text).toContain(`/Length ${fakeJpeg().length}`);
  });
});
