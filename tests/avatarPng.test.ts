import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { avatarPng, flattenPath, isAvatarAddress, renderAvatarRgb } from "../worker/avatarPng";
import { avatarSpec } from "../src/lib/names/avatar";

const ADDRESS =
  "ark1pu6h30w3zqqpkhe3x8w4mq9pjhsaw9kzj3a74ynsm64nvcsll3qrpqmql9r5emnxkhlj3n2ch0x0kwqzg7l77vfs6ulu50kn5lx2qq8u5ecdtpu0re4wnre4sy9w5r";

// Undoes the "Sub" filter encodePng applies, back to packed RGB.
function decode(png: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let o = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (o < png.length) {
    const len = view.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const data = png.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(o + 8);
      height = view.getUint32(o + 12);
    }
    if (type === "IDAT") idat.push(data);
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const rgb = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(1);
    for (let x = 0; x < stride; x++) {
      const left = x >= 3 ? rgb[y * stride + x - 3] : 0;
      rgb[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + left) & 0xff;
    }
  }
  return { width, height, rgb };
}

describe("avatarPng", () => {
  it("is a valid PNG that decodes to exactly the rendered pixels", async () => {
    const png = await avatarPng(ADDRESS);
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const { width, height, rgb } = decode(png);
    expect([width, height]).toEqual([256, 256]);
    expect(Array.from(rgb)).toEqual(Array.from(renderAvatarRgb(ADDRESS, 256, Math.round(256 * 0.08), "#f2ede4")));
  });

  it("is deterministic and depends on the address", () => {
    const a = renderAvatarRgb(ADDRESS, 64, 4, "#f2ede4");
    expect(renderAvatarRgb(ADDRESS, 64, 4, "#f2ede4")).toEqual(a);
    expect(renderAvatarRgb(ADDRESS.slice(0, -1) + "q", 64, 4, "#f2ede4")).not.toEqual(a);
  });

  it("keeps the corners outside the round crop in the outer colour", () => {
    const rgb = renderAvatarRgb(ADDRESS, 64, 4, "#f2ede4");
    expect(Array.from(rgb.subarray(0, 3))).toEqual([0xf2, 0xed, 0xe4]);
  });

  it("paints the background gradient where no shape covers it", () => {
    // Every composition draws on the background; the pixel just inside the crop
    // at the top is background or a shape, never the outer colour.
    const rgb = renderAvatarRgb(ADDRESS, 100, 0, "#000000");
    const k = (2 * 100 + 50) * 3;
    expect(rgb[k] + rgb[k + 1] + rgb[k + 2]).toBeGreaterThan(0);
    expect(avatarSpec(ADDRESS).background.from).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("flattenPath", () => {
  it("reads the command grammar avatar.ts emits", () => {
    expect(flattenPath("M0 0L10 0L10 10Z")).toEqual([
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
    ]);
    const wave = flattenPath("M-5 40 C 20 30 30 50 52 40 S 85 30 105 40 V105 H-5Z")[0];
    expect(wave[wave.length - 1]).toEqual([-5, 105]);
    const arc = flattenPath("M0 0L50 0A50 50 0 0 1 0 50Z")[0];
    // the quarter arc passes through (50cos45, 50sin45)
    expect(arc.some(([x, y]) => Math.abs(x - 35.36) < 0.5 && Math.abs(y - 35.36) < 0.5)).toBe(true);
  });
});

describe("isAvatarAddress", () => {
  it("accepts an Ark address and nothing else", () => {
    expect(isAvatarAddress(ADDRESS)).toBe(true);
    expect(isAvatarAddress("ark1" + "b".repeat(30))).toBe(false); // 'b' is not in the bech32 charset
    expect(isAvatarAddress("bc1qxyz")).toBe(false);
    expect(isAvatarAddress("ark1../../etc")).toBe(false);
    expect(isAvatarAddress(ADDRESS.toUpperCase())).toBe(false);
  });
});
