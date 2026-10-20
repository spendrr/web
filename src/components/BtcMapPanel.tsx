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

// Nahrazuje dřívější L.circleMarker (Canvas-rendered tečka) — clustering
// (viz níže) potřebuje skutečné L.Marker instance, CircleMarker s ním
// nefunguje (markercluster interně volá marker.setIcon() atd.). Jeden sdílený
// DivIcon pro všechny podniky, stylovaný přes .btcmap-marker-dot v
// BtcMapPanel.css (--accent výplň, --border obrys) — stejný vzhled jako
// dřívější tečka, jen jako skutečný (byť malý) DOM prvek místo Canvas pixelu.
const businessIcon = L.divIcon({
  className: "btcmap-marker-dot",
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

// Velikost bubliny roste v pár skocích s počtem podniků uvnitř — čistě
// vizuální odstupňování (žádná jiná logika se na velikosti nezakládá), aby
// shluk s 60 podniky nevypadal stejně jako shluk se 3.
function clusterIcon(count: number): L.DivIcon {
  const size = count >= 50 ? 44 : count >= 10 ? 38 : 32;
  return L.divIcon({
    html: `<span>${count}</span>`,
    className: "btcmap-cluster-icon",
    iconSize: [size, size],
  });
}

// Praha — appka je česká, tohle je jen výchozí pohled než uživatel použije
// geolokaci nebo mapu sám posune.
const DEFAULT_CENTER: L.LatLngTuple = [50.0755, 14.4378];
const DEFAULT_ZOOM = 13;
// Bylo 15 — na tak těsném výřezu (pár bloků) je snadné trefit místo bez
// jediného podniku v datasetu, i v rozumně pokryté oblasti. 13 ukáže širší
// okolí hned po lokalizaci, blíž tomu, co uživatel čeká pod "poblíž".
const GEOLOCATE_ZOOM = 13;
// Bylo 10 — pořád moc brzo, uživatel chtěl vidět třeba celé Česko naráz
// (~6.8° na šířku). worker/btcmap.ts teď dovoluje bbox až MAX_BBOX_SPAN_DEG
// = 12°, což na výšku mapy odpovídá zoomu zhruba 6. Pod tím je viditelný
// výřez v podstatě kontinent a piny by byly jen náhodný vzorek, ne
// "podniky poblíž" v žádném smyslu.
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

// Krátké české popisky pro nejběžnější OSM tagy v datasetu — zbytek padá na
// syrovou hodnotu tagu (viz categoryLabel), což je čitelné i bez překladu
// (např. "car_repair").
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

// Popup obsah se skládá výhradně přes DOM API (createElement/textContent),
// nikdy přes innerHTML se string interpolací — `name`/`category` pochází ze
// syrových OSM tagů, které může upravit kdokoliv (btcmap.org čerpá přímo z
// OpenStreetMap), takže je to nedůvěryhodný vstup. fetch-guard.js chrání jen
// proti konkrétní rodině síťových prvků vložených přes innerHTML (link/a
// ping/meta refresh/script), ne proti obecnému <img onerror=...> stored XSS
// — jediná bezpečná cesta je DOM stavět ručně.
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
    // Syrová OSM opening_hours syntaxe (např. "Mo-Fr 08:00-18:00") — čitelné
    // i bez parsování, plný parser na formát by byl výrazně větší práce než
    // tenhle popup potřebuje.
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

// Jeden sjednocený vzhled pro všechny druhy plateb (dřív každý typ vlastní
// barvu pozadí/textu) — sladěno s appčiným vlastním jazykem tvrdých
// ohraničených "sticker" tagů (viz .big-action-btn/.utility-hub-card), ne
// s generickou barevnou pilulkou.
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

// Čte, jestli appka aktuálně vykresluje dark mode — stejná dvoukroková
// logika jako theme.ts's (neexportovaná) resolvedTheme(): explicitní
// data-theme na <html> (Settings) vyhrává, jinak OS preference. Duplikováno
// tady místo importu, aby BtcMapPanel.tsx nezávisel na theme.ts's interním
// stavu jen kvůli jednomu čtení atributu.
function getEffectiveTheme(): "light" | "dark" {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function tileUrlTemplate(theme: "light" | "dark"): string {
  return `/api/btcmap/tile/{z}/{x}/{y}.png${theme === "dark" ? "?style=dark" : ""}`;
}

function boundsToBbox(bounds: L.LatLngBounds): string {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  return `${sw.lng},${sw.lat},${ne.lng},${ne.lat}`;
}

async function fetchElementsInBbox(bbox: string): Promise<BtcMapElement[] | null> {
  try {
    const res = await fetch(`/api/btcmap/elements?bbox=${encodeURIComponent(bbox)}`);
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

// null = síťová/serverová chyba na prvním kroku, kde nemá smysl zkoušet dál.
// [] = i po nejširším výřezu opravdu nic (datová mezera, ne chyba).
async function fetchNearestElements(
  latlng: L.LatLngTuple,
): Promise<(BtcMapElement & { distanceM: number })[] | null> {
  for (const span of NEARBY_BBOX_STEPS_DEG) {
    const bbox = `${latlng[1] - span},${latlng[0] - span},${latlng[1] + span},${latlng[0] + span}`;
    const elements = await fetchElementsInBbox(bbox);
    if (elements === null) return null;
    if (elements.length > 0) {
      return elements
        .map((el) => ({ ...el, distanceM: distanceMeters(latlng, el) }))
        .sort((a, b) => a.distanceM - b.distanceM)
        .slice(0, NEARBY_COUNT);
    }
  }
  return [];
}

const NEARBY_COUNT = 10;
// Jeden pevný malý výřez (dřív jen 0.03°) uměl v řidčeji pokryté oblasti
// dopadnout prázdně, i když nejbližší podnik byl jen o kousek dál — uživatel
// pak viděl "v okolí nejsou žádné podniky" místo seznamu. Místo toho zkoušet
// postupně širší výřezy, dokud něco nenajdeme (nebo nedojdeme na
// MAX_BBOX_SPAN_DEG ve worker/btcmap.ts — poslední krok 6° na každou stranu
// dá bbox span 12°, přesně na hraně limitu).
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
  // null = žádný dotaz zatím neproběhl (tlačítko ještě nebylo použité),
  // [] = dotaz proběhl a v okolí nic není — dvě různé věci na zobrazení.
  const [nearby, setNearby] = useState<(BtcMapElement & { distanceM: number })[] | null>(null);
  // Odděleno od `nearby` samotného — tlačítko je přepínač zobrazit/skrýt.
  // Skrytí nemaže `nearby`, takže opětovné otevření po skrytí sice znovu
  // lokalizuje a přepíše data (poloha se mezitím mohla změnit), ale
  // nemusí čekat na čerstvou odpověď, aby vůbec něco ukázalo.
  const [nearbyVisible, setNearbyVisible] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = L.map(container).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    mapRef.current = map;
    const tiles = L.tileLayer(tileUrlTemplate(getEffectiveTheme()), {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> &copy; <a href="https://btcmap.org" target="_blank" rel="noopener noreferrer">BTC Map</a>',
      maxZoom: 19,
    }).addTo(map);
    // Nahrazuje dřívější prosté L.layerGroup() — v hustě pokryté oblasti
    // (centrum Prahy) se desítky teček v jednom bloku překrývaly a nešlo se
    // trefit na konkrétní podnik. Shlukuje blízké body do jednoho číselného
    // bublinu (.btcmap-cluster-icon), který se při kliknutí přiblíží/rozpadne.
    // Tohle je taky proč `preferCanvas` na mapě výše zmizelo — markercluster
    // pracuje se skutečnými L.Marker instancemi (potřebuje setIcon() atd.),
    // ne s Canvas-rendered CircleMarker, takže Canvas renderer tu už nemá co
    // dělat. Náhrada za původní obavu z DOM zátěže: v husté oblasti teď
    // vzniká jeden shlukový uzel místo desítek jednotlivých markerů, takže
    // reálný počet DOM uzlů je nižší, ne vyšší, než dřív.
    const markers = L.markerClusterGroup({
      iconCreateFunction: (cluster) => clusterIcon(cluster.getChildCount()),
    }).addTo(map);
    markersRef.current = markers;

    // Přepne dlaždice na tmavý/světlý styl při změně motivu, aniž by se
    // celá mapa musela znovu vytvářet — jak OS preference (system motiv),
    // tak ruční přepnutí v Settings (data-theme na <html>).
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
      const elements = await fetchElementsInBbox(bbox);
      // Zahodit odpověď, pokud mezitím proběhl novější dotaz (rychlé
      // posouvání mapy by jinak mohlo vykreslit zastaralá data přes nová) —
      // ta newer request si svůj vlastní loading/error stav dořeší sama.
      if (seq !== fetchSeqRef.current) return;
      clearLoadingBadgeTimer();
      setElementsLoading(false);
      if (!elements) {
        setElementsError(t("Nepodařilo se načíst podniky. Zkontroluj připojení."));
        return;
      }
      setElementsError(null);

      layer.clearLayers();
      // Sestavit pole a naráz zavolat addLayers() — markercluster tohle
      // dokáže vypočítat jedním průchodem, zatímco addTo() po jednom by pro
      // každý z až 200 markerů přepočítával shluky zvlášť.
      const newMarkers: L.Marker[] = [];
      for (const el of elements) {
        const marker = L.marker([el.lat, el.lon], { icon: businessIcon });
        // Popup content built lazily on click, not for every one of up to
        // 200 markers on every single redraw — this is what actually fixed
        // the map feeling laggy on a real phone; eagerly building ~200 tiny
        // DOM trees per pan/zoom (most of which the user never clicks) was
        // the real cost, not the marker rendering itself.
        marker.on("click", () => {
          // autoPan: false — jinak Leaflet po otevření popupu mapu jemně
          // posune, aby se popup vešel do výřezu, což vyvolá moveend →
          // scheduleFetch → za 400ms fetchElements() → layer.clearLayers(),
          // který smaže právě otevřený marker i s popupem. Uživatel to vidí
          // jako "okýnko po chvilce samo zmizí".
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
    // t je stabilní přes useCallback (viz i18n.ts) a mění se jen při reálné
    // změně jazyka — přeinicializovat celou mapu kvůli tomu je zbytečné,
    // popupy si čerstvý `t` stejně vyzvednou při dalším otevření.
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
          // bindPopup(string) je tu v pořádku (na rozdíl od buildPopupContent
          // pro OSM data výše) — "Jste tady" je pevný, appkou kontrolovaný
          // text, ne nedůvěryhodný vstup zvenčí.
          meMarkerRef.current = L.marker(latlng, { title: t("Jste tady"), icon: meIcon })
            .addTo(map)
            .bindPopup(t("Jste tady"));
        }

        // Samostatný dotaz kolem uživatele — nezávislý na mapou řízeném
        // fetchElements výše (ten reaguje na moveend/zoom a vrací max
        // MAX_RESULTS bodů z celého viditelného výřezu, ne konkrétně
        // "nejbližší"), aby "Najít podniky poblíž" spolehlivě ukázalo
        // seřazený seznam kartiček i těsně po prvním otevření mapy.
        // fetchNearestElements samo zkouší čím dál širší výřez, dokud něco
        // nenajde, takže řídce pokrytá oblast nedopadne rovnou na "v okolí
        // nejsou žádné podniky".
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
    // Přepínač: panel už je vidět → tenhle klik ho jen schová, bez nové
    // geolokace. Panel schovaný (i s daty z minula, i úplně bez dat) →
    // klik pokaždé lokalizuje znovu, viz handleLocate.
    if (nearbyVisible) {
      setNearbyVisible(false);
      return;
    }
    handleLocate();
  };

  // Netahá popup z existujícího markeru (mohl by mezitím zmizet, přestavět
  // se kvůli moveend fetchi, nebo být schovaný uvnitř shluku) — otevře
  // vlastní popup přímo, funguje spolehlivě bez ohledu na to, co se zrovna
  // děje s vrstvou pinů.
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
