// Predator Watch front end. Plain ES module, no build step.
/* global maplibregl */

const BASEMAPS = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};
const CATEGORY_ORDER = ["wolf-activity", "wolf-management", "context"];
const PRECISION_TEXT = {
  "hex-cell": "Generalized hexagon cell chosen by the agency",
  "pack-territory": "Generalized pack area drawn by the agency",
  "distribution-area": "Generalized distribution area",
  "management-unit": "Management or regulatory boundary",
  "incident-perimeter": "Mapped incident perimeter",
  "alert-area": "Alert area",
  exact: "As published",
};

const $ = (s, el = document) => el.querySelector(s);
const statusEl = $("#status");
const layers = new Map(); // id -> { info, data, loaded, visible }

// ------------------------------------------------------------------ helpers
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const safeUrl = (u) => (/^https:\/\//i.test(String(u ?? "")) ? String(u) : null);

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
function fmtTime(iso, precision = "instant") {
  if (!iso) return "Not published";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Not published";
  if (precision === "year") return String(d.getUTCFullYear());
  if (precision === "month") return d.toLocaleDateString(undefined, { year: "numeric", month: "long", timeZone: "UTC" });
  if (precision === "day") return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}
function ago(iso) {
  if (!iso) return null;
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return null;
  if (s < 90) return "just now";
  const m = s / 60; if (m < 90) return `${Math.round(m)} min ago`;
  const h = m / 60; if (h < 36) return `${Math.round(h)} h ago`;
  const d = h / 24; if (d < 60) return `${Math.round(d)} days ago`;
  const mo = d / 30.4; if (mo < 24) return `${Math.round(mo)} months ago`;
  return `${Math.round(d / 365)} years ago`;
}

/** Freshness badges for a source. */
function badges(layer) {
  const out = [];
  const st = layer.status || {};
  if (layer.type === "raster") {
    out.push({ cls: "ok", text: "Live agency service", title: "Rendered by the agency's map service on request." });
    return out;
  }
  if (layer.saved_at) out.push({ cls: "warn", text: "Saved copy (offline)", title: `No connection. Showing the copy saved on this device ${fmtTime(layer.saved_at)}.` });
  if (st.state === "never") out.push({ cls: "warn", text: "Loading…", title: "Not fetched yet." });
  if (st.state === "fixture") out.push({ cls: "warn", text: "Sample data", title: "The agency could not be reached; showing a bundled sample." });
  if (st.failures > 1) {
    out.push({ cls: "err", text: `Refresh failing (${st.failures} in a row)`, title: `Last error ${fmtTime(st.last_error_at)}: ${st.error || "unknown"}. Showing the last good copy.` });
  } else if (st.state === "error" || st.failures === 1) {
    out.push({ cls: "err", text: "Last check failed", title: st.error || "" });
  }
  if (st.overdue) out.push({ cls: "warn", text: "Refresh overdue", title: `Not checked since ${fmtTime(st.checked_at)}. See the status page.` });
  if (st.source_updated_at) {
    const ageDays = (Date.now() - Date.parse(st.source_updated_at)) / 864e5;
    out.push({
      cls: ageDays <= 2 ? "ok" : ageDays <= 60 ? "warn" : "old",
      text: `Agency updated ${ago(st.source_updated_at)}`,
      title: `Agency last updated: ${fmtTime(st.source_updated_at)}`,
    });
  } else if (st.received_at) {
    out.push({
      cls: "old",
      text: "Agency update date not published",
      title: `This service does not publish an edit date. Last received: ${fmtTime(st.received_at)}`,
    });
  }
  if (st.checked_at) out.push({ cls: "old", text: `Checked ${ago(st.checked_at)}`, title: `Last checked with the agency: ${fmtTime(st.checked_at)}` });
  return out;
}

// ------------------------------------------------------------ URL state
// The address bar holds the view and the visible layers, so a link opens
// the same map: #map=zoom/lat/lon&layers=id1,id2
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const m = (h.get("map") || "").split("/").map(Number);
  let view = null;
  if (m.length === 3 && m.every(Number.isFinite) && Math.abs(m[1]) <= 85) {
    const lon = ((((m[2] + 180) % 360) + 360) % 360) - 180;
    view = { zoom: Math.min(15, Math.max(2, m[0])), center: [lon, m[1]] };
  }
  const ls = h.get("layers");
  const ids = ls === null ? null : new Set(ls.split(",").filter((x) => /^[a-z0-9-]{3,64}$/.test(x)));
  return { view, ids };
}
const initial = readHash();
let hashTimer = 0;
function writeHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    const c = map.getCenter().wrap();
    const vis = [...layers.values()].filter((l) => l.visible).map((l) => l.id).join(",");
    const h = `#map=${map.getZoom().toFixed(2)}/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}&layers=${vis}`;
    if (h !== location.hash) history.replaceState(null, "", h);
  }, 250);
}

// ----------------------------------------------------------------- theme
const THEME_KEY = "pw-theme";
const prefersDark = matchMedia("(prefers-color-scheme: dark)");
function storedTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}
function currentTheme() {
  const t = storedTheme();
  return t === "dark" || t === "light" ? t : prefersDark.matches ? "dark" : "light";
}
document.documentElement.dataset.theme = currentTheme();

// --------------------------------------------------------------- map setup
const map = new maplibregl.Map({
  container: "map",
  style: BASEMAPS[currentTheme()],
  center: initial.view?.center ?? [-111, 42],
  zoom: initial.view?.zoom ?? (window.innerWidth < 760 ? 2.6 : 3.6),
  minZoom: 2,
  maxZoom: 15,
  attributionControl: false,
  cooperativeGestures: false,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-left");
map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-left");
map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
// Start the credits collapsed on small screens so they do not cover the map;
// the (i) button still opens them. MapLibre re-opens the box whenever the
// credits change, so keep it closed until the reader opens it.
let creditsTouched = false;
document.addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.closest(".maplibregl-ctrl-attrib-button")) creditsTouched = true;
});
map.on("idle", () => {
  if (creditsTouched || window.innerWidth >= 760) return;
  const el = document.querySelector(".maplibregl-ctrl-attrib");
  el?.classList.remove("maplibregl-compact-show");
  el?.removeAttribute("open");
});
if ("geolocation" in navigator) {
  map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false, showAccuracyCircle: false }), "top-left");
}

function firstSymbolLayer() {
  return map.getStyle().layers.find((l) => l.type === "symbol")?.id;
}

// ------------------------------------------------------------- data layers
function addVector(layer) {
  const id = layer.id;
  const s = layer.style;
  map.addSource(id, { type: "geojson", data: layer.data, attribution: esc(layer.attribution) });
  const before = firstSymbolLayer();
  const vis = layer.visible ? "visible" : "none";
  map.addLayer({
    id: `${id}-fill`, type: "fill", source: id, filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
    layout: { visibility: vis },
    paint: { "fill-color": s.color, "fill-opacity": s.fillOpacity ?? 0.2 },
  }, before);
  map.addLayer({
    id: `${id}-line`, type: "line", source: id, filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon", "LineString", "MultiLineString"]]],
    layout: { visibility: vis, "line-join": "round" },
    paint: { "line-color": s.color, "line-width": s.dashed ? 1.5 : 2, ...(s.dashed ? { "line-dasharray": [3, 2] } : {}) },
  }, before);
  map.addLayer({
    id: `${id}-circle`, type: "circle", source: id, filter: ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]],
    layout: { visibility: vis },
    paint: { "circle-color": s.color, "circle-radius": 5, "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 },
  }, before);
  if (hoverBound.has(id)) return;
  hoverBound.add(id);
  for (const suffix of ["fill", "circle"]) {
    map.on("mouseenter", `${id}-${suffix}`, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", `${id}-${suffix}`, () => (map.getCanvas().style.cursor = ""));
  }
}
const hoverBound = new Set();

function addRaster(layer) {
  const before = map.getLayer(firstVectorLayerId()) ? firstVectorLayerId() : firstSymbolLayer();
  if (layer.vector) {
    // Agency vector tiles drawn as a light fill with an outline.
    map.addSource(layer.id, {
      type: "vector", tiles: layer.tiles, minzoom: 0, maxzoom: layer.maxzoom ?? 14, attribution: esc(layer.attribution),
    });
    map.addLayer({
      id: `${layer.id}-raster`, type: "fill", source: layer.id, "source-layer": layer.vector.source_layer,
      minzoom: layer.minzoom ?? 0,
      layout: { visibility: layer.visible ? "visible" : "none" },
      paint: { "fill-color": layer.color, "fill-opacity": layer.vector.fill_opacity, "fill-outline-color": layer.vector.outline },
    }, before);
    return;
  }
  map.addSource(layer.id, {
    type: "raster", tiles: layer.tiles, tileSize: layer.tileSize,
    minzoom: layer.minzoom ?? 0, maxzoom: layer.maxzoom ?? 22, attribution: esc(layer.attribution),
  });
  map.addLayer({
    id: `${layer.id}-raster`, type: "raster", source: layer.id,
    minzoom: layer.minzoom ?? 0,
    layout: { visibility: layer.visible ? "visible" : "none" },
    paint: { "raster-opacity": layer.opacity },
  }, map.getLayer(firstVectorLayerId()) ? firstVectorLayerId() : firstSymbolLayer());
}
function firstVectorLayerId() {
  return map.getStyle().layers.find((l) => /-(fill|line|circle)$/.test(l.id) && layers.has(l.id.replace(/-(fill|line|circle)$/, "")))?.id;
}

function setVisible(layer, on) {
  layer.visible = on;
  const ids = layer.type === "raster" ? [`${layer.id}-raster`] : ["fill", "line", "circle"].map((x) => `${layer.id}-${x}`);
  for (const lid of ids) if (map.getLayer(lid)) map.setLayoutProperty(lid, "visibility", on ? "visible" : "none");
  if (on && layer.type === "geojson" && !layer.loaded) loadVector(layer);
  if (on && layer.type === "raster" && !map.getSource(layer.id)) addRaster(layer);
  updateItems();
  renderLegend();
  writeHash();
}

async function fetchWithTimeout(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal });
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "timed out" : e.message || String(e));
  } finally {
    clearTimeout(t);
  }
}

async function loadVector(layer) {
  layer.loaded = "loading";
  try {
    const res = await fetchWithTimeout(layer.data_url, 25000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fc = await res.json();
    layer.data = fc;
    layer.status = fc.metadata;
    layer.saved_at = res.headers.get("x-pw-saved-at");
    layer.loaded = true;
    if (map.getSource(layer.id)) map.getSource(layer.id).setData(fc);
    else addVector(layer);
  } catch (e) {
    layer.loaded = false;
    layer.status = { ...(layer.status || {}), state: "error", error: String(e.message || e) };
  }
  renderLayerRow(layer);
  updateItems();
}

// ---------------------------------------------------------------- panel UI
function renderLayerRow(layer) {
  const li = document.getElementById(`row-${layer.id}`);
  if (!li) return;
  const s = layer.style || { color: layer.color, fillOpacity: 0.4 };
  const inputId = `toggle-${layer.id}`;
  const infoUrl = safeUrl(layer.info_url);
  const endpoint = safeUrl(layer.url || layer.legend_url);
  const count = layer.status?.feature_count;
  li.innerHTML = `
    <div class="layer-row">
      <input type="checkbox" id="${inputId}" ${layer.visible ? "checked" : ""} aria-describedby="badges-${layer.id}">
      <span class="swatch ${s.dashed ? "dashed" : ""}" style="border-color:${esc(s.color)};background:${s.dashed || !s.fillOpacity ? "transparent" : esc(s.color) + "55"}" aria-hidden="true"></span>
      <label for="${inputId}">
        <span class="layer-name">${esc(layer.name)}</span>
        <span class="layer-agency">${esc(layer.agency)}${layer.species ? ` · ${esc(layer.species)}` : ""}</span>
      </label>
    </div>
    <div class="badges" id="badges-${layer.id}">
      ${badges(layer).map((b) => `<span class="badge ${b.cls}" title="${esc(b.title)}">${esc(b.text)}</span>`).join("")}
    </div>
    <details>
      <summary>About this source</summary>
      <dl>
        <dt>Publisher</dt><dd>${esc(layer.attribution)}</dd>
        <dt>Updates</dt><dd>${esc(layer.cadence)}</dd>
        ${layer.precision ? `<dt>Precision</dt><dd>${esc(PRECISION_TEXT[layer.precision] || layer.precision)}</dd>` : ""}
        ${typeof count === "number" && layer.type === "geojson" ? `<dt>Items</dt><dd>${count}</dd>` : ""}
        <dt>Terms</dt><dd>${esc(layer.license)}</dd>
        ${layer.notes ? `<dt>Notes</dt><dd>${esc(layer.notes)}</dd>` : ""}
        ${infoUrl ? `<dt>Agency page</dt><dd><a href="${esc(infoUrl)}" target="_blank" rel="noopener">Open<span class="sr-only"> (new tab)</span></a></dd>` : ""}
        ${endpoint ? `<dt>Endpoint</dt><dd><a href="${esc(endpoint)}" target="_blank" rel="noopener">Service</a></dd>` : ""}
        ${layer.type === "geojson" ? `<dt>Download</dt><dd class="exports">
          <a href="${esc(layer.data_url)}.geojson" download>GeoJSON</a>
          <a href="${esc(layer.data_url)}.kml" download>KML</a>
          <a href="${esc(layer.data_url)}.csv" download>CSV</a>
          <a href="/ogc/collections/${esc(layer.id)}/items" target="_blank" rel="noopener">OGC API</a></dd>` : ""}
        ${layer.type === "geojson" ? `<dt>Recent changes</dt><dd>${changesHtml(changesBySource.get(layer.id), 3)}</dd>` : ""}
      </dl>
    </details>`;
  li.querySelector("input").addEventListener("change", (e) => setVisible(layer, e.target.checked));
}

function renderPanel(all) {
  for (const cat of CATEGORY_ORDER) {
    const ul = document.querySelector(`.layer-list[data-category="${cat}"]`);
    ul.innerHTML = "";
    all.filter((l) => l.category === cat)
      .sort((a, b) => (b.style?.order ?? 0) - (a.style?.order ?? 0))
      .forEach((l) => {
        const li = document.createElement("li");
        li.className = "layer";
        li.id = `row-${l.id}`;
        ul.appendChild(li);
        renderLayerRow(l);
      });
  }
}

// ------------------------------------------------------- feature details
function featureHtml(p, layer) {
  const details = Object.entries(p.details || {})
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => {
      const u = safeUrl(v);
      return `<dt>${esc(k)}</dt><dd>${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">Open</a>` : esc(v)}</dd>`;
    }).join("");
  const url = safeUrl(p.url);
  return `<article class="feature">
    <h3>${esc(p.label)}</h3>
    <dl>
      ${p.species ? `<dt>Species</dt><dd>${esc(p.species)}</dd>` : ""}
      <dt>Source</dt><dd>${esc(p.source_name)}</dd>
      <dt>Agency</dt><dd>${esc(p.agency)}</dd>
      <dt>Observed</dt><dd>${esc(fmtTime(p.observed_at, p.observed_at_precision))}${p.observed_at_precision === "dataset" && p.observed_at ? " (layer last updated)" : ""}</dd>
      <dt>Received</dt><dd>${esc(fmtTime(p.received_at))}</dd>
      <dt>Precision</dt><dd>${esc(PRECISION_TEXT[p.precision] || p.precision)}</dd>
      ${details}
      <dt>Terms</dt><dd>${esc(p.license)}</dd>
      ${url ? `<dt>More</dt><dd><a href="${esc(url)}" target="_blank" rel="noopener">Agency page</a></dd>` : ""}
    </dl>
    ${layer?.status?.state === "fixture" ? `<p class="note">Sample data: the agency could not be reached when this was loaded.</p>` : ""}
    <p class="note">Attribution: ${esc(p.attribution)}</p>
  </article>`;
}

const detailsEl = $("#details");
let lastFocus = null;
function showDetails(features) {
  if (!features.length) return;
  lastFocus = document.activeElement;
  $("#details-title").textContent = features.length > 1 ? `${features.length} items here` : "Details";
  $("#details-body").innerHTML = features.map((f) => featureHtml(f.properties, layers.get(f.properties.source_id))).join("");
  detailsEl.hidden = false;
  $("#details-close").focus();
}
function hideDetails() {
  detailsEl.hidden = true;
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}
$("#details-close").addEventListener("click", hideDetails);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !detailsEl.hidden) hideDetails(); });

map.on("click", (e) => {
  const ids = [...layers.values()].filter((l) => l.type === "geojson" && l.visible && l.loaded === true)
    .flatMap((l) => [`${l.id}-fill`, `${l.id}-circle`]).filter((id) => map.getLayer(id));
  const hits = map.queryRenderedFeatures(e.point, { layers: ids });
  const seen = new Set();
  const unique = hits.filter((f) => { const k = f.properties.id; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((f) => ({ properties: { ...f.properties, details: parseMaybe(f.properties.details) } }));
  if (unique.length) showDetails(unique.slice(0, 8));
});
function parseMaybe(v) {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return {}; }
}

// ------------------------------------------------------- items in view
function bboxOf(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === "number") { minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]); minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]); }
    else c.forEach(walk);
  };
  if (geom) walk(geom.coordinates);
  return [minX, minY, maxX, maxY];
}
/** True when a feature bbox overlaps the view, including across the antimeridian. */
function inView(bb, b) {
  const [x0, y0, x1, y1] = bb;
  if (y1 < b.getSouth() || y0 > b.getNorth()) return false;
  const w = b.getWest(), e = b.getEast();
  if (e - w >= 360) return true;
  for (const shift of [-360, 0, 360]) if (!(x1 + shift < w || x0 + shift > e)) return true;
  return false;
}
function updateItems() {
  const ul = $("#items");
  const b = map.getBounds();
  const items = [];
  for (const l of layers.values()) {
    if (l.category !== "wolf-activity" || !l.visible || l.loaded !== true) continue;
    for (const f of l.data.features) {
      if (!f.geometry) continue;
      f._bbox ??= bboxOf(f.geometry);
      if (!inView(f._bbox, b)) continue;
      items.push(f);
    }
  }
  items.sort((a, z) => String(z.properties.observed_at).localeCompare(String(a.properties.observed_at)));
  const shown = items.slice(0, 40);
  ul.innerHTML = shown.length ? "" : `<li class="hint">No wolf activity items in this view.</li>`;
  for (const f of shown) {
    const p = f.properties;
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "item-btn";
    btn.innerHTML = `${esc(p.label)}<small>${esc(p.agency)} · observed ${esc(fmtTime(p.observed_at, p.observed_at_precision))}</small>`;
    btn.addEventListener("click", () => {
      const [x0, y0, x1, y1] = f._bbox;
      map.fitBounds([[x0, y0], [x1, y1]], { padding: 80, maxZoom: 8, duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 600 });
      showDetails([f]);
    });
    li.appendChild(btn);
    ul.appendChild(li);
  }
  if (items.length > shown.length) {
    const li = document.createElement("li");
    li.className = "hint";
    li.textContent = `${items.length - shown.length} more; zoom in to narrow the list.`;
    ul.appendChild(li);
  }
}
map.on("moveend", () => { updateItems(); writeHash(); });

// ------------------------------------------------------------ panel toggle
const panel = $("#panel");
const toggle = $("#panel-toggle");
toggle.addEventListener("click", () => {
  const open = panel.hidden;
  panel.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  map.resize();
});
const about = $("#about");
$("#about-open").addEventListener("click", () => about.showModal());

// ------------------------------------------------------------------ boot
async function boot() {
  let index;
  let savedAt = null;
  try {
    const res = await fetchWithTimeout("/api/layers", 20000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    savedAt = res.headers.get("x-pw-saved-at");
    index = await res.json();
  } catch (e) {
    statusEl.textContent = "Could not load the layer list. Check your connection and reload.";
    return;
  }
  for (const l of index.layers) {
    const visible = initial.ids ? initial.ids.has(l.id) : Boolean(l.style?.defaultVisible);
    layers.set(l.id, { ...l, visible, loaded: false });
  }
  renderPanel([...layers.values()]);
  renderPlanned(index);
  const vectors = [...layers.values()].filter((l) => l.type === "geojson");
  statusEl.textContent = savedAt
    ? `Offline. Showing the layer list saved on this device ${fmtTime(savedAt)}.`
    : `${vectors.length} agency data layers and ${layers.size - vectors.length} live agency map services. Times shown in ${tz}.`;
  loadChanges();
  const start = () => {
    for (const l of layers.values()) if (l.visible) setVisible(l, true);
    renderLegend();
  };
  if (map.isStyleLoaded()) start(); else map.once("load", start);
}

// ------------------------------------------------------------ changes feed
const changesBySource = new Map();
function changeSummary(c) {
  const parts = [];
  if (c.added) parts.push(`${c.added} added`);
  if (c.removed) parts.push(`${c.removed} removed`);
  if (c.modified) parts.push(`${c.modified} changed`);
  return parts.join(", ") || "no item changes";
}
function changesHtml(list, n) {
  if (!list || !list.length) return "None recorded yet.";
  return `<ul class="changes">${list.slice(0, n).map((c) => {
    const names = [...(c.added_items || []), ...(c.modified_items || [])].slice(0, 3).map((i) => esc(i.label)).join("; ");
    return `<li><time datetime="${esc(c.at)}" title="${esc(fmtTime(c.at))}">${esc(ago(c.at) || fmtTime(c.at))}</time>: ${esc(changeSummary(c))}${names ? `<br><small>${names}</small>` : ""}</li>`;
  }).join("")}</ul>`;
}
async function loadChanges() {
  const ul = $("#changes-feed");
  try {
    const res = await fetchWithTimeout("/api/changes", 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const all = [];
    for (const s of body.sources || []) {
      changesBySource.set(s.source_id, s.changes || []);
      for (const c of s.changes || []) all.push({ ...c, source_id: s.source_id });
      const layer = layers.get(s.source_id);
      if (layer) renderLayerRow(layer);
    }
    all.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    ul.innerHTML = all.length ? "" : `<li class="hint">No changes recorded since tracking began. Changes appear here after an agency updates a layer.</li>`;
    for (const c of all.slice(0, 8)) {
      const l = layers.get(c.source_id);
      const li = document.createElement("li");
      li.innerHTML = `<strong>${esc(l?.name || c.source_id)}</strong> <span class="layer-agency">${esc(l?.agency || "")}</span>
        <span>${esc(changeSummary(c))} · <time datetime="${esc(c.at)}" title="${esc(fmtTime(c.at))}">${esc(ago(c.at) || "")}</time></span>`;
      ul.appendChild(li);
    }
  } catch {
    ul.innerHTML = `<li class="hint">Change history is not available right now.</li>`;
  }
}

// ----------------------------------------------------------------- planned
function renderPlanned(index) {
  const ul = $("#planned-list");
  const items = [
    ...(index.planned || []).map((p) => ({ name: p.name, text: p.description, url: p.doc_url })),
    ...(index.planned_sources || []).map((p) => ({ name: `${p.name} (${p.agency})`, text: p.reason, url: p.url })),
  ];
  ul.innerHTML = items.map((p) => {
    const u = safeUrl(p.url);
    return `<li><strong>${esc(p.name)}</strong> <span class="tag">Planned</span><br>${esc(p.text)}${u ? ` <a href="${esc(u)}" target="_blank" rel="noopener">Link<span class="sr-only"> (new tab)</span></a>` : ""}</li>`;
  }).join("");
}

// ------------------------------------------------------------------ legend
function renderLegend() {
  const ul = $("#legend-list");
  const vis = [...layers.values()].filter((l) => l.visible)
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
  ul.innerHTML = vis.length ? vis.map((l) => {
    const s = l.style || { color: l.color, fillOpacity: 0.4 };
    const bg = s.dashed || !s.fillOpacity ? "transparent" : `${esc(s.color)}55`;
    const zoomNote = l.minzoom && map.getZoom() < l.minzoom ? ` <small>(zoom in to see)</small>` : "";
    return `<li><span class="swatch ${s.dashed ? "dashed" : ""}" style="border-color:${esc(s.color)};background:${bg}" aria-hidden="true"></span>${esc(l.name)}${zoomNote}</li>`;
  }).join("") : `<li class="hint">No layers turned on.</li>`;
}
map.on("zoomend", renderLegend);
if (window.innerWidth < 760) $("#legend").removeAttribute("open");

// ------------------------------------------------------------------ search
// search.js is loaded on first use. Suggestions come from a local Census
// Gazetteer index (debounced, 2+ characters); street addresses are looked up
// on the server only when the form is submitted.
const searchForm = $("#search");
const searchInput = $("#search-q");
const searchOut = $("#search-results");
let searchMarker = null;
let searchMod = null;
const loadSearch = () => (searchMod ??= import("/search.js"));
function goTo(r) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  map.flyTo({ center: [r.lon, r.lat], zoom: r.zoom ?? 10, duration: reduce ? 0 : 800 });
  searchMarker?.remove();
  searchMarker = new maplibregl.Marker({ color: "#0050b3" }).setLngLat([r.lon, r.lat]).addTo(map);
  searchOut.innerHTML = `<li class="hint">Showing ${esc(r.name)}.</li>`;
}
function showResults(results, note) {
  searchOut.innerHTML = "";
  for (const r of results) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "item-btn";
    btn.innerHTML = `${esc(r.name)}${r.kind ? `<small>${esc(r.kind)}</small>` : ""}`;
    btn.addEventListener("click", () => goTo(r));
    li.appendChild(btn);
    searchOut.appendChild(li);
  }
  if (note) {
    const li = document.createElement("li");
    li.className = "hint";
    li.textContent = note;
    searchOut.appendChild(li);
  }
}
const GAZ_NOTE = "Places, counties and ZIP codes: U.S. Census Bureau Gazetteer.";
let searchSeq = 0;
async function suggest(q) {
  const seq = ++searchSeq;
  const m = await loadSearch();
  if (m.parseLatLon(q) || m.looksLikeAddress(q) || q.trim().length < 2) return;
  try {
    const results = await m.searchLocal(q);
    if (seq !== searchSeq) return;
    if (results.length) showResults(results, GAZ_NOTE);
    else searchOut.innerHTML = `<li class="hint">No matching place. Try a town, county, ZIP code, street address, or “44.5, -110.5”.</li>`;
  } catch {
    if (seq === searchSeq) searchOut.innerHTML = `<li class="hint">Place search could not load. Check your connection.</li>`;
  }
}
let suggestTimer = 0;
searchInput.addEventListener("focus", () => loadSearch(), { once: true });
searchInput.addEventListener("input", () => {
  clearTimeout(suggestTimer);
  const q = searchInput.value;
  if (q.trim().length < 2) { searchOut.innerHTML = ""; return; }
  suggestTimer = setTimeout(() => suggest(q), 250);
});
searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearTimeout(suggestTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) return;
  const m = await loadSearch();
  const ll = m.parseLatLon(q);
  if (ll) return goTo(ll);
  const seq = ++searchSeq;
  if (m.looksLikeAddress(q)) {
    searchOut.innerHTML = `<li class="hint">Looking up the address…</li>`;
    try {
      const r = await m.searchAddress(q);
      if (seq !== searchSeq) return;
      if (r.busy) { searchOut.innerHTML = `<li class="hint">Address search is busy. Try again in a few seconds.</li>`; return; }
      if (!r.results.length) { searchOut.innerHTML = `<li class="hint">No match for that address. Try adding the town and state.</li>`; return; }
      if (r.results.length === 1) { goTo(r.results[0]); return; }
      showResults(r.results, r.attribution);
    } catch {
      searchOut.innerHTML = `<li class="hint">Address search is not available right now. Try a town, county or ZIP code.</li>`;
    }
    return;
  }
  try {
    const results = await m.searchLocal(q);
    if (seq !== searchSeq) return;
    if (results.length) goTo(results[0]);
    else searchOut.innerHTML = `<li class="hint">No matching place. Try a town, county, ZIP code, street address, or “44.5, -110.5”.</li>`;
  } catch {
    searchOut.innerHTML = `<li class="hint">Place search could not load. Check your connection.</li>`;
  }
});

// ------------------------------------------------------- first-visit hint
// Shown once per browser. Not modal: the map stays usable behind it.
{
  const hint = $("#first-hint");
  const KEY = "pw-hint-dismissed";
  let seen = false;
  try { seen = localStorage.getItem(KEY) === "1"; } catch {}
  if (!seen && !initial.view) {
    hint.hidden = false;
    const close = () => {
      hint.hidden = true;
      try { localStorage.setItem(KEY, "1"); } catch {}
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (e) => { if (e.key === "Escape" && !hint.hidden) close(); };
    $("#first-hint-close").addEventListener("click", () => { close(); $("#map").focus(); });
    document.addEventListener("keydown", onKey);
  }
}

// ------------------------------------------------------------- dark mode
const themeBtn = $("#theme-toggle");
function syncThemeButton() {
  const dark = currentTheme() === "dark";
  themeBtn.setAttribute("aria-pressed", String(dark));
  themeBtn.textContent = dark ? "Light map" : "Dark map";
  document.querySelector('meta[name="theme-color"]').setAttribute("content", dark ? "#0f1a14" : "#1d3b2a");
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  syncThemeButton();
  // Swap the basemap, then put the agency layers back in their places.
  map.setStyle(BASEMAPS[theme], { diff: false });
  map.once("style.load", () => {
    for (const l of layers.values()) {
      if (l.type === "raster" && l.visible) addRaster(l);
      if (l.type === "geojson" && l.loaded === true) addVector(l);
    }
  });
}
themeBtn.addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
  applyTheme(next);
});
prefersDark.addEventListener("change", () => { if (!storedTheme()) applyTheme(currentTheme()); });
syncThemeButton();

// ------------------------------------------------------------- share link
$("#share-link").addEventListener("click", async () => {
  writeHash();
  await new Promise((r) => setTimeout(r, 300));
  const msg = $("#share-status");
  try {
    await navigator.clipboard.writeText(location.href);
    msg.textContent = "Link copied. It opens this view with these layers.";
  } catch {
    msg.textContent = `Copy this link: ${location.href}`;
  }
});
window.addEventListener("hashchange", () => {
  const h = readHash();
  if (h.view) map.jumpTo(h.view);
  if (h.ids) for (const l of layers.values()) if (h.ids.has(l.id) !== l.visible) { setVisible(l, h.ids.has(l.id)); renderLayerRow(l); }
});

// ---------------------------------------------------------- offline cache
// sw.js keeps the last good copy of the layer list and agency data on this
// device, so the map still opens with a weak or missing connection.
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

boot();
