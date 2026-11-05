// What the map already knows about, so a pan inside it costs no request.
//
// A pan inside an area already fetched costs no request: the first request
// covers the viewport plus half a screen on every side, and later views inside
// that box are answered here instead of asking /api/btcmap/elements again (each
// ask is a Worker request).
//
// The server returns at most ELEMENTS_CAP places per request (worker/btcmap.ts,
// MAX_RESULTS: the first ones it finds, not the nearest). A response at the cap
// may be missing places, so it is never reused for a different view, and a
// capped padded box makes the next requests ask for the exact viewport again
// for a while (a dense city gets the old behaviour, plus one extra request).

export type Bbox = [minLon: number, minLat: number, maxLon: number, maxLat: number];
export interface Located {
  lon: number;
  lat: number;
}

// Mirrors worker/btcmap.ts: MAX_RESULTS and MAX_BBOX_SPAN_DEG.
export const ELEMENTS_CAP = 200;
export const MAX_SPAN_DEG = 12;

const REUSE_MS = 5 * 60_000;
const DENSE_MS = 5 * 60_000;
const MAX_ENTRIES = 8;

// The view grown by `factor` of its size on each side; the view itself when
// that would pass the server's span limit.
export function padBbox(view: Bbox, factor = 0.5): Bbox {
  const [minLon, minLat, maxLon, maxLat] = view;
  const dLon = (maxLon - minLon) * factor;
  const dLat = (maxLat - minLat) * factor;
  if (maxLon - minLon + 2 * dLon > MAX_SPAN_DEG - 0.01 || maxLat - minLat + 2 * dLat > MAX_SPAN_DEG - 0.01) return view;
  return [Math.max(-180, minLon - dLon), Math.max(-85.06, minLat - dLat), Math.min(180, maxLon + dLon), Math.min(85.06, maxLat + dLat)];
}

export function bboxContains(outer: Bbox, inner: Bbox): boolean {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

function within<T extends Located>(view: Bbox, elements: readonly T[]): T[] {
  return elements.filter((e) => e.lon >= view[0] && e.lon <= view[2] && e.lat >= view[1] && e.lat <= view[3]);
}

export class CoverageCache<T extends Located> {
  private entries: { bbox: Bbox; elements: T[]; at: number }[] = [];
  private denseUntil = 0;

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  // The places in `view`, when a complete, recent response covers it.
  find(view: Bbox): T[] | null {
    const t = this.now();
    for (const e of this.entries) {
      if (t - e.at < REUSE_MS && bboxContains(e.bbox, view)) return within(view, e.elements);
    }
    return null;
  }

  put(bbox: Bbox, elements: T[]): void {
    const t = this.now();
    this.entries = [{ bbox, elements, at: t }, ...this.entries.filter((e) => t - e.at < REUSE_MS)].slice(0, MAX_ENTRIES);
  }

  markDense(): void {
    this.denseUntil = this.now() + DENSE_MS;
  }

  isDense(): boolean {
    return this.now() < this.denseUntil;
  }
}

// The places in `view`: from the cache when covered, else one request for the
// padded box (two when that came back capped), null on a failed request.
export async function loadElements<T extends Located>(
  cache: CoverageCache<T>,
  view: Bbox,
  fetchBbox: (bbox: Bbox) => Promise<T[] | null>,
): Promise<T[] | null> {
  const hit = cache.find(view);
  if (hit) return hit;
  const box = cache.isDense() ? view : padBbox(view);
  const got = await fetchBbox(box);
  if (got === null) return null;
  if (got.length < ELEMENTS_CAP) {
    cache.put(box, got);
    return within(view, got);
  }
  // Capped: the response may be missing places, so it is not remembered.
  cache.markDense();
  if (box === view) return got;
  const exact = await fetchBbox(view);
  // The exact view can be complete even though the padded box was capped.
  if (exact !== null && exact.length < ELEMENTS_CAP) cache.put(view, exact);
  return exact;
}
