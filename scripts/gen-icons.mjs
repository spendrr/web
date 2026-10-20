import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const svg = readFileSync(`${ROOT}/public/favicon.svg`, "utf8");
const svgDataUrl = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
const badgeSvg = readFileSync(`${ROOT}/public/badge.svg`, "utf8");
const badgeSvgDataUrl = "data:image/svg+xml;base64," + Buffer.from(badgeSvg).toString("base64");

// favicon.svg itself is deliberately drawn small and centered (not filling
// the square edge-to-edge) so it survives being cropped to an arbitrary
// shape — circle, squircle, rounded square — by whatever OS/launcher adds it
// to a home screen. Some Android launchers apply a circular crop even to
// icons not marked "purpose: maskable", so the same conservative artwork is
// used for every size here rather than trying to maintain two designs.
//
// favicon.svg switches between a light and a dark tile via
// prefers-color-scheme (for the browser tab). Home-screen icons are the dark
// one for everyone, so these pages are rendered with the dark scheme.
const sizes = [
  { size: 180, out: "apple-touch-icon.png" }, // iOS home screen
  { size: 192, out: "icon-192.png" }, // Android/manifest, purpose "any"
  { size: 512, out: "icon-512.png" }, // Android/manifest, purpose "any" and "maskable"
];

const browser = await chromium.launch();
for (const { size, out } of sizes) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, colorScheme: "dark" });
  // Fill the corners with the same color as the rounded rect's own background
  // rather than leaving them transparent (iOS fills transparent
  // apple-touch-icon corners with black) — the OS applies its own mask shape
  // on top anyway, so this just needs to not look like a visible artifact
  // underneath it.
  await page.setContent(
    `<html><body style="margin:0;padding:0;background:#16130d;"><img src="${svgDataUrl}" width="${size}" height="${size}" /></body></html>`,
  );
  await page.waitForTimeout(50);
  await page.screenshot({ path: `${ROOT}/public/${out}`, omitBackground: false });
  await page.close();
  console.log("wrote", out);
}

// Android's notification status-bar badge ignores color entirely and masks
// by alpha channel — the full-color, opaque-background app icon above
// rendered as a solid filled square there instead of a legible shape. This
// is a separate, transparent, single-shape asset (the logo's "s." in white)
// just for that purpose; sw.js's showNotification() uses it for `badge` while `icon`
// keeps using icon-192.png.
{
  const size = 96;
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<html><body style="margin:0;padding:0;background:transparent;"><img src="${badgeSvgDataUrl}" width="${size}" height="${size}" /></body></html>`,
  );
  await page.waitForTimeout(50);
  await page.screenshot({
    path: `${ROOT}/public/badge-96.png`,
    omitBackground: true,
  });
  await page.close();
  console.log("wrote badge-96.png");
}

await browser.close();
