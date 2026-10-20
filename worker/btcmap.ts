// Utility hub's "Mapa" tab (see src/components/UtilityHub.tsx) — a periodic
// cache of btcmap.org's merchant dataset plus a bbox-filtered read endpoint.
// Split out of index.ts for the same reason priceCache.ts/mailboxShared.ts
// are: index.ts's own default export is the Workers entry point and can't
// carry other runtime exports (see index.ts's top-of-file comment), so any
// function a second module needs has to live outside it.
//
// api.btcmap.org's /v2/elements has no server-side geo filtering at all —
// verified live: lat/lon/radius/bbox/offset query params are silently
// ignored, every call just returns the same first N records. The full
// dataset is ~42.8k elements / ~40MB of JSON (each wrapped in its raw OSM
// tag set), far too large to fetch per-request or ship to a mobile client.
// So this Worker fetches it on a timer, trims each element down to the six
// fields the map actually needs, and serves bbox queries out of that cache
// instead of proxying api.btcmap.org directly.

import type { Env } from "./index";
import { bumpRateLimitKey } from "./bump";

export interface BtcMapElement {
  id: string;
  lat: number;
  lon: number;
  name: string;
  category: string;
  onchain: boolean;
  lightning: boolean;
  contactless: boolean;
  // Optional — omitted (not empty-string) when the source OSM tag is
  // missing, so BtcMapPanel.tsx can tell "no address on record" apart from
  // "empty address" with a plain truthiness check.
  address?: string;
  openingHours?: string;
}

const ELEMENTS_URL = "https://api.btcmap.org/v2/elements?limit=100000";
const USER_AGENT = "Spendrr/1.0 (+https://spendrr.app; Bitcoin wallet merchant map)";

const ELEMENTS_KEY = "elements";
const META_KEY = "meta";

// The merchant map changes slowly, so a day is plenty.
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
// The download is ~40 MB and parsing it can exceed the Worker's CPU limit,
// which kills the run before `meta` is written. The attempt is therefore
// stamped BEFORE the fetch, otherwise every per-minute cron tick retries
// (about 1000 killed invocations a day). Also the retry floor after a failure.
const ATTEMPT_KEY = "attempt";
const RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Caps how large a bbox a client can ask for — without this, a client (or
// anyone calling the endpoint directly) could request the whole planet in
// one query, defeating the point of filtering server-side at all.
// Bumped 3 -> 12 alongside BtcMapPanel.tsx's MIN_ELEMENTS_ZOOM drop
// (10 -> 6): explicitly requested — a whole mid-sized country (Czechia is
// roughly 6.8° lon x 2.5° lat) needs to fit for a country-level overview,
// not just a city. At that scale MAX_RESULTS below is doing the real work
// of bounding response size, not this — the tradeoff (spelled out below)
// is an unrepresentative sample of pins, not an oversized response.
const MAX_BBOX_SPAN_DEG = 12;
// Dropped from 500 — even with BtcMapPanel.tsx's lightweight circleMarker
// rendering, redrawing that many markers on every pan/zoom was visibly
// laggy on a real phone. Still plenty for a city-scale bbox; at the
// country scale MAX_BBOX_SPAN_DEG now allows, this caps the response to
// whichever 200 elements happen to come first in KV storage order — not
// the 200 closest to view center, not an even geographic spread. A real
// fix (server-side spatial sampling/clustering) is more scope than this
// needs today; known, accepted limitation for now.
const MAX_RESULTS = 200;

const CATEGORY_TAG_KEYS = ["shop", "amenity", "tourism", "office", "craft", "leisure"];

function categoryFor(tags: Record<string, unknown>): string {
  for (const key of CATEGORY_TAG_KEYS) {
    const value = tags[key];
    if (typeof value === "string" && value) return value;
  }
  return "other";
}

function toCompactElement(raw: unknown): BtcMapElement | null {
  if (!raw || typeof raw !== "object") return null;
  // A removed element stays in the API forever as a tombstone — same shape,
  // full osm_json still attached, just with deleted_at set — rather than
  // disappearing or losing its tags. Verified live: of a 5000-element
  // sample, ~99.8% carry a non-empty deleted_at. Skipping these is why the
  // map was showing merchants that no longer exist.
  const deletedAt = (raw as { deleted_at?: unknown }).deleted_at;
  if (typeof deletedAt === "string" && deletedAt) return null;

  const id = (raw as { id?: unknown }).id;
  const osm = (raw as { osm_json?: unknown }).osm_json;
  if (typeof id !== "string" || !osm || typeof osm !== "object") return null;
  const lat = (osm as { lat?: unknown }).lat;
  const lon = (osm as { lon?: unknown }).lon;
  const tags = (osm as { tags?: unknown }).tags;
  if (typeof lat !== "number" || typeof lon !== "number" || !tags || typeof tags !== "object") return null;
  const tagRecord = tags as Record<string, unknown>;
  const name = tagRecord.name;
  if (typeof name !== "string" || !name) return null;

  // btcmap computes its own category classification server-side (the
  // element's outer `tags.category`, distinct from `osm_json.tags` above,
  // which is the raw OSM tag set) — more accurate than guessing from the
  // first matching OSM tag key, and it's what btcmap.org's own site shows.
  // Falls back to the tag-key heuristic only when that's missing.
  const btcmapTags = (raw as { tags?: unknown }).tags;
  const btcmapCategory =
    btcmapTags && typeof btcmapTags === "object" ? (btcmapTags as Record<string, unknown>).category : undefined;
  const category = typeof btcmapCategory === "string" && btcmapCategory ? btcmapCategory : categoryFor(tagRecord);

  const street = tagRecord["addr:street"];
  const houseNumber = tagRecord["addr:housenumber"];
  const address =
    typeof street === "string" && street
      ? typeof houseNumber === "string" && houseNumber
        ? `${street} ${houseNumber}`
        : street
      : undefined;
  const openingHoursRaw = tagRecord["opening_hours"];
  const openingHours = typeof openingHoursRaw === "string" && openingHoursRaw ? openingHoursRaw : undefined;

  return {
    id,
    lat,
    lon,
    name,
    category,
    onchain: tagRecord["payment:onchain"] === "yes",
    lightning: tagRecord["payment:lightning"] === "yes",
    contactless: tagRecord["payment:lightning_contactless"] === "yes",
    ...(address ? { address } : {}),
    ...(openingHours ? { openingHours } : {}),
  };
}

interface BtcMapMeta {
  lastRefresh: number;
  count: number;
}

// Fire-and-forget from scheduled() — deliberately never throws (matches
// pingHealthcheck's own "must not be mistaken for anything else" reasoning
// in index.ts): a failed refresh just leaves the existing cache in place
// until the next tick tries again, never breaks the cron trigger itself.
export async function refreshBtcMapCacheIfStale(env: Env): Promise<void> {
  const kv = env.BTCMAP_ELEMENTS;
  if (!kv) return;

  try {
    const metaRaw = await kv.get(META_KEY);
    const meta = metaRaw ? (JSON.parse(metaRaw) as BtcMapMeta) : null;
    if (meta && Date.now() - meta.lastRefresh < REFRESH_INTERVAL_MS) return;
    const attempt = Number(await kv.get(ATTEMPT_KEY));
    if (Number.isFinite(attempt) && Date.now() - attempt < RETRY_INTERVAL_MS) return;
    await kv.put(ATTEMPT_KEY, String(Date.now()));

    const res = await fetch(ELEMENTS_URL, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) return;
    const raw: unknown = await res.json();
    if (!Array.isArray(raw)) return;

    const elements: BtcMapElement[] = [];
    for (const item of raw) {
      const compact = toCompactElement(item);
      if (compact) elements.push(compact);
    }

    await kv.put(ELEMENTS_KEY, JSON.stringify(elements));
    await kv.put(META_KEY, JSON.stringify({ lastRefresh: Date.now(), count: elements.length } satisfies BtcMapMeta));
  } catch {
    // Network/parse failure — retried after RETRY_INTERVAL_MS, nothing more to do here.
  }
}

// MapTiler's free tier (100k tile loads/month) — chosen over hitting
// tile.openstreetmap.org directly, which is a donation-funded resource whose
// own usage policy asks production apps not to hotlink it without prior
// permission. Proxied same-origin for two reasons: (1) the API key has to
// stay server-side, same as COINGECKO_API_KEY, and
// (2) a client fetching tiles directly would leak the user's viewed
// location (and IP) to MapTiler on every pan/zoom — exactly what this app
// avoids elsewhere (self-hosted fonts, CoinGecko proxy).
// "streets-v2-dark" is MapTiler's own dark variant of the same style family
// (docs.maptiler.com/sdk-js/api/map-styles/) — light basemap is otherwise a
// bright rectangle sitting in an all-dark UI in dark mode. Client requests
// it via `?style=dark` (see BtcMapPanel.tsx); anything else (including no
// param) stays on the light style, so an unrecognized value can't be used
// to probe arbitrary MapTiler style ids through this proxy.
const TILE_STYLES = { light: "streets-v2", dark: "streets-v2-dark" } as const;

const TILE_URL_TEMPLATE = (z: number, x: number, y: number, key: string, style: string): string =>
  `https://api.maptiler.com/maps/${style}/${z}/${x}/${y}.png?key=${key}`;

const TILE_PATH_RE = /^\/api\/btcmap\/tile\/(\d+)\/(\d+)\/(\d+)\.png$/;
const MAX_ZOOM = 19;

// Matches this key's "Allowed user-agent header" restriction in the
// MapTiler dashboard — a server-side key can't be restricted by Origin
// (this Worker's fetch to MapTiler carries no browser Origin/Referer at
// all, it's a server-to-server call), so a fixed User-Agent is the
// equivalent defense-in-depth: even a leaked key only works from a request
// that sends this exact string.
const TILE_USER_AGENT = "Spendrr-MapProxy/1.0";

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function handleBtcMapElements(request: Request, url: URL, env: Env): Promise<Response> {
  const kv = env.BTCMAP_ELEMENTS;
  const limiter = env.BTCMAP_ELEMENTS_RATE_LIMITER;
  if (!kv || !limiter) return jsonError(503, "Map data not configured.");

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await limiter.limit({ key: bumpRateLimitKey(ip) });
  if (!success) return jsonError(429, "Rate limit exceeded.");

  const bboxParam = url.searchParams.get("bbox");
  if (!bboxParam) return jsonError(400, "Missing bbox parameter.");
  const parts = bboxParam.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return jsonError(400, "Invalid bbox parameter.");
  }
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (minLon >= maxLon || minLat >= maxLat) return jsonError(400, "Invalid bbox parameter.");
  if (maxLon - minLon > MAX_BBOX_SPAN_DEG || maxLat - minLat > MAX_BBOX_SPAN_DEG) {
    return jsonError(400, "bbox span too large.");
  }

  const raw = await kv.get(ELEMENTS_KEY);
  const elements: BtcMapElement[] = raw ? JSON.parse(raw) : [];
  const matches: BtcMapElement[] = [];
  for (const el of elements) {
    if (el.lon >= minLon && el.lon <= maxLon && el.lat >= minLat && el.lat <= maxLat) {
      matches.push(el);
      if (matches.length >= MAX_RESULTS) break;
    }
  }

  return new Response(JSON.stringify(matches), {
    status: 200,
    // public, ne no-store — data samotná se na serveru obnovují jen jednou
    // za REFRESH_INTERVAL_MS (24 h) a nejsou per-uživatel, takže je
    // bezpečné je krátce cachovat i v prohlížeči/na edge. max-age výrazně
    // kratší než ten interval, aby cache nikdy neukazovala o moc starší data
    // než server sám.
    headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
  });
}

export async function handleBtcMapTile(request: Request, url: URL, env: Env): Promise<Response> {
  const key = env.BTCMAP_TILES_API_KEY;
  if (!key) return jsonError(503, "Map tiles not configured.");

  const limiter = env.BTCMAP_TILE_RATE_LIMITER;
  if (!limiter) return jsonError(503, "Map tiles not configured.");
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  // Much more generous than the elements limiter above — a single screenful
  // of tiles is a few dozen requests, not a handful, and Cloudflare's edge
  // cache below absorbs most repeat requests anyway.
  const { success } = await limiter.limit({ key: ip });
  if (!success) return jsonError(429, "Rate limit exceeded.");

  const match = TILE_PATH_RE.exec(url.pathname);
  if (!match) return jsonError(400, "Invalid tile path.");
  const z = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  const maxCoord = 2 ** z;
  if (z > MAX_ZOOM || x >= maxCoord || y >= maxCoord) return jsonError(400, "Invalid tile coordinates.");

  // The key is built from the validated parts only. It used to be the request
  // URL, so any extra query parameter (?x=1, ?x=2, ...) was a fresh key and a
  // fresh MapTiler call on our key for the same tile. Light and dark stay
  // separate entries.
  const wantsDark = url.searchParams.get("style") === "dark";
  const cache = caches.default;
  const cacheKey = new Request(`https://tile-cache.internal/${z}/${x}/${y}.png?style=${wantsDark ? "dark" : "light"}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let upstream: Response;
  try {
    upstream = await fetch(TILE_URL_TEMPLATE(z, x, y, key, wantsDark ? TILE_STYLES.dark : TILE_STYLES.light), {
      headers: { "User-Agent": TILE_USER_AGENT },
    });
    // Fail-safe, not fail-broken: if the dark style ever 404s/errors on
    // MapTiler's side (wrong id, plan doesn't include it, etc.), fall back
    // to the light tile rather than showing a broken/blank map in dark mode
    // — worse than a light map in a dark UI, but never worse than before
    // this feature existed.
    if (!upstream.ok && wantsDark) {
      upstream = await fetch(TILE_URL_TEMPLATE(z, x, y, key, TILE_STYLES.light), {
        headers: { "User-Agent": TILE_USER_AGENT },
      });
    }
  } catch {
    return jsonError(502, "Upstream tile source unreachable.");
  }
  if (!upstream.ok) return jsonError(502, "Upstream tile source unreachable.");

  const body = await upstream.arrayBuffer();
  const response = new Response(body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "image/png",
      // Tiles are effectively static at a given z/x/y — a long TTL here is
      // what actually keeps real MapTiler usage far below what user panning
      // would otherwise generate, shared across every visitor to this
      // Worker, not just per-request.
      "cache-control": "public, max-age=604800, immutable",
    },
  });
  await cache.put(cacheKey, response.clone());
  return response;
}
