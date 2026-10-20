// Link-preview tags for a profile link (spendrr.app/@name).
//
// A chat app or social network that unfurls a link fetches the HTML and reads
// its <meta> tags; it does not run the page's JavaScript. So the Worker
// rewrites the single-page app's head for this one route. Only a name that
// really is registered gets its own tags: an unknown name gets the ordinary
// page, so nobody can make our domain advertise an arbitrary string.
//
// The picture is the name's avatar, drawn to PNG by the Worker
// (avatarPng.ts), since crawlers do not render SVG. Addressed by the Ark
// address, so it is the same picture the payer's confirm screen shows. The app
// icon is the fallback when the registry hands back no usable address.

import { AVATAR_PNG_SIZE } from "./avatarPng";

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export interface ProfileMeta {
  title: string;
  description: string;
  url: string;
  image: string;
  /** Pixel size of a square `image`, when known. */
  imageSize: number | null;
}

export function profileMeta(
  name: string,
  origin: string,
  opts: { address: string | null; lnAddress: boolean } = { address: null, lnAddress: false },
): ProfileMeta {
  const host = new URL(origin).host;
  return {
    title: opts.lnAddress ? `${name}@${host}` : `@${name} na Spendrr`,
    description: opts.lnAddress
      ? `Pošli bitcoin na ${name}@${host} z jakékoli Lightning peněženky. Ve Spendrru stačí @${name}.`
      : `Pošli bitcoin na @${name}. Funguje ve Spendrru i v jiných Ark peněženkách.`,
    url: `${origin}/@${name}`,
    image: opts.address ? `${origin}/api/avatar/${opts.address}.png` : `${origin}/icon-512.png`,
    imageSize: opts.address ? AVATAR_PNG_SIZE : null,
  };
}

// The tags added to <head>. The description <meta> that already exists is
// replaced separately (see handleProfilePage), so it is not repeated here.
export function profileMetaTags(meta: ProfileMeta): string {
  const t = escapeHtml(meta.title);
  const d = escapeHtml(meta.description);
  const u = escapeHtml(meta.url);
  const i = escapeHtml(meta.image);
  return [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Spendrr">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:url" content="${u}">`,
    `<meta property="og:image" content="${i}">`,
    ...(meta.imageSize !== null
      ? [
          `<meta property="og:image:type" content="image/png">`,
          `<meta property="og:image:width" content="${meta.imageSize}">`,
          `<meta property="og:image:height" content="${meta.imageSize}">`,
          `<meta property="og:image:alt" content="${t}">`,
        ]
      : []),
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${t}">`,
    `<meta name="twitter:description" content="${d}">`,
    `<meta name="twitter:image" content="${i}">`,
    `<link rel="canonical" href="${u}">`,
  ].join("");
}
