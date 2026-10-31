// Predator Watch front end. Plain ES module, no build step.
/* global maplibregl */

const BASEMAP = "https://tiles.openfreemap.org/styles/positron";
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
  if (st.state === "never") out.push({ cls: "warn", text: "Loading…", title: "Not fetched yet." });
  if (st.state === "fixture") out.push({ cls: "warn", text: "Sample data", title: "The agency could not be reached; showing a bundled sample." });
  if (st.state === "error") out.push({ cls: "err", text: "Last check failed", title: st.error || "" });
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

// --------------------------------------------------------------- map setup
const map = new maplibregl.Map({
  container: "map",
  style: BASEMAP,
  center: [-111, 42],
  zoom: window.innerWidth < 760 ? 2.6 : 3.6,
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
  for (const suffix of ["fill", "circle"]) {
    map.on("mouseenter", `${id}-${suffix}`, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", `${id}-${suffix}`, () => (map.getCanvas().style.cursor = ""));
  }
}

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
}

async function loadVector(layer) {
  layer.loaded = "loading";
  try {
    const res = await fetch(layer.data_url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fc = await res.json();
    layer.data = fc;
    layer.status = fc.metadata;
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
function updateItems() {
  const ul = $("#items");
  const b = map.getBounds();
  const items = [];
  for (const l of layers.values()) {
    if (l.category !== "wolf-activity" || !l.visible || l.loaded !== true) continue;
    for (const f of l.data.features) {
      if (!f.geometry) continue;
      f._bbox ??= bboxOf(f.geometry);
      const [x0, y0, x1, y1] = f._bbox;
      if (x1 < b.getWest() || x0 > b.getEast() || y1 < b.getSouth() || y0 > b.getNorth()) continue;
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
map.on("moveend", updateItems);

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
  try {
    const res = await fetch("/api/layers");
    index = await res.json();
  } catch (e) {
    statusEl.textContent = "Could not load the layer list. Please try again shortly.";
    return;
  }
  for (const l of index.layers) {
    layers.set(l.id, { ...l, visible: Boolean(l.style?.defaultVisible), loaded: false });
  }
  renderPanel([...layers.values()]);
  const vectors = [...layers.values()].filter((l) => l.type === "geojson");
  statusEl.textContent = `${vectors.length} agency data layers and ${layers.size - vectors.length} live agency map services. Times shown in ${tz}.`;
  const start = () => {
    for (const l of layers.values()) if (l.visible) setVisible(l, true);
  };
  if (map.isStyleLoaded()) start(); else map.once("load", start);
}
boot();
