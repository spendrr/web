import jsQR from "jsqr";

// Reads a QR code out of a picked image (the gallery), where the live
// scanner's single downscaled pass is not enough: a screenshot can hold a
// code of any size, and jsQR finds a big code more reliably at a smaller
// scale than at the photo's full resolution. So the image is tried at several
// longest-side sizes, largest first, each both normal and inverted.
const SCAN_SIDES = [1600, 1000, 640, 400];
// A photo this large would be decoded to a bitmap of hundreds of MB.
const MAX_FILE_BYTES = 30 * 1024 * 1024;

// Longest sides to try for an image of w x h: never upscaled, so a small
// image is read as is. Pure, for the tests.
export function scanSizes(w: number, h: number): number[] {
  const longest = Math.max(w, h);
  if (!(longest > 0)) return [];
  const sides = SCAN_SIDES.filter((s) => s < longest);
  return [...(longest <= SCAN_SIDES[0] ? [longest] : []), ...sides];
}

type DetectorLike = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
type DetectorCtor = new (o: { formats: string[] }) => DetectorLike;

export async function decodeQrFromImage(file: File): Promise<string | null> {
  if (file.size > MAX_FILE_BYTES) return null;
  let bitmap: ImageBitmap;
  try {
    // from-image: a phone photo carries its rotation in EXIF.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null;
  }
  try {
    const Detector = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
    if (Detector) {
      try {
        const hits = await new Detector({ formats: ["qr_code"] }).detect(bitmap);
        const raw = hits[0]?.rawValue;
        if (raw) return raw;
      } catch {
        // Fall through to jsQR.
      }
    }
    const canvas = document.createElement("canvas");
    for (const side of scanSizes(bitmap.width, bitmap.height)) {
      const k = side / Math.max(bitmap.width, bitmap.height);
      const w = Math.max(1, Math.round(bitmap.width * k));
      const h = Math.max(1, Math.round(bitmap.height * k));
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, w, h);
      try {
        const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "attemptBoth" });
        if (code?.data) return code.data;
      } catch {
        // jsQR can throw on odd input; try the next size.
      }
      // Yield so a big image doesn't freeze the sheet between passes.
      await new Promise((r) => setTimeout(r, 0));
    }
    return null;
  } finally {
    bitmap.close();
  }
}
