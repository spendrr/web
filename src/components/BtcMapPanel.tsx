import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
// Side-effect import — extends the `L` namespace with L.markerClusterGroup
// (see @types/leaflet.markercluster for the augmented types). Only the base
// layout stylesheet, not MarkerCluster.Default.css — that one ships the
// plugin's own green/yellow/orange circular theme, which we don't want;
// .btcmap-cluster-icon in BtcMapPanel.css styles clusters in the app's own
// language instead (bordered/hard-shadow, same as everything else here).
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import markerIconUrl from "leaflet/dist/images/marker-icon.png";
import markerIcon2xUrl from "leaflet/dist/images/marker-icon-2x.png";
import markerShadowUrl from "leaflet/dist/images/marker-shadow.png";
import { useT } from "../lib/i18n";
import { CoverageCache, loadElements, type Bbox } from "../lib/btcmapCoverage";
import "./BtcMapPanel.css";

// Leaflet's default marker icon CSS/JS points at plain relative paths
// ("images/marker-icon.png") meant to sit next to a copied dist/leaflet.css
// — meaningless once Vite bundles this app (would 404, and even if it
// somehow resolved to a bare path it would violate img-src 'self' since
// it's not a real same-origin asset URL). Importing the PNGs as modules
// makes Vite emit them as real hashed same-origin assets.
//
// Tried Icon.Default.mergeOptions({iconUrl, iconRetinaUrl, shadowUrl}) here
// first (the commonly-suggested fix) — broke in practice: Icon.Default's
// own _getIconUrl still ran its built-in path-detection for the retina/
// shadow variants and concatenated it onto the already-resolved iconUrl,
// producing a doubled, 404ing path
// (.../leaflet/dist/images//node_modules/leaflet/dist/images/marker-icon-2x.png).
// A plain L.icon() with explicit geometry sidesteps that machinery
// entirely — this is the actual icon the "you are here" marker uses,
// built once at module scope, not the Default prototype.
const meIcon = L.icon({
  iconUrl: markerIconUrl,
  iconRetinaUrl: markerIcon2xUrl,
  shadowUrl: markerShadowUrl,
  // Leaflet's own Default icon geometry (leaflet/dist/leaflet-src.js) — not
  // derivable from the image files themselves, has to be repeated here.
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

// A real L.Marker per business, not a Canvas circle: clustering (below) needs
// Marker instances (markercluster calls marker.setIcon() and so on) and does
// not work with CircleMarker. One shared DivIcon for all businesses, styled by
// .btcmap-marker-dot in BtcMapPanel.css (--accent fill, --border outline).
const businessIcon = L.divIcon({
  className: "btcmap-marker-dot",
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

// The bubble size grows in a few steps with the number of businesses inside.
// Purely visual (nothing else depends on the size), so a cluster of 60 does not
// look like a cluster of 3.
function clusterIcon(count: number): L.DivIcon {
  const size = count >= 50 ? 44 : count >= 10 ? 38 : 32;
  return L.divIcon({
    html: `<span>${count}</span>`,
    className: "btcmap-cluster-icon",
    iconSize: [size, size],
  });
}

// Prague: the app is Czech, this is only the initial view before the user
// locates themselves or moves the map.
const DEFAULT_CENTER: L.LatLngTuple = [50.0755, 14.4378];
const DEFAULT_ZOOM = 13;
// 13 shows the wider surroundings right after locating, closer to what a user
// expects under "nearby". A tighter view (a few blocks) easily lands on a spot
// with no business in the dataset even in a well covered area.
const GEOLOCATE_ZOOM = 13;
// Lowest zoom that still searches: the whole country should fit at once (about
// 6.8° wide for Czechia). worker/btcmap.ts allows a bbox up to
// MAX_BBOX_SPAN_DEG = 12°, which for the height of the map is about zoom 6.
// Below that the visible area is roughly a continent and the pins would be a
// random sample, not "businesses nearby" in any sense.
const MIN_ELEMENTS_ZOOM = 6;
const FETCH_DEBOUNCE_MS = 400;
// Normal pan/zoom on a warm edge cache resolves well under this — showing
// the badge immediately made it flash in/out on every ordinary zoom step.
// Only a genuinely slow fetch (cold cache, bad connection) now shows it.
const LOADING_BADGE_DELAY_MS = 400;

interface BtcMapElement {
  id: string;
  lat: number;
  lon: number;
  name: string;
  category: string;
  onchain: boolean;
  lightning: boolean;
  contactless: boolean;
  address?: string;
  openingHours?: string;
}

// Short Czech labels for the most common OSM tags in the dataset. The rest
// falls back to the raw tag value (see categoryLabel), which is readable
// without a translation (e.g. "car_repair").
const CATEGORY_LABELS: Record<string, string> = {
  cafe: "Kavárna",
  restaurant: "Restaurace",
  fast_food: "Fast food",
  bar: "Bar",
  pub: "Hospoda",
  hotel: "Hotel",
  guest_house: "Penzion",
  hostel: "Hostel",
  supermarket: "Supermarket",
  convenience: "Večerka",
  bakery: "Pekařství",
  clothes: "Oblečení",
  hairdresser: "Kadeřnictví",
  books: "Knihkupectví",
  electronics: "Elektronika",
  gift: "Dárky",
  jewelry: "Klenotnictví",
  atm: "Bankomat",
  fuel: "Čerpací stanice",
  car_repair: "Autoservis",
  other: "Ostatní",
};

function categoryLabel(t: ReturnType<typeof useT>, category: string): string {
  const known = CATEGORY_LABELS[category];
  return known ? t(known) : category;
}

// Popup content is built only through the DOM API (createElement/textContent),
// never through innerHTML with string interpolation: `name`/`category` come
// from raw OSM tags that anyone can edit (btcmap.org reads straight from
// OpenStreetMap), so they are untrusted input. fetch-guard.js protects only
// against a specific family of network elements injected through innerHTML
// (link/a ping/meta refresh/script), not against a general <img onerror=...>
// stored XSS: the only safe way is to build the DOM by hand.
function buildPopupContent(t: ReturnType<typeof useT>, el: BtcMapElement): HTMLElement {
  const root = document.createElement("div");
  root.className = "btcmap-popup";

  const name = document.createElement("div");
  name.className = "btcmap-popup-name";
  name.textContent = el.name;
  root.appendChild(name);

  const category = document.createElement("div");
  category.className = "btcmap-popup-category";
  category.textContent = categoryLabel(t, el.category);
  root.appendChild(category);

  if (el.address) {
    root.appendChild(makeMetaRow("📍", el.address));
  }
  if (el.openingHours) {
    // Raw OSM opening_hours syntax (e.g. "Mo-Fr 08:00-18:00"): readable without
    // parsing, a full parser for the format would be far more work than this
    // popup needs.
    root.appendChild(makeMetaRow("🕓", el.openingHours));
  }

  const chips = document.createElement("div");
  chips.className = "btcmap-popup-chips";
  if (el.onchain) chips.appendChild(makeChip("₿", t("On-chain")));
  if (el.lightning) chips.appendChild(makeChip("⚡", t("Lightning")));
  if (el.contactless) chips.appendChild(makeChip("💳", t("Karta")));
  if (chips.childNodes.length > 0) root.appendChild(chips);

  const link = document.createElement("a");
  link.className = "btcmap-popup-link";
  link.href = `https://btcmap.org/merchant/${encodeURIComponent(el.id)}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = t("Zobrazit na btcmap.org");
  root.appendChild(link);

  return root;
}

function makeMetaRow(glyph: string, text: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "btcmap-popup-meta";
  const icon = document.createElement("span");
  icon.className = "btcmap-popup-meta-glyph";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = glyph;
  row.appendChild(icon);
  const label = document.createElement("span");
  label.textContent = text;
  row.appendChild(label);
  return row;
}

// One unified look for all payment kinds (not a background/text colour per
// type), matching the app's own language of hard-bordered "sticker" tags (see
// .big-action-btn/.utility-hub-card), not a generic coloured pill.
function makeChip(glyph: string, label: string): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "btcmap-popup-chip";
  const icon = document.createElement("span");
  icon.className = "btcmap-popup-chip-glyph";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = glyph;
  chip.appendChild(icon);
  chip.appendChild(document.createTextNode(label));
  return chip;
}

// Reads whether the app currently renders dark mode: the same two-step logic as
// theme.ts's (unexported) resolvedTheme(): an explicit data-theme on <html>
// (Settings) wins, otherwise the OS preference. Duplicated here instead of
// imported, so BtcMapPanel.tsx does not depend on theme.ts's internal state
// just for one attribute read.
function getEffectiveTheme(): "light" | "dark" {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function tileUrlTemplate(theme: "light" | "dark"): string {
  // r=2: 512 px tiles (see the tile layer). The number also keeps the browser's
  // 7-day immutable copies of the old 256 px URLs from being reused.
  return `/api/btcmap/tile/{z}/{x}/{y}.png?r=2${theme === "dark" ? "&style=dark" : ""}`;
}

function boundsToBbox(bounds: L.LatLngBounds): Bbox {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  return [sw.lng, sw.lat, ne.lng, ne.lat];
}

// What the map screen already fetched: a pan inside it costs no request.
const elementsCoverage = new CoverageCache<BtcMapElement>();

async function fetchElementsInBbox(bbox: Bbox | string): Promise<BtcMapElement[] | null> {
  try {
    const res = await fetch(`/api/btcmap/elements?bbox=${encodeURIComponent(typeof bbox === "string" ? bbox : bbox.join(","))}`);
    if (!res.ok) return null;
    return (await res.json()) as BtcMapElement[];
  } catch {
    return null;
  }
}

const EARTH_RADIUS_M = 6371000;

function distanceMeters(a: L.LatLngTuple, b: { lat: number; lon: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a[0]);
  const dLon = toRad(b.lon - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

// null = a network/server error on the first step, where trying further makes
// no sense.
// [] = nothing even in the widest view (a data gap, not an error).
// The widening search below costs up to six requests in a thinly covered area.
// Its raw result is remembered for a few minutes per ~1 km cell, so opening
// the nearby list again (or moving a little) costs none.
const NEARBY_REMEMBER_MS = 5 * 60_000;
// Positions are grouped by two decimals, so two in one cell are less than this apart.
const NEARBY_CELL_DEG = 0.01;
const nearbyMemory = new Map<string, { at: number; elements: BtcMapElement[] }>();

function rankNearby(latlng: L.LatLngTuple, elements: BtcMapElement[]): (BtcMapElement & { distanceM: number })[] {
  return elements
    .map((el) => ({ ...el, distanceM: distanceMeters(latlng, el) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, NEARBY_COUNT);
}

async function fetchNearestElements(
  latlng: L.LatLngTuple,
): Promise<(BtcMapElement & { distanceM: number })[] | null> {
  const cell = `${latlng[0].toFixed(2)},${latlng[1].toFixed(2)}`;
  const remembered = nearbyMemory.get(cell);
  if (remembered && Date.now() - remembered.at < NEARBY_REMEMBER_MS) return rankNearby(latlng, remembered.elements);
  for (const span of NEARBY_BBOX_STEPS_DEG) {
    // The box is a cell wider on every side, so the result also covers the search
    // of any other position that rounds to the same cell.
    // (capped so the widest step stays inside the server's span limit)
    const reach = Math.min(span + NEARBY_CELL_DEG, 5.99);
    const bbox = `${latlng[1] - reach},${latlng[0] - reach},${latlng[1] + reach},${latlng[0] + reach}`;
    const elements = await fetchElementsInBbox(bbox);
    if (elements === null) return null;
    if (elements.length > 0) {
      nearbyMemory.set(cell, { at: Date.now(), elements });
      return rankNearby(latlng, elements);
    }
  }
  nearbyMemory.set(cell, { at: Date.now(), elements: [] });
  return [];
}

const NEARBY_COUNT = 10;
// A single small fixed view could come back empty in a sparsely covered area
// even when the nearest business was just a bit further away, and the user saw
// "no businesses nearby" instead of a list. So try progressively wider views
// until something is found (or until MAX_BBOX_SPAN_DEG in worker/btcmap.ts: the
// last step of 6° on each side gives a bbox span of 12°, exactly at the limit).
const NEARBY_BBOX_STEPS_DEG = [0.03, 0.1, 0.3, 1, 3, 6];

export default function BtcMapPanel() {
  const t = useT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.MarkerClusterGroup | null>(null);
  const meMarkerRef = useRef<L.Marker | null>(null);
  const fetchTimerRef = useRef<number | null>(null);
  const loadingBadgeTimerRef = useRef<number | null>(null);
  const fetchSeqRef = useRef(0);
  const nearbySeqRef = useRef(0);

  const [zoomHint, setZoomHint] = useState(false);
  const [elementsLoading, setElementsLoading] = useState(false);
  const [elementsError, setElementsError] = useState<string | null>(null);
  const [locateError, setLocateError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  // null = no query has run yet (the button was not used yet),
  // [] = the query ran and there is nothing nearby: two different things to
  // show.
  const [nearby, setNearby] = useState<(BtcMapElement & { distanceM: number })[] | null>(null);
  // Kept apart from `nearby` itself: the button toggles show/hide. Hiding does
  // not clear `nearby`, so opening it again after hiding does locate again and
  // overwrite the data (the position may have changed meanwhile), but does not
  // have to wait for a fresh answer to show anything at all.
  const [nearbyVisible, setNearbyVisible] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = L.map(container).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    mapRef.current = map;
    const tiles = L.tileLayer(tileUrlTemplate(getEffectiveTheme()), {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> &copy; <a href="https://btcmap.org" target="_blank" rel="noopener noreferrer">BTC Map</a>',
      // 512 px tiles one zoom level lower: four times fewer tile requests (each
      // one is a Worker invocation) for the same screen, same sharpness.
      tileSize: 512,
      zoomOffset: -1,
      minZoom: 1,
      maxZoom: 19,
      // Tiles load once a pan or a zoom has settled, not on the way: a zoom
      // from the country to the street would otherwise fetch every level it
      // passes, and each tile is a Worker request.
      updateWhenIdle: true,
      updateWhenZooming: false,
    }).addTo(map);
    // Clusters nearby points into one numbered bubble (.btcmap-cluster-icon)
    // that zooms in or breaks apart on click. In a densely covered area
    // (central Prague) dozens of dots in one block overlapped and a single
    // business could not be hit. markercluster works with real L.Marker
    // instances (it needs setIcon() and so on), not Canvas-rendered
    // CircleMarker, which is why the map has no `preferCanvas`. DOM load is no
    // concern: a dense area now produces one cluster node instead of dozens of
    // single markers, so the real number of DOM nodes is lower, not higher.
    const markers = L.markerClusterGroup({
      iconCreateFunction: (cluster) => clusterIcon(cluster.getChildCount()),
    }).addTo(map);
    markersRef.current = markers;

    // Switches the tiles to the dark/light style when the theme changes,
    // without recreating the whole map: both the OS preference (system theme)
    // and a manual switch in Settings (data-theme on <html>).
    const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");
    const updateTileTheme = () => tiles.setUrl(tileUrlTemplate(getEffectiveTheme()));
    darkMedia.addEventListener("change", updateTileTheme);
    const themeObserver = new MutationObserver(updateTileTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const scheduleFetch = () => {
      if (fetchTimerRef.current !== null) window.clearTimeout(fetchTimerRef.current);
      fetchTimerRef.current = window.setTimeout(() => {
        void fetchElements();
      }, FETCH_DEBOUNCE_MS);
    };

    const fetchElements = async () => {
      const currentMap = mapRef.current;
      const layer = markersRef.current;
      if (!currentMap || !layer) return;

      const clearLoadingBadgeTimer = () => {
        if (loadingBadgeTimerRef.current !== null) {
          window.clearTimeout(loadingBadgeTimerRef.current);
          loadingBadgeTimerRef.current = null;
        }
      };

      if (currentMap.getZoom() < MIN_ELEMENTS_ZOOM) {
        setZoomHint(true);
        setElementsError(null);
        clearLoadingBadgeTimer();
        setElementsLoading(false);
        layer.clearLayers();
        return;
      }
      setZoomHint(false);

      const seq = ++fetchSeqRef.current;
      const bbox = boundsToBbox(currentMap.getBounds());
      // Delayed reveal, not an immediate setElementsLoading(true) — a warm
      // edge cache answers well within LOADING_BADGE_DELAY_MS on ordinary
      // pan/zoom, so showing the badge right away just made it flash in and
      // back out on every step. Only a fetch that's actually still running
      // once this timer fires shows it.
      clearLoadingBadgeTimer();
      loadingBadgeTimerRef.current = window.setTimeout(() => {
        loadingBadgeTimerRef.current = null;
        if (seq === fetchSeqRef.current) setElementsLoading(true);
      }, LOADING_BADGE_DELAY_MS);
      const elements = await loadElements(elementsCoverage, bbox, fetchElementsInBbox);
      // Drop the response if a newer query has run meanwhile (fast panning
      // could otherwise draw stale data over new data). The newer request
      // settles its own loading/error state.
      if (seq !== fetchSeqRef.current) return;
      clearLoadingBadgeTimer();
      setElementsLoading(false);
      if (!elements) {
        setElementsError(t("Nepodařilo se načíst podniky. Zkontroluj připojení."));
        return;
      }
      setElementsError(null);

      layer.clearLayers();
      // Build an array and call addLayers() once: markercluster computes this
      // in one pass, while addTo() one by one would recompute the clusters for
      // each of up to 200 markers.
      const newMarkers: L.Marker[] = [];
      for (const el of elements) {
        const marker = L.marker([el.lat, el.lon], { icon: businessIcon });
        // Popup content built lazily on click, not for every one of up to
        // 200 markers on every single redraw — this is what actually fixed
        // the map feeling laggy on a real phone; eagerly building ~200 tiny
        // DOM trees per pan/zoom (most of which the user never clicks) was
        // the real cost, not the marker rendering itself.
        marker.on("click", () => {
          // autoPan: false: otherwise Leaflet nudges the map after opening a
          // popup so that it fits into the view, which fires moveend →
          // scheduleFetch → after 400 ms fetchElements() → layer.clearLayers(),
          // which deletes the marker that was just opened together with its
          // popup. The user sees the popup vanish by itself after a moment.
          marker.bindPopup(buildPopupContent(t, el), { autoPan: false }).openPopup();
        });
        newMarkers.push(marker);
      }
      layer.addLayers(newMarkers);
    };

    map.on("moveend", scheduleFetch);
    map.on("zoomend", scheduleFetch);
    scheduleFetch();

    return () => {
      if (fetchTimerRef.current !== null) window.clearTimeout(fetchTimerRef.current);
      if (loadingBadgeTimerRef.current !== null) window.clearTimeout(loadingBadgeTimerRef.current);
      darkMedia.removeEventListener("change", updateTileTheme);
      themeObserver.disconnect();
      map.remove();
      mapRef.current = null;
      markersRef.current = null;
      meMarkerRef.current = null;
    };
    // `t` is stable through useCallback (see i18n.ts) and changes only on a
    // real language change: re-initializing the whole map for that is
    // pointless, the popups pick up a fresh `t` at their next open anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLocate = () => {
    if (!navigator.geolocation) {
      setLocateError(t("Poloha není v tomto prohlížeči podporována."));
      return;
    }
    setLocating(true);
    setLocateError(null);
    setNearbyVisible(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        const map = mapRef.current;
        if (!map) return;
        const latlng: L.LatLngTuple = [position.coords.latitude, position.coords.longitude];
        map.setView(latlng, GEOLOCATE_ZOOM);
        if (meMarkerRef.current) {
          meMarkerRef.current.setLatLng(latlng);
        } else {
          // bindPopup(string) is fine here (unlike buildPopupContent for the
          // OSM data above): "Jste tady" is fixed text controlled by the app,
          // not untrusted input from outside.
          meMarkerRef.current = L.marker(latlng, { title: t("Jste tady"), icon: meIcon })
            .addTo(map)
            .bindPopup(t("Jste tady"));
        }

        // A separate query around the user, independent of the map-driven
        // fetchElements above (that one reacts to moveend/zoom and returns at
        // most MAX_RESULTS points from the whole visible area, not specifically
        // "the nearest"), so that "Najít podniky poblíž" reliably shows an
        // ordered list of cards even right after the map is first opened.
        // fetchNearestElements itself tries ever wider views until it finds
        // something, so a sparsely covered area does not end up at "no
        // businesses nearby" straight away.
        setNearby(null);
        const seq = ++nearbySeqRef.current;
        void fetchNearestElements(latlng).then((elements) => {
          if (elements === null) return;
          if (seq !== nearbySeqRef.current) return;
          setNearby(elements);
        });
      },
      () => {
        setLocating(false);
        setNearbyVisible(false);
        setLocateError(t("Polohu se nepodařilo zjistit. Zkontroluj oprávnění v prohlížeči."));
      },
      { enableHighAccuracy: false, timeout: 10_000 },
    );
  };

  const handleLocateButtonClick = () => {
    // Toggle: if the panel is already visible this click only hides it, without
    // a new geolocation. If the panel is hidden (with data from last time or
    // with no data at all), every click locates again, see handleLocate.
    if (nearbyVisible) {
      setNearbyVisible(false);
      return;
    }
    handleLocate();
  };

  // Does not take the popup from an existing marker (it could disappear
  // meanwhile, be rebuilt by a moveend fetch, or be hidden inside a cluster):
  // it opens its own popup directly, which works reliably whatever is happening
  // with the layer of pins.
  const handleCardClick = (el: BtcMapElement) => {
    const map = mapRef.current;
    if (!map) return;
    map.setView([el.lat, el.lon], Math.max(map.getZoom(), 16));
    L.popup().setLatLng([el.lat, el.lon]).setContent(buildPopupContent(t, el)).openOn(map);
  };

  return (
    <div className="btcmap-panel">
      <div className="btcmap-map-wrap">
        <div ref={containerRef} className="btcmap-map" />
        {zoomHint && <div className="btcmap-zoom-hint">{t("Přibližte mapu pro zobrazení podniků.")}</div>}
        {!zoomHint && elementsError && <div className="btcmap-status-badge btcmap-status-badge--error">{elementsError}</div>}
        {!zoomHint && !elementsError && elementsLoading && (
          <div className="btcmap-status-badge">{t("Načítám…")}</div>
        )}
        {nearbyVisible && nearby !== null && (
          <div className="btcmap-nearby-overlay">
            {nearby.length > 0 ? (
              <div className="btcmap-nearby-list">
                {nearby.map((el) => (
                  <button key={el.id} type="button" className="btcmap-nearby-card" onClick={() => handleCardClick(el)}>
                    <span className="btcmap-nearby-card-name">{el.name}</span>
                    <span className="btcmap-nearby-card-sub">
                      {formatDistance(el.distanceM)} · {categoryLabel(t, el.category)}
                    </span>
                    <span className="btcmap-nearby-card-chips">
                      {el.onchain && (
                        <span className="btcmap-popup-chip" aria-label={t("On-chain")}>
                          ₿
                        </span>
                      )}
                      {el.lightning && (
                        <span className="btcmap-popup-chip" aria-label={t("Lightning")}>
                          ⚡
                        </span>
                      )}
                      {el.contactless && (
                        <span className="btcmap-popup-chip" aria-label={t("Karta")}>
                          💳
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="btcmap-nearby-empty">{t("V okolí nejsou v datech žádné podniky.")}</p>
            )}
          </div>
        )}
      </div>
      <div className="btcmap-controls">
        <button type="button" className="btcmap-locate-btn" onClick={handleLocateButtonClick} disabled={locating}>
          <span className="btcmap-locate-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21Z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
              />
              <circle cx="12" cy="9.5" r="2.5" stroke="currentColor" strokeWidth="2" />
            </svg>
          </span>
          {locating ? t("Hledám polohu…") : nearbyVisible ? t("Skrýt podniky") : t("Najít podniky poblíž")}
        </button>
        {locateError && <p className="btcmap-error">{locateError}</p>}
      </div>
    </div>
  );
}
