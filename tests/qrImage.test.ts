import { describe, expect, it } from "vitest";
import { scanSizes } from "../src/lib/ui/qrImage";

describe("scanSizes", () => {
  it("never upscales a small image", () => {
    expect(scanSizes(300, 200)).toEqual([300]);
  });
  it("reads an image up to the top size as is, then smaller", () => {
    expect(scanSizes(1200, 900)).toEqual([1200, 1000, 640, 400]);
  });
  it("downscales a large photo, largest first", () => {
    expect(scanSizes(4000, 3000)).toEqual([1600, 1000, 640, 400]);
  });
  it("handles degenerate sizes", () => {
    expect(scanSizes(0, 0)).toEqual([]);
  });
});
