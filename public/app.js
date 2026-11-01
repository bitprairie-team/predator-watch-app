// Predator Watch front end. Plain ES module, no build step.
/* global maplibregl */
import { creditGroups, swatchHtml, vectorPaint, vectorTilePaint } from "/layer-style.js";
import { NATIVE, api, apiFetch } from "/net.js";

const BASEMAPS = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};
const CATEGORY_ORDER = ["wolf-activity", "wolf-management", "bear", "context"];
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

// Simple view (default) or Expert view, set by /prefs.js on <html>.
const isSimple = () => document.documentElement.dataset.mode !== "expert";
/** Layer name for the current view: plain words in Simple view. */
const displayName = (l) => (isSimple() && l?.simple?.name) || l?.name || "";
let simpleGroups = [];

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
  const m = s / 60; if (m < 90) return `${Math.round(m)} ${Math.round(m) === 1 ? "minute" : "minutes"} ago`;
  const h = m / 60; if (h < 36) return `${Math.round(h)} ${Math.round(h) === 1 ? "hour" : "hours"} ago`;
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
  if (layer.loaded === "loading") out.push({ cls: "old", text: "Loading…", title: "Downloading this layer from the map's cache." });
  if (layer.loaded === false && layer.loadError) out.push({ cls: "err", text: "Could not load", title: `This browser could not download the layer (${layer.loadError}). Check the connection and retry.` });
  if (st.state === "never") out.push({ cls: "warn", text: "Waiting for first check", title: "The scheduled job has not fetched this source yet." });
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
    const h = `#map=${map.getZoom().toFixed(2)}/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}&layers=${vis}${isSimple() ? "" : "&mode=expert"}`;
    if (h !== location.hash) history.replaceState(null, "", h);
  }, 250);
}

// ----------------------------------------------------------------- theme
// /theme.js (BitPrairie's theme handling, "bp-theme" key) sets data-theme
// before first paint; the map follows it and swaps the basemap on change.
const THEME_KEY = "bp-theme";
function currentTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

// --------------------------------------------------------------- map setup
const PHONE_AT_START = matchMedia("(max-width: 760px)").matches;
// Rough extent of the layers that are on by default. The first view fits it,
// then fits the real data once it loads (see "view fitting" below).
const DEFAULT_DATA_BOUNDS = [[-124.8, 31.3], [-103.0, 49.1]];
// View-fitting state: autoView stays true until the person moves the map.
let autoView = !initial.view;
let autoBounds = DEFAULT_DATA_BOUNDS;
let lastPadKey = "";
const map = new maplibregl.Map({
  container: "map",
  style: BASEMAPS[currentTheme()],
  ...(initial.view
    ? { center: initial.view.center, zoom: initial.view.zoom }
    : { bounds: DEFAULT_DATA_BOUNDS, fitBoundsOptions: { padding: 24 } }),
  minZoom: 2,
  maxZoom: 15,
  attributionControl: false,
  cooperativeGestures: false,
});
// Phones: no compass and no touch rotation, so the control stack stays short
// and north stays up (there is no way to see or reset a rotation without it).
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false, showCompass: !PHONE_AT_START }), "top-left");
if (PHONE_AT_START) {
  map.touchZoomRotate.disableRotation();
  map.dragRotate.disable();
  map.keyboard.disableRotation();
}
map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-left");
// Credits are drawn by renderCredits() below, not MapLibre's control, so the
// basemap credit stays visible on every screen and agency credits are short.
const geoControl = "geolocation" in navigator ? new maplibregl.GeolocateControl({ trackUserLocation: false, showAccuracyCircle: false }) : null;
if (geoControl) map.addControl(geoControl, "top-left");

function firstSymbolLayer() {
  return map.getStyle().layers.find((l) => l.type === "symbol")?.id;
}

// ------------------------------------------------------------- data layers
function addVector(layer) {
  const id = layer.id;
  const s = layer.style || {};
  const paint = vectorPaint(layer, currentTheme());
  map.addSource(id, { type: "geojson", data: layer.data });
  const before = firstSymbolLayer();
  const vis = layer.visible ? "visible" : "none";
  map.addLayer({
    id: `${id}-fill`, type: "fill", source: id, filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
    layout: { visibility: vis },
    paint: paint.fill,
  }, before);
  map.addLayer({
    id: `${id}-line`, type: "line", source: id, filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon", "LineString", "MultiLineString"]]],
    layout: { visibility: vis, "line-join": "round" },
    paint: paint.line,
  }, before);
  map.addLayer({
    id: `${id}-circle`, type: "circle", source: id, filter: ["in", ["geometry-type"], ["literal", ["Point", "MultiPoint"]]],
    layout: { visibility: vis },
    paint: paint.circle,
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
      type: "vector", tiles: layer.tiles, minzoom: 0, maxzoom: layer.maxzoom ?? 14,
    });
    map.addLayer({
      id: `${layer.id}-raster`, type: "fill", source: layer.id, "source-layer": layer.vector.source_layer,
      minzoom: layer.minzoom ?? 0,
      layout: { visibility: layer.visible ? "visible" : "none" },
      paint: vectorTilePaint(layer),
    }, before);
    return;
  }
  map.addSource(layer.id, {
    type: "raster", tiles: layer.tiles, tileSize: layer.tileSize,
    minzoom: layer.minzoom ?? 0, maxzoom: layer.maxzoom ?? 22,
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

function setVisible(layer, on, { announce: say = false, quiet = false } = {}) {
  layer.visible = on;
  const ids = layer.type === "raster" ? [`${layer.id}-raster`] : ["fill", "line", "circle"].map((x) => `${layer.id}-${x}`);
  for (const lid of ids) if (map.getLayer(lid)) map.setLayoutProperty(lid, "visibility", on ? "visible" : "none");
  if (on && layer.type === "geojson" && !layer.loaded) loadVector(layer);
  if (on && layer.type === "raster" && !map.getSource(layer.id)) addRaster(layer);
  updateItems();
  renderLegend();
  renderCredits();
  writeHash();
  if (!quiet) updatePanelState();
  if (say) announce(`${displayName(layer)} turned ${on ? "on" : "off"}. ${countOn()}`);
}

async function fetchWithTimeout(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await apiFetch(url, { signal: ctl.signal });
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "timed out" : e.message || String(e));
  } finally {
    clearTimeout(t);
  }
}

async function loadVector(layer) {
  layer.loaded = "loading";
  layer.loadError = null;
  renderLayerRow(layer);
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
    layer.loadError = String(e.message || e);
  }
  renderLayerRow(layer);
  updateItems();
  renderCredits();
  renderOffline();
  scheduleListView();
  refineAutoView();
}

// ---------------------------------------------------------------- panel UI
function renderLayerRow(layer) {
  const li = document.getElementById(`row-${layer.id}`);
  if (!li) return;
  const inputId = `toggle-${layer.id}`;
  const infoUrl = safeUrl(layer.info_url);
  const endpoint = safeUrl(layer.url || layer.legend_url);
  const count = layer.status?.feature_count;
  // Re-rendering replaces the row; keep focus and the open "About" panel.
  const focusSel = li.contains(document.activeElement)
    ? (document.activeElement.matches("input") ? "input" : document.activeElement.matches("summary") ? "summary" : document.activeElement.matches(".retry") ? ".retry, input" : null)
    : null;
  const wasOpen = li.querySelector("details")?.open;
  const nm = esc(layer.name);
  if (isSimple()) {
    li.innerHTML = simpleRowHtml(layer, inputId);
    li.querySelector("input").addEventListener("change", (e) => setVisible(layer, e.target.checked, { announce: true }));
    li.querySelector(".retry")?.addEventListener("click", () => loadVector(layer));
    if (focusSel) li.querySelector("input")?.focus();
    return;
  }
  li.innerHTML = `
    <div class="layer-row">
      <span class="check"><input type="checkbox" id="${inputId}" ${layer.visible ? "checked" : ""} aria-describedby="badges-${layer.id}"><span class="check-box" aria-hidden="true"></span></span>
      ${swatchHtml(layer)}
      <label for="${inputId}">
        <span class="layer-name">${esc(layer.name)}</span>
        <span class="layer-agency">${esc(layer.agency)}${layer.species ? ` · ${esc(layer.species)}` : ""}</span>
      </label>
    </div>
    ${layer.summary ? `<p class="layer-summary">${esc(layer.summary)}</p>` : ""}
    ${layer.classes ? classLegendHtml(layer) : ""}
    <div class="badges" id="badges-${layer.id}">
      ${zoomedOut(layer) ? `<span class="badge warn">${esc(layer.zoom_hint || "Zoom in to see this layer")}</span>` : ""}
      ${badges(layer).map((b) => `<span class="badge ${b.cls}" title="${esc(b.title)}">${esc(b.text)}</span>`).join("")}
      ${layer.loaded === false && layer.loadError ? `<button type="button" class="btn btn-small retry">Try again<span class="sr-only">: ${nm}</span></button>` : ""}
    </div>
    <details${wasOpen ? " open" : ""}>
      <summary>About this source<span class="sr-only">: ${nm}</span></summary>
      <dl>
        <dt>Publisher</dt><dd>${esc(layer.attribution)}</dd>
        ${layer.type === "raster" && !layer.drawn_in_palette ? `<dt>Map colors</dt><dd>Drawn by the agency's map service. The swatch marks this layer in the list and legend. <a href="${esc(safeUrl(layer.legend_url) || "")}" target="_blank" rel="noopener">Agency legend<span class="sr-only"> for ${nm} (new tab)</span></a></dd>` : ""}
        <dt>Updates</dt><dd>${esc(layer.cadence)}</dd>
        ${layer.precision ? `<dt>Precision</dt><dd>${esc(PRECISION_TEXT[layer.precision] || layer.precision)}</dd>` : ""}
        ${typeof count === "number" && layer.type === "geojson" ? `<dt>Items</dt><dd>${count}</dd>` : ""}
        <dt>Terms</dt><dd>${esc(layer.license)}</dd>
        ${layer.notes ? `<dt>Notes</dt><dd>${esc(layer.notes)}</dd>` : ""}
        ${infoUrl ? `<dt>Agency page</dt><dd><a href="${esc(infoUrl)}" target="_blank" rel="noopener">Open<span class="sr-only"> (new tab)</span></a></dd>` : ""}
        ${endpoint ? `<dt>Endpoint</dt><dd><a href="${esc(endpoint)}" target="_blank" rel="noopener">Service</a></dd>` : ""}
        ${layer.type === "geojson" ? `<dt>Download</dt><dd class="exports">
          <a href="${esc(api(layer.data_url + ".geojson"))}" download>GeoJSON<span class="sr-only"> for ${nm}</span></a>
          <a href="${esc(api(layer.data_url + ".kml"))}" download>KML<span class="sr-only"> for ${nm}</span></a>
          <a href="${esc(api(layer.data_url + ".csv"))}" download>CSV<span class="sr-only"> for ${nm}</span></a>
          <a href="${esc(api(`/ogc/collections/${layer.id}/items`))}" target="_blank" rel="noopener">OGC API<span class="sr-only"> for ${nm} (new tab)</span></a></dd>` : ""}
        ${layer.type === "geojson" ? `<dt>Recent changes</dt><dd>${changesHtml(changesBySource.get(layer.id), 3)}</dd>` : ""}
      </dl>
    </details>`;
  li.querySelector("input").addEventListener("change", (e) => setVisible(layer, e.target.checked, { announce: true }));
  li.querySelector(".retry")?.addEventListener("click", () => loadVector(layer));
  if (focusSel) li.querySelector(focusSel)?.focus();
}

/** "Updated 3 days ago" in plain words, or null. */
function updatedText(layer) {
  if (layer.type === "raster") return "live map from the agency";
  const at = layer.status?.source_updated_at || layer.status?.received_at;
  const a = ago(at);
  return a ? `updated ${a}` : null;
}
/** Simple view row: plain name, one line, the source and how fresh it is. */
function simpleRowHtml(layer, inputId) {
  const sv = layer.simple || {};
  const info = safeUrl(layer.info_url);
  const upd = updatedText(layer);
  const problem = layer.loaded === false && layer.loadError;
  return `
    <div class="layer-row">
      <span class="check"><input type="checkbox" id="${inputId}" ${layer.visible ? "checked" : ""} aria-describedby="plain-${layer.id}"><span class="check-box" aria-hidden="true"></span></span>
      ${swatchHtml(layer)}
      <label for="${inputId}"><span class="layer-name">${esc(displayName(layer))}</span></label>
    </div>
    <div class="layer-plain" id="plain-${layer.id}">
      ${sv.summary ? `<p class="layer-summary">${esc(sv.summary)}</p>` : ""}
      ${layer.classes ? classLegendHtml(layer) : ""}
      ${zoomedOut(layer) ? `<p class="plain-note">${esc(layer.zoom_hint || "Zoom in to see this layer")}.</p>` : ""}
      ${problem ? `<p class="plain-note load-note">This layer could not load. <button type="button" class="btn btn-small retry">Try again<span class="sr-only">: ${esc(displayName(layer))}</span></button></p>` : ""}
      <p class="layer-source">Source: ${info ? `<a href="${esc(info)}" target="_blank" rel="noopener">${esc(layer.credit_short || layer.agency)}<span class="sr-only"> (new tab)</span></a>` : esc(layer.credit_short || layer.agency)}${upd ? `, ${esc(upd)}` : ""}.</p>
    </div>`;
}

/** True when a layer only draws closer in than the current zoom. */
function zoomedOut(layer) {
  return Boolean(layer.visible && layer.minzoom && map.getZoom() < layer.minzoom);
}
/** Mini legend: one fixed color per class (e.g. each land manager). */
function classLegendHtml(layer) {
  return `<ul class="class-legend" aria-label="${esc(layer.name)} colors">${layer.classes.map((c) =>
    `<li>${swatchHtml({ style: { color: c.color, fillOpacity: 1 } })}<span>${esc(c.label)}</span></li>`).join("")}</ul>`;
}

// Groups in the layer list. Each is a collapsible section whose header shows
// how many of its layers are on.
const GROUPS = [
  { id: "wolf-activity", name: "Wolf activity", open: true },
  { id: "wolf-management", name: "Wolf management areas" },
  { id: "bear", name: "Bears", hint: "Off by default. Generalized agency ranges, not bear locations." },
  { id: "context", name: "Context" },
];
const GROUP_KEY = "pw-groups";
function groupOpenState() {
  try { return JSON.parse(localStorage.getItem(GROUP_KEY) || "{}") || {}; } catch { return {}; }
}
function saveGroupOpen(id, open) {
  const st = groupOpenState();
  st[id] = open;
  try { localStorage.setItem(GROUP_KEY, JSON.stringify(st)); } catch { /* private mode */ }
}
function groupLayers(g) {
  if (g.layers) return g.layers.map((id) => layers.get(id)).filter(Boolean);
  return [...layers.values()].filter((l) => l.category === g.id)
    .sort((a, b) => (b.style?.order ?? 0) - (a.style?.order ?? 0));
}
/** Groups for the current view. Simple view: a few big groups, plus any layer turned on in Expert view. */
function currentGroups() {
  if (!isSimple()) return GROUPS;
  const gs = simpleGroups.map((g) => ({ ...g, open: true, key: `simple-${g.id}` }));
  const listed = new Set(gs.flatMap((g) => g.layers));
  const extra = [...layers.values()].filter((l) => l.visible && !listed.has(l.id)).map((l) => l.id);
  if (extra.length) gs.push({ id: "also-on", key: "simple-also-on", name: "Also on (from Expert view)", layers: extra, open: true });
  return gs;
}

function renderPanel() {
  const root = $("#layer-groups");
  const st = groupOpenState();
  root.innerHTML = "";
  for (const g of currentGroups()) {
    const list = groupLayers(g);
    if (!list.length) continue;
    const open = st[g.key || g.id] ?? Boolean(g.open);
    const sec = document.createElement("section");
    sec.className = "layer-group";
    sec.dataset.group = g.id;
    sec.innerHTML = `<h3 class="group-head"><button type="button" class="group-toggle" id="grp-${g.id}-btn" aria-expanded="${open}" aria-controls="grp-${g.id}-body">
        <span class="group-arrow" aria-hidden="true"></span><span class="group-name">${esc(g.name)}</span>
        <span class="group-count" id="grp-${g.id}-count"></span></button></h3>
      <div class="group-body" id="grp-${g.id}-body"${open ? "" : " hidden"}>
        ${g.hint ? `<p class="hint">${esc(g.hint)}</p>` : ""}
        <ul class="layer-list" data-category="${g.id}"></ul>
      </div>`;
    root.appendChild(sec);
    const ul = sec.querySelector("ul");
    for (const l of list) {
      const li = document.createElement("li");
      li.className = "layer";
      li.id = `row-${l.id}`;
      ul.appendChild(li);
      renderLayerRow(l);
    }
    sec.querySelector(".group-toggle").addEventListener("click", (e) => {
      const btn = e.currentTarget;
      const next = btn.getAttribute("aria-expanded") !== "true";
      setGroupOpen(sec, next);
      saveGroupOpen(g.key || g.id, next);
    });
  }
  applyFilter();
  updatePanelState();
}
function setGroupOpen(sec, open) {
  sec.querySelector(".group-toggle").setAttribute("aria-expanded", String(open));
  sec.querySelector(".group-body").hidden = !open;
}

// Filter box and "Show active only": hide rows that do not match. A group
// with matches opens while a filter is typed; one with none is hidden.
const filterInput = $("#layer-filter");
const activeOnly = $("#active-only");
function layerText(l) {
  return [l.name, l.agency, l.species, l.summary, l.credit_short, ...(l.classes || []).map((c) => c.label)].filter(Boolean).join(" ").toLowerCase();
}
function applyFilter() {
  const q = isSimple() ? "" : filterInput.value.trim().toLowerCase();
  const only = !isSimple() && activeOnly.checked;
  const filtering = Boolean(q) || only;
  let shown = 0;
  for (const sec of document.querySelectorAll(".layer-group")) {
    let n = 0;
    for (const li of sec.querySelectorAll("li.layer")) {
      const l = layers.get(li.id.slice(4));
      const ok = l && (!q || q.split(/\s+/).every((w) => layerText(l).includes(w))) && (!only || l.visible);
      li.hidden = !ok;
      if (ok) n++;
    }
    shown += n;
    sec.hidden = filtering && n === 0;
    if (filtering && n) sec.querySelector(".group-body").hidden = false;
    if (filtering && n) sec.querySelector(".group-toggle").setAttribute("aria-expanded", "true");
    if (!filtering) {
      const g = currentGroups().find((x) => x.id === sec.dataset.group);
      setGroupOpen(sec, groupOpenState()[g?.key || sec.dataset.group] ?? Boolean(g?.open));
    }
  }
  $("#filter-status").textContent = !filtering ? ""
    : shown ? `${shown} ${shown === 1 ? "layer" : "layers"} shown.`
    : only && !q ? "No layers are on." : "No layers match. Clear the filter to see all layers.";
}
let filterTimer = 0;
filterInput.addEventListener("input", () => { clearTimeout(filterTimer); filterTimer = setTimeout(applyFilter, 120); });
activeOnly.addEventListener("change", applyFilter);

/** Group counts, active chips, the panel legend and sources: run after any toggle. */
function updatePanelState() {
  for (const g of currentGroups()) {
    const el = document.getElementById(`grp-${g.id}-count`);
    if (!el) continue;
    const list = groupLayers(g);
    const on = list.filter((l) => l.visible).length;
    el.textContent = `${on} of ${list.length} on`;
    el.classList.toggle("has-on", on > 0);
  }
  renderChips();
  renderPanelSources();
  scheduleListView();
  if (activeOnly.checked) applyFilter();
}

// Active-layer chips: every layer that is on, tap to turn it off.
function renderChips() {
  const ul = $("#active-chips");
  const vis = visibleLayers();
  const focusedId = ul.contains(document.activeElement) ? document.activeElement.dataset.id : null;
  ul.innerHTML = vis.length ? vis.map((l) => `<li><button type="button" class="chip" data-id="${esc(l.id)}" aria-label="Turn off ${esc(displayName(l))}" title="${esc(displayName(l))}">
      ${swatchHtml(l)}<span class="chip-name">${esc(displayName(l))}</span><span class="chip-x" aria-hidden="true">×</span></button></li>`).join("")
    : `<li class="hint chips-empty">No layers are on.</li>`;
  if (focusedId) {
    const next = ul.querySelector(`[data-id="${CSS.escape(focusedId)}"]`) || ul.querySelector(".chip");
    (next || $("#active-label")).focus?.();
  }
}
$("#active-chips").addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  const l = layers.get(btn.dataset.id);
  if (!l) return;
  const chips = [...$("#active-chips").querySelectorAll(".chip")];
  const i = chips.indexOf(btn);
  setVisible(l, false, { announce: true });
  renderLayerRow(l);
  const after = [...$("#active-chips").querySelectorAll(".chip")];
  (after[Math.min(i, after.length - 1)] || $("#layer-filter")).focus();
});

function setMany(pick, message) {
  for (const l of layers.values()) {
    const on = pick(l);
    if (on !== l.visible) { setVisible(l, on, { quiet: true }); renderLayerRow(l); }
  }
  updatePanelState();
  announce(`${message} ${countOn()}`);
}
const countOn = () => {
  const n = visibleLayers().length;
  return n ? `${n} ${n === 1 ? "layer is" : "layers are"} on.` : "No layers are on.";
};
$("#reset-layers").addEventListener("click", () => setMany((l) => Boolean(l.style?.defaultVisible), "Layers reset to the defaults."));
$("#all-off").addEventListener("click", () => setMany(() => false, "All layers turned off."));

// Short messages for screen readers (layer toggles, search results).
const announcer = $("#announcer");
let announceTimer = 0;
function announce(text) {
  clearTimeout(announceTimer);
  announcer.textContent = "";
  announceTimer = setTimeout(() => (announcer.textContent = text), 60);
}

// ------------------------------------------------------- feature details
/** Simple view popup: one plain sentence, the source and how fresh it is. */
function plainFeatureHtml(p, layer) {
  const sentence = layer?.simple?.popup || `This area is part of “${displayName(layer) || p.source_name}”.`;
  const when = ago(p.observed_at) || (layer ? updatedText(layer)?.replace(/^updated /, "") : null);
  const info = safeUrl(p.url) || safeUrl(layer?.info_url);
  const credit = layer?.credit_short || p.agency;
  return `<article class="feature plain">
    <h3>${layer ? swatchHtml(layer) : ""} ${esc(displayName(layer) || p.source_name)}</h3>
    <p class="plain-sentence">${esc(sentence)}</p>
    <p>Source: ${esc(credit)}${when ? `, updated ${esc(when)}` : ""}.${info ? ` <a href="${esc(info)}" target="_blank" rel="noopener">Source page<span class="sr-only"> (new tab)</span></a>` : ""}</p>
    ${layer?.status?.state === "fixture" ? `<p class="note">This is sample data. The agency could not be reached.</p>` : ""}
    <p class="note">Areas are shown as the agency drew them. They are not exact animal locations.</p>
  </article>`;
}
function featureHtml(p, layer) {
  if (isSimple()) return plainFeatureHtml(p, layer);
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
// Phones: details open above the sheet, so a half or full sheet would leave
// them only a header strip. Fold the sheet while details show, then put it
// back the way it was when they close.
let sheetBeforeDetails = null;
function showDetails(features) {
  if (!features.length) return;
  lastFocus = document.activeElement;
  if (isPhone() && !panel.hidden && panel.dataset.sheet !== "peek") {
    sheetBeforeDetails ??= panel.dataset.sheet;
    setSheet("peek");
  }
  $("#details-title").textContent = features.length > 1 ? (isSimple() ? `${features.length} things here` : `${features.length} items here`) : (isSimple() ? "What is here" : "Details");
  $("#details-body").innerHTML = features.map((f) => featureHtml(f.properties, layers.get(f.properties.source_id))).join("");
  detailsEl.hidden = false;
  $("#details-close").focus();
}
function hideDetails() {
  detailsEl.hidden = true;
  if (sheetBeforeDetails && isPhone()) setSheet(sheetBeforeDetails);
  sheetBeforeDetails = null;
  if (lastFocus && document.contains(lastFocus) && lastFocus.getClientRects().length) lastFocus.focus();
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
  identifyLand(e.lngLat, unique.length > 0);
});

// "Who manages the land": ask BLM's service what is under the click and
// say it in plain words. Runs only when that layer is on and drawn.
let landSeq = 0;
async function identifyLand(lngLat, append) {
  const layer = [...layers.values()].find((l) => l.identify && l.visible && !zoomedOut(l));
  if (!layer) return;
  const seq = ++landSeq;
  const b = map.getBounds();
  const c = map.getCanvas();
  const q = new URLSearchParams({
    geometry: `${lngLat.lng},${lngLat.lat}`, geometryType: "esriGeometryPoint", sr: "4326",
    layers: `all:${layer.identify.layer_id}`, tolerance: "1", returnGeometry: "false",
    mapExtent: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(","),
    imageDisplay: `${c.clientWidth},${c.clientHeight},96`, f: "json",
  });
  let code = null;
  try {
    const res = await fetchWithTimeout(`${layer.identify.url}?${q}`, 12000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    code = body.results?.[0]?.attributes?.[layer.identify.field] ?? null;
  } catch {
    if (seq !== landSeq || append) return;
    showLand(layer, null, append, "The land manager could not be looked up right now. Try again in a moment.");
    return;
  }
  if (seq !== landSeq) return;
  showLand(layer, code, append);
}
/** The land class for an agency code; anything unlisted is "other". */
function landClassFor(layer, code) {
  return layer.classes.find((c) => c.codes.includes(String(code))) ?? layer.classes.find((c) => c.key === "other");
}
function showLand(layer, code, append, error) {
  const cls = code === null ? null : landClassFor(layer, code);
  const info = safeUrl(layer.info_url);
  const html = isSimple() ? `<article class="feature land plain">
    <h3>${cls ? `${swatchHtml({ style: { color: cls.color, fillOpacity: 1 } })} ` : ""}Who manages the land</h3>
    <p class="plain-sentence">${cls ? `${esc(layer.simple?.popup || "This land is managed by")} ${esc(cls.label)}.` : esc(error || "No public land manager is listed here. It is usually private land or water.")}</p>
    ${cls ? `<p>${esc(cls.meaning)}</p>` : ""}
    <p>Source: ${info ? `<a href="${esc(info)}" target="_blank" rel="noopener">${esc(layer.credit_short || layer.agency)}<span class="sr-only"> (new tab)</span></a>` : esc(layer.credit_short || layer.agency)}.</p>
  </article>` : `<article class="feature land">
    <h3>${cls ? `${swatchHtml({ style: { color: cls.color, fillOpacity: 1 } })} Managed by: ${esc(cls.label)}` : error ? "Who manages the land" : "Managed by: not listed"}</h3>
    ${cls ? `<p><strong>What this means:</strong> ${esc(cls.meaning)}</p>`
      : `<p>${esc(error || "BLM's data shows no surface manager at this spot. It is usually private or water.")}</p>`}
    <p class="note">${esc(layer.popup_note || "")}</p>
    <p class="note">Source: ${info ? `<a href="${esc(info)}" target="_blank" rel="noopener">${esc(layer.attribution)}<span class="sr-only"> (new tab)</span></a>` : esc(layer.attribution)}</p>
  </article>`;
  if (append && !detailsEl.hidden) {
    $("#details-body").insertAdjacentHTML("beforeend", html);
    return;
  }
  lastFocus = document.activeElement;
  $("#details-title").textContent = "Land manager";
  $("#details-body").innerHTML = html;
  detailsEl.hidden = false;
  $("#details-close").focus();
}
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
      autoView = false;
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
map.on("moveend", () => { updateItems(); writeHash(); scheduleListView(); });

// ------------------------------------------------------------- list view
// A text alternative to the map: for each layer that is on, how many areas
// are in view, the nearest ones to the map center, and when it was updated.
let listTimer = 0;
function scheduleListView() {
  clearTimeout(listTimer);
  listTimer = setTimeout(renderListView, 200);
}
function milesBetween([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}
function compass([lon1, lat1], [lon2, lat2]) {
  const dirs = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  const ang = (Math.atan2(lon2 - lon1, lat2 - lat1) * 180) / Math.PI;
  return dirs[Math.round(((ang + 360) % 360) / 45) % 8];
}
function renderListView() {
  const out = $("#list-view");
  if (!out || !layers.size) return;
  const vis = visibleLayers();
  if (!vis.length) { out.innerHTML = `<p class="hint">No layers are on. Turn one on under Layers.</p>`; return; }
  const b = map.getBounds();
  const c = map.getCenter().wrap();
  const center = [c.lng, c.lat];
  const simple = isSimple();
  out.innerHTML = `<ul class="list-view-list">${vis.map((l) => {
    const upd = updatedText(l);
    const head = `<h3 class="lv-name">${swatchHtml(l)} ${esc(displayName(l))}</h3>`;
    if (l.type !== "geojson") {
      const note = zoomedOut(l) ? (l.zoom_hint || "Zoom in to see this layer") + "." : "A map picture from the agency. Select a spot on the map to ask what is there.";
      return `<li>${head}<p>${esc(note)}</p>${upd ? `<p class="lv-meta">${esc(l.credit_short || l.agency)}, ${esc(upd)}.</p>` : ""}</li>`;
    }
    if (l.loaded !== true) return `<li>${head}<p>${l.loaded === "loading" ? "Loading…" : "Not loaded yet."}</p></li>`;
    const hits = [];
    for (const f of l.data.features || []) {
      if (!f.geometry) continue;
      f._bbox ??= bboxOf(f.geometry);
      if (!inView(f._bbox, b)) continue;
      const mid = [(f._bbox[0] + f._bbox[2]) / 2, (f._bbox[1] + f._bbox[3]) / 2];
      hits.push({ f, mid, d: milesBetween(center, mid) });
    }
    hits.sort((x, y) => x.d - y.d);
    const n = hits.length;
    const noun = simple ? (n === 1 ? "area" : "areas") : (n === 1 ? "item" : "items");
    const nearest = hits.slice(0, 3).map((h) => {
      const label = h.f.properties?.label || "Unnamed area";
      const dist = h.d < 1 ? "at the map center" : `about ${Math.round(h.d)} miles ${compass(center, h.mid)} of the map center`;
      return `<li><button type="button" class="lv-item" data-layer="${esc(l.id)}" data-fid="${esc(String(h.f.properties?.id ?? ""))}">${esc(label)}</button>, ${esc(dist)}</li>`;
    }).join("");
    return `<li>${head}<p>${n ? `${n} ${noun} in view.` : `None in this view.`}${n > 3 ? " Nearest three:" : n ? " Nearest:" : ""}</p>
      ${nearest ? `<ul class="lv-nearest">${nearest}</ul>` : ""}
      <p class="lv-meta">${esc(l.credit_short || l.agency)}${upd ? `, ${esc(upd)}` : ""}.</p></li>`;
  }).join("")}</ul>`;
}
$("#list-view").addEventListener("click", (e) => {
  const btn = e.target.closest(".lv-item");
  if (!btn) return;
  const l = layers.get(btn.dataset.layer);
  const f = l?.data?.features?.find((x) => String(x.properties?.id ?? "") === btn.dataset.fid);
  if (!f) return;
  const [x0, y0, x1, y1] = f._bbox;
  autoView = false;
  showDetails([{ properties: { ...f.properties, details: parseMaybe(f.properties.details) } }]);
  map.fitBounds([[x0, y0], [x1, y1]], { padding: 80, maxZoom: 8, duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 600 });
});

// ------------------------------------------------------------ panel / sheet
// Wide screens: a side panel the header "Layers" button shows and hides.
// Phones (760px and narrower): a bottom sheet over the map with three
// heights (peek, half, full). Drag the handle, tap it, or use the arrow keys.
const panel = $("#panel");
const layout = $(".layout");
const toggle = $("#panel-toggle");
const sheetHandle = $("#sheet-handle");
const sheetClose = $("#sheet-close");
const SHEET_STATES = ["peek", "half", "full"];
const phoneQuery = matchMedia("(max-width: 760px)");
const isPhone = () => phoneQuery.matches;

// Wide screens: the header "Layers" button, the edge tab on the panel and the
// "[" key all show and hide the side panel.
const edge = $("#panel-edge");
const PANEL_KEY = "pw-panel";
function setPanelOpen(open, { save = true } = {}) {
  panel.hidden = !open;
  layout.classList.toggle("panel-closed", !open);
  toggle.setAttribute("aria-expanded", String(open));
  edge.setAttribute("aria-expanded", String(open));
  const label = open ? "Hide the layers panel" : "Show the layers panel";
  $("#panel-edge-label").textContent = label;
  edge.title = `${label} (shortcut: [ )`;
  if (save) try { localStorage.setItem(PANEL_KEY, open ? "open" : "closed"); } catch { /* private mode */ }
  map.resize();
  applyMapPadding({ force: true });
}
toggle.addEventListener("click", () => setPanelOpen(panel.hidden));
edge.addEventListener("click", () => setPanelOpen(panel.hidden));
document.addEventListener("keydown", (e) => {
  if (e.key !== "[" || e.ctrlKey || e.metaKey || e.altKey || isPhone()) return;
  if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  e.preventDefault();
  const open = panel.hidden;
  setPanelOpen(open);
  announce(open ? "Layers panel shown." : "Layers panel hidden.");
  if (open) panel.focus();
});
try { if (localStorage.getItem(PANEL_KEY) === "closed" && !phoneQuery.matches) setPanelOpen(false, { save: false }); } catch { /* private mode */ }

// Jump links at the top of the panel: Layers, Legend, Sources.
for (const a of document.querySelectorAll(".jump-tabs a")) {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    const target = document.getElementById(a.dataset.jump);
    if (!target) return;
    if (isPhone() && panel.dataset.sheet !== "full") setSheet("full");
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() => {
      // Scroll only the panel (the sheet body on phones), never the page,
      // and leave room for the sticky jump tabs.
      const scroller = isPhone() ? $("#panel-body") : panel;
      const tabs = $(".jump-tabs").getBoundingClientRect().height;
      const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - tabs - 8;
      scroller.scrollTo({ top: Math.max(0, top), behavior: reduce ? "auto" : "smooth" });
      target.focus({ preventScroll: true });
    });
  });
}

function setSheet(state, { focus = false } = {}) {
  if (!SHEET_STATES.includes(state)) state = "peek";
  panel.dataset.sheet = state;
  panel.style.removeProperty("height");
  const open = state !== "peek";
  sheetHandle.setAttribute("aria-expanded", String(open));
  $("#sheet-state").textContent = state === "peek" ? ", collapsed. Activate to show more."
    : state === "half" ? ", half open. Activate to open fully." : ", fully open. Activate to collapse.";
  sheetClose.hidden = !open;
  if (focus && open) sheetHandle.focus();
  syncOffsets();
}
sheetHandle.addEventListener("click", () => {
  if (dragMoved) return;
  const i = SHEET_STATES.indexOf(panel.dataset.sheet);
  setSheet(SHEET_STATES[(i + 1) % SHEET_STATES.length]);
});
sheetHandle.addEventListener("keydown", (e) => {
  const i = SHEET_STATES.indexOf(panel.dataset.sheet);
  if (e.key === "ArrowUp") { e.preventDefault(); setSheet(SHEET_STATES[Math.min(2, i + 1)]); }
  if (e.key === "ArrowDown") { e.preventDefault(); setSheet(SHEET_STATES[Math.max(0, i - 1)]); }
});
sheetClose.addEventListener("click", () => { setSheet("peek"); sheetHandle.focus(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isPhone() && panel.dataset.sheet !== "peek" && panel.contains(document.activeElement)) {
    setSheet("peek");
    sheetHandle.focus();
  }
});

// Dragging the handle: follow the finger, then snap to the nearest height.
let dragStart = null;
let dragMoved = false;
sheetHandle.addEventListener("pointerdown", (e) => {
  if (!isPhone()) return;
  dragStart = { y: e.clientY, h: panel.getBoundingClientRect().height };
  dragMoved = false;
  sheetHandle.setPointerCapture?.(e.pointerId);
});
sheetHandle.addEventListener("pointermove", (e) => {
  if (!dragStart) return;
  const dy = dragStart.y - e.clientY;
  if (Math.abs(dy) > 6) dragMoved = true;
  if (!dragMoved) return;
  const max = layout.clientHeight - 56;
  panel.style.height = `${Math.max(56, Math.min(max, dragStart.h + dy))}px`;
  panel.classList.add("dragging");
  syncOffsets();
});
const endDrag = () => {
  if (!dragStart) return;
  dragStart = null;
  panel.classList.remove("dragging");
  if (!dragMoved) return;
  const h = panel.getBoundingClientRect().height;
  const total = layout.clientHeight;
  const targets = { peek: 0, half: halfSheetPx(total), full: total - 64 };
  const best = Object.entries(targets).sort((a, b) => Math.abs(a[1] - h) - Math.abs(b[1] - h))[0][0];
  setSheet(best);
  setTimeout(() => (dragMoved = false), 0);
};
sheetHandle.addEventListener("pointerup", endDrag);
sheetHandle.addEventListener("pointercancel", endDrag);

// The legend, scale bar, credits and details sit above the sheet and the
// credits bar, so nothing on the map is hidden under them.
function syncOffsets() {
  const sheetH = isPhone() && !panel.hidden ? Math.round(panel.getBoundingClientRect().height) : 0;
  const creditsH = Math.round($("#credits-bar").getBoundingClientRect().height);
  layout.style.setProperty("--sheet-h", `${sheetH}px`);
  layout.style.setProperty("--credits-h", `${creditsH}px`);
  applyMapPadding();
}
// Mirrors the CSS for .panel[data-sheet="half"]: 46% of the layout, but never
// so tall that less than 45% of the screen is left for the map.
function halfSheetPx(total) {
  const creditsH = $("#credits-bar").getBoundingClientRect().height;
  return Math.max(120, Math.min(total * 0.46, total - creditsH - window.innerHeight * 0.45));
}

// ------------------------------------------------------------ view fitting
// The first view fits the data that is on, inside the part of the map that
// the sheet (phones) and credits bar do not cover. Map padding follows the
// sheet height, so the data stays in view when the sheet moves. Once the
// person pans, zooms or searches, only the padding follows the sheet.
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
for (const ev of ["dragstart", "zoomstart", "rotatestart", "pitchstart"]) {
  map.on(ev, (e) => { if (e.originalEvent) autoView = false; });
}
function mapPadding() {
  const sheetH = isPhone() && !panel.hidden ? panel.getBoundingClientRect().height : 0;
  const creditsH = $("#credits-bar").getBoundingClientRect().height;
  return { top: 0, right: 0, left: 0, bottom: Math.round(sheetH + creditsH) };
}
// Extra room inside the clear area for the map controls (top left), the
// legend (top right on phones) and the scale bar (bottom left).
// On short screens (phones in landscape) the margins shrink so the data
// still gets most of the clear area.
function fitMargin(pad = mapPadding()) {
  const m = isPhone() ? { top: 52, right: 10, bottom: 26, left: 52 } : { top: 24, right: 24, bottom: 36, left: 60 };
  // Wide screens: the open legend sits bottom right, so keep the data above it.
  const legend = $("#legend");
  if (!isPhone() && legend?.open) m.bottom = Math.max(m.bottom, Math.round(legend.getBoundingClientRect().height) + 16);
  const freeH = map.getContainer().clientHeight - pad.bottom;
  if (freeH - m.top - m.bottom < 160) { m.top = Math.min(m.top, 8); m.bottom = Math.min(m.bottom, 8); }
  return m;
}
function dataBounds() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of layers.values()) {
    if (!l.visible || l.type !== "geojson" || !l.data?.features) continue;
    for (const f of l.data.features) {
      if (!f.geometry) continue;
      f._bbox ??= bboxOf(f.geometry);
      const b = f._bbox;
      if (!b || !Number.isFinite(b[0])) continue;
      x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
    }
  }
  return Number.isFinite(x0) ? [[x0, y0], [x1, y1]] : null;
}
function fitView({ animate = false } = {}) {
  const c = map.getContainer();
  const pad = mapPadding();
  const m = fitMargin(pad);
  // Too little clear map to fit into (a tiny window): leave the view alone.
  if (c.clientHeight - pad.bottom - m.top - m.bottom < 40 || c.clientWidth - m.left - m.right < 80) return;
  map.fitBounds(autoBounds, { padding: m, maxZoom: 7.5, linear: true, duration: animate && !reduceMotion() ? 450 : 0 });
}
function applyMapPadding({ force = false, animate = false } = {}) {
  const pad = mapPadding();
  const c = map.getContainer();
  const key = `${pad.bottom}|${c.clientWidth}x${c.clientHeight}`;
  if (key === lastPadKey && !force) return;
  lastPadKey = key;
  if (autoView) { map.setPadding(pad); fitView({ animate }); }
  else map.easeTo({ padding: pad, duration: animate && !reduceMotion() ? 200 : 0 });
}
$("#legend")?.addEventListener("toggle", () => { if (autoView && !isPhone()) fitView({ animate: true }); });
// Called after each data layer loads: once every layer that is on has
// loaded, fit to the real data (unless the person has moved the map).
function refineAutoView() {
  if (!autoView) return;
  const on = [...layers.values()].filter((l) => l.visible && l.type === "geojson");
  if (on.some((l) => l.loaded === "loading")) return;
  const b = dataBounds();
  if (!b) return;
  autoBounds = b;
  fitView({ animate: true });
}
if ("ResizeObserver" in window) {
  const ro = new ResizeObserver(() => syncOffsets());
  ro.observe(panel);
  ro.observe($("#credits-bar"));
}
function onViewportChange() {
  if (!isPhone()) panel.style.removeProperty("height");
  if (isPhone() && panel.hidden) setPanelOpen(true, { save: false });
  syncOffsets();
  map.resize();
}
phoneQuery.addEventListener?.("change", onViewportChange);
window.addEventListener("orientationchange", () => setTimeout(onViewportChange, 250));
window.addEventListener("resize", () => requestAnimationFrame(syncOffsets));

function updateSheetCount() {
  const n = [...layers.values()].filter((l) => l.visible).length;
  $("#sheet-count").textContent = n ? `${n} on` : "none on";
}

// ------------------------------------------------------------------ credits
// One compact line, always on screen: the basemap credit, then a short
// credit for each agency layer that is on. "Sources" opens the full list.
function visibleLayers() {
  return [...layers.values()].filter((l) => l.visible)
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || (b.style?.order ?? 0) - (a.style?.order ?? 0));
}
function renderCredits() {
  const groups = creditGroups(visibleLayers());
  $("#credits-agencies").innerHTML = groups.length
    ? `<span class="credits-label">Data</span> ${groups.map((g) => g.url
        ? `<a href="${esc(g.url)}" target="_blank" rel="noopener" title="${esc(g.layers.map((l) => l.name).join(", "))}">${esc(g.name)}<span class="sr-only"> (new tab)</span></a>`
        : `<span>${esc(g.name)}</span>`).join('<span class="credits-sep" aria-hidden="true"> · </span>')}`
    : "";
  const n = groups.length;
  $("#credits-count").textContent = `${n} source${n === 1 ? "" : "s"}`;
  updateSheetCount();
  if (!$("#sources-panel").hidden) renderSources();
}
function sourcesHtml() {
  const list = visibleLayers();
  return list.length ? list.map((l) => {
    const u = safeUrl(l.info_url);
    const updated = l.type === "raster" ? "Live agency map service" : l.status?.source_updated_at
      ? `Agency updated ${fmtTime(l.status.source_updated_at)}` : "Agency update date not published";
    return `<li>${swatchHtml(l)}<div><strong>${esc(displayName(l))}</strong>
      <span>${esc(l.attribution)}</span>
      <span class="muted">${esc(updated)}</span>
      ${u ? `<a href="${esc(u)}" target="_blank" rel="noopener">Source page<span class="sr-only"> for ${esc(l.name)} (new tab)</span></a>` : ""}</div></li>`;
  }).join("") : `<li class="hint">No layers are on. Turn one on under Layers.</li>`;
}
function renderSources() {
  $("#sources-list").innerHTML = sourcesHtml();
}
function renderPanelSources() {
  $("#panel-sources").innerHTML = sourcesHtml();
}
const sourcesPanel = $("#sources-panel");
const sourcesBtn = $("#sources-open");
function setSourcesOpen(open) {
  sourcesPanel.hidden = !open;
  sourcesBtn.setAttribute("aria-expanded", String(open));
  if (open) { renderSources(); $("#sources-close").focus(); } else sourcesBtn.focus();
}
sourcesBtn.addEventListener("click", () => setSourcesOpen(sourcesPanel.hidden));
$("#sources-close").addEventListener("click", () => setSourcesOpen(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sourcesPanel.hidden) setSourcesOpen(false); });

// ------------------------------------------------------------------ splash
const splash = $("#splash");
function hideSplash() {
  if (!splash || splash.classList.contains("done")) return;
  splash.classList.add("done");
  setTimeout(() => splash.remove(), 400);
}
setTimeout(hideSplash, 12000);

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
    listSavedAt = savedAt;
    index = await res.json();
  } catch (e) {
    const text = "The layer list could not load. Check your connection, then try again.";
    statusEl.textContent = text;
    const msg = $("#splash-msg");
    if (msg) msg.textContent = text;
    setTimeout(hideSplash, 2500);
    // Say so where the layers would be (Simple view hides the status line),
    // and hide the chips and Reset links, which have nothing to act on yet.
    panel.dataset.boot = "error";
    $("#layer-groups").innerHTML = `<div class="load-error" role="alert"><p>${text}</p><button type="button" class="btn btn-solid" id="boot-retry">Try again</button></div>`;
    $("#list-view").innerHTML = `<p class="hint">No layers yet. ${text}</p>`;
    $("#boot-retry").addEventListener("click", () => {
      $("#layer-groups").innerHTML = `<p class="hint">Loading…</p>`;
      boot();
    }, { once: true });
    return;
  }
  delete panel.dataset.boot;
  simpleGroups = Array.isArray(index.simple_groups) ? index.simple_groups : [];
  for (const l of index.layers) {
    const visible = initial.ids ? initial.ids.has(l.id) : Boolean(l.style?.defaultVisible);
    layers.set(l.id, { ...l, visible, loaded: false });
  }
  renderPanel();
  renderPlanned(index);
  renderCredits();
  const vectors = [...layers.values()].filter((l) => l.type === "geojson");
  statusEl.textContent = savedAt
    ? `Offline. Showing the layer list saved on this device ${fmtTime(savedAt)}.`
    : `${vectors.length} agency data layers and ${layers.size - vectors.length} live agency map services. Times shown in ${tz}.`;
  loadChanges();
  const start = () => {
    for (const l of layers.values()) if (l.visible) setVisible(l, true);
    renderLegend();
    renderCredits();
    hideSplash();
  };
  if (map.isStyleLoaded()) start(); else map.once("load", start);
  renderOffline();
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
function legendHtml() {
  const vis = [...layers.values()].filter((l) => l.visible)
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
  return vis.length ? vis.map((l) => {
    const zoomNote = l.minzoom && map.getZoom() < l.minzoom ? ` <small>(${esc(l.zoom_hint ? l.zoom_hint.toLowerCase() : "zoom in to see")})</small>` : "";
    const agencyColors = l.type === "raster" && !l.drawn_in_palette ? ` <small>(agency colors)</small>` : "";
    const classes = l.classes && !zoomNote ? classLegendHtml(l) : "";
    return `<li class="${classes ? "has-classes" : ""}">${l.classes ? "" : swatchHtml(l)}<span>${esc(displayName(l))}${zoomNote}${isSimple() ? "" : agencyColors}${classes}</span></li>`;
  }).join("") : `<li class="hint">No layers turned on.</li>`;
}
function renderLegend() {
  const html = legendHtml();
  $("#legend-list").innerHTML = html;
  $("#panel-legend").innerHTML = html;
}
let lastZoomBand = null;
map.on("zoomend", () => {
  renderLegend();
  // Re-draw rows whose "zoom in" badge changed.
  const band = [...layers.values()].map((l) => zoomedOut(l)).join();
  if (band !== lastZoomBand) { lastZoomBand = band; for (const l of layers.values()) if (l.minzoom) renderLayerRow(l); }
});
if (window.innerWidth <= 760 || window.innerHeight < 560) $("#legend").removeAttribute("open");

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
  autoView = false;
  map.flyTo({ center: [r.lon, r.lat], zoom: r.zoom ?? 10, duration: reduce ? 0 : 800 });
  searchMarker?.remove();
  searchMarker = new maplibregl.Marker({ color: "#111418" }).setLngLat([r.lon, r.lat]).addTo(map);
  searchOut.innerHTML = `<li class="hint">Showing ${esc(r.name)}.</li>`;
  announce(`Showing ${r.name} on the map.`);
}
function showResults(results, note) {
  searchOut.innerHTML = "";
  announce(`${results.length} ${results.length === 1 ? "place" : "places"} found. Use Tab to choose one.`);
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
  if (seen || initial.view) document.documentElement.removeAttribute("data-first-visit");
  if (!seen && !initial.view) {
    hint.hidden = false;
    const close = () => {
      hint.hidden = true;
      document.documentElement.removeAttribute("data-first-visit");
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
let mapTheme = currentTheme();
function syncThemeButton() {
  const dark = currentTheme() === "dark";
  // The name stays "Dark mode" on every page; aria-pressed says whether it is on.
  themeBtn.setAttribute("aria-pressed", String(dark));
  themeBtn.title = dark ? "Switch to light mode" : "Switch to dark mode";
}
function applyTheme(theme) {
  syncThemeButton();
  if (theme === mapTheme) return;
  mapTheme = theme;
  // Swap the basemap, then put the agency layers back in their places.
  map.setStyle(BASEMAPS[theme], { diff: false });
  map.once("style.load", () => {
    for (const l of layers.values()) {
      if (l.type === "raster" && l.visible) addRaster(l);
      if (l.type === "geojson" && l.loaded === true) addVector(l);
    }
  });
  // Layer colors do not depend on the theme, so rows and the legend stay as they are.
}
themeBtn.addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
  window.pwTheme?.paint(next);
});
// theme.js may change data-theme (device setting, another tab): follow it.
new MutationObserver(() => applyTheme(currentTheme()))
  .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
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

// ---------------------------------------------------------- offline state
// Saved copies are never shown silently: while the device is offline, or
// any layer on the map is a saved copy, one line at the top of the map says
// so with the time of the oldest saved copy. Each layer also has its own
// "Saved copy (offline)" badge. When the connection returns, saved layers
// are fetched again and the line goes away.
let listSavedAt = null;
const offlineBar = $("#offline-bar");
function renderOffline() {
  if (!offlineBar) return;
  const saved = [listSavedAt, ...[...layers.values()].filter((l) => l.visible && l.saved_at).map((l) => l.saved_at)]
    .filter(Boolean).sort();
  const offline = navigator.onLine === false;
  if (!offline && !saved.length) { offlineBar.hidden = true; offlineBar.textContent = ""; return; }
  offlineBar.textContent = saved.length
    ? `${offline ? "You are offline. " : "No connection to the data server. "}Showing data saved on this device, last updated ${fmtTime(saved[0])}. It may be out of date.`
    : "You are offline. Layers will load when the connection is back.";
  offlineBar.hidden = false;
}
addEventListener("offline", renderOffline);
addEventListener("online", () => {
  if (listSavedAt || !layers.size) { location.reload(); return; }
  for (const l of layers.values()) if (l.visible && l.saved_at && l.type === "geojson") loadVector(l);
  renderOffline();
});

// ---------------------------------------------------------- offline cache
// sw.js keeps the last good copy of the layer list and agency data on this
// device, so the map still opens with a weak or missing connection.
// The store apps bundle their files and keep saved copies in net.js instead.
if ("serviceWorker" in navigator && window.isSecureContext && !NATIVE) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// ------------------------------------------------------- use my location
const locateBtn = $("#locate-me");
const locateMsg = $("#locate-status");
let locateMarker = null;
if (!("geolocation" in navigator)) locateBtn.hidden = true;
// The note shows only after a tap on the button, and clears once the
// person starts typing a place instead.
$("#search-q").addEventListener("input", () => { locateMsg.textContent = ""; });
locateBtn.addEventListener("click", () => {
  locateMsg.textContent = "Finding your location…";
  navigator.geolocation.getCurrentPosition((pos) => {
    const { longitude: lon, latitude: lat } = pos.coords;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    autoView = false;
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 8), duration: reduce ? 0 : 800 });
    locateMarker?.remove();
    locateMarker = new maplibregl.Marker({ color: "#111418" }).setLngLat([lon, lat]).addTo(map);
    locateMsg.textContent = "Showing your location. It stays on this device.";
    announce("Showing your location on the map.");
  }, locateFailed, { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
});
// The only place the location note is set to an error: after a tap on
// "Use my location" (or the map's locate button) fails. Code 1 also comes
// back when location is off in the browser or the device settings, not only
// when this site was refused.
function locateFailed(err) {
  const text = err?.code === 1
    ? "Location is blocked in this browser or device's settings. Type a town or ZIP code instead."
    : "Your location could not be found. Type a town or ZIP code instead.";
  locateMsg.textContent = text;
  // The note sits in the panel; on phones the sheet may be folded, so say it.
  if (isPhone() && panel.dataset.sheet === "peek") announce(text);
}
geoControl?.on("error", locateFailed);

// ------------------------------------------------ view and display settings
function syncModeLabel() {
  $("#sheet-mode").textContent = isSimple() ? "Simple" : "Expert";
  const d = document.documentElement.dataset;
  $("#prefs-now").textContent = `${isSimple() ? "Simple" : "Expert"} · ${({ 0: "small", 1: "medium", 2: "large", 3: "largest" })[d.text] || "small"} text${d.contrast === "high" ? " · high contrast" : ""}`;
}
// "View and text size" starts folded on every screen (closed in the HTML),
// so the layers come first.
document.addEventListener("pw:prefs", (e) => {
  const what = e.detail?.changed;
  if (what === "mode" || what === "storage") {
    if (layers.size) {
      renderPanel();
      renderLegend();
      renderCredits();
      renderListView();
      if (!detailsEl.hidden) hideDetails();
    }
    syncModeLabel();
    writeHash();
    announce(isSimple() ? "Simple view. Fewer layers with plain names." : "Expert view. All layers and full details.");
  }
  requestAnimationFrame(() => { syncOffsets(); map.resize(); });
});
syncModeLabel();

setSheet("peek");
boot();
