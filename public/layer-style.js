// Layer colors for the selector, the legend and the map, from one value.
// Each layer's color is `style.color` from /api/layers, which comes from
// src/config/palette.ts. Nothing here reads the theme, saved settings, list
// order, the URL or an agency renderer to pick a color. The theme only
// changes the thin outline drawn around points and swatches.

const HEX = /^#[0-9a-f]{6}$/i;
const FALLBACK = "#6a7687";

/** The layer's one fixed color. */
export function colorOf(layer) {
  // `layer.color` only appears in a layer list saved offline by an older version.
  const c = layer?.style?.color ?? layer?.color;
  return HEX.test(String(c)) ? String(c).toLowerCase() : FALLBACK;
}

/** Boundary layers draw as a dashed outline with no fill. */
export function isOutline(layer) {
  return Boolean(layer?.style?.dashed) || !layer?.style?.fillOpacity;
}

const FILLS = new Set(["solid", "hatch", "dots", "cross", "none"]);
const LINES = new Set(["solid", "dash", "dot", "dashdot", "long"]);
/**
 * Non-color cue: a fill pattern and an outline style per layer (from
 * src/config/views.ts), so layers are not told apart by color alone.
 */
export function markOf(layer) {
  const m = layer?.mark || {};
  return {
    fill: FILLS.has(m.fill) ? m.fill : isOutline(layer) ? "none" : "solid",
    line: LINES.has(m.line) ? m.line : layer?.style?.dashed ? "dash" : "solid",
    dash: Array.isArray(m.dash) ? m.dash : layer?.style?.dashed ? [3, 2] : null,
  };
}

/** Swatch markup for the layer list and the legend (identical in both). */
export function swatchHtml(layer) {
  const c = colorOf(layer);
  const kind = layer?.style?.dashed ? "dashed" : isOutline(layer) ? "outline" : "fill";
  const m = layer?.mark ? markOf(layer) : null;
  const cls = m ? ` mark-fill-${m.fill} mark-line-${m.line}` : "";
  return `<span class="swatch swatch-${kind}${cls}" style="--swatch:${c}" data-color="${c}" aria-hidden="true"></span>`;
}

/** MapLibre paint for an agency GeoJSON layer. */
export function vectorPaint(layer, theme = "light") {
  const c = colorOf(layer);
  const s = layer?.style || {};
  return {
    fill: { "fill-color": c, "fill-opacity": s.fillOpacity ?? 0.2 },
    line: { "line-color": c, "line-width": s.dashed ? 1.5 : 2, ...(markOf(layer).dash ? { "line-dasharray": markOf(layer).dash } : {}) },
    // The point outline follows the basemap so the dot stands out; the dot keeps its color.
    circle: { "circle-color": c, "circle-radius": 5, "circle-stroke-color": theme === "dark" ? "#161310" : "#ffffff", "circle-stroke-width": 1.5 },
  };
}

/** MapLibre paint for an agency vector-tile context layer. */
export function vectorTilePaint(layer) {
  const c = colorOf(layer);
  return { "fill-color": c, "fill-opacity": layer?.vector?.fill_opacity ?? 0.2, "fill-outline-color": c };
}

const httpsOnly = (u) => (/^https:\/\//i.test(String(u ?? "")) ? String(u) : null);

/**
 * Layers grouped by their short credit (credit_short from
 * src/config/sources.ts), in the order given, so the credits line names each
 * agency once. Each group links to the first layer's agency page.
 */
export function creditGroups(list) {
  const groups = new Map();
  for (const l of list) {
    const key = l.credit_short || l.agency;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { name: key, url: httpsOnly(l.info_url), layers: [] });
    groups.get(key).layers.push(l);
  }
  return [...groups.values()];
}
