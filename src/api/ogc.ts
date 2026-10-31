// A small, read-only OGC API - Features style endpoint over the cached public
// sources. Implements the Core and GeoJSON conformance classes: landing page,
// conformance, collections, items (bbox, limit, offset) and single items.
// https://docs.ogc.org/is/17-069r4/17-069r4.html
import type { NormalizedCollection, NormalizedFeature } from "../schema";
import { bboxIntersects, bboxOf, type BBox } from "../lib/geometry";

export const OGC_DEFAULT_LIMIT = 100;
export const OGC_MAX_LIMIT = 1000;

export const CONFORMANCE = [
  "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
  "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson",
];

export class BadRequest extends Error {}

/** Parse and validate `bbox=minLon,minLat,maxLon,maxLat` (WGS 84). */
export function parseBbox(v: string | null): BBox | null {
  if (v === null) return null;
  const parts = v.split(",");
  if (parts.length !== 4) throw new BadRequest("bbox must be minLon,minLat,maxLon,maxLat");
  const n = parts.map((p) => (/^\s*-?\d+(\.\d+)?\s*$/.test(p) ? Number(p) : NaN));
  if (n.some((x) => !Number.isFinite(x))) throw new BadRequest("bbox values must be numbers");
  const [x0, y0, x1, y1] = n as BBox;
  if (x0 < -180 || x0 > 180 || x1 < -180 || x1 > 180) throw new BadRequest("bbox longitudes must be within -180..180");
  if (y0 < -90 || y0 > 90 || y1 < -90 || y1 > 90) throw new BadRequest("bbox latitudes must be within -90..90");
  if (y0 > y1) throw new BadRequest("bbox minLat must not exceed maxLat");
  return [x0, y0, x1, y1];
}

export function parseIntParam(v: string | null, name: string, def: number, min: number, max: number): number {
  if (v === null) return def;
  if (!/^\d{1,7}$/.test(v)) throw new BadRequest(`${name} must be a whole number`);
  const n = Number(v);
  if (n < min || n > max) throw new BadRequest(`${name} must be between ${min} and ${max}`);
  return n;
}

const ALLOWED_ITEM_PARAMS = new Set(["bbox", "limit", "offset", "f"]);

export function landing(base: string) {
  return {
    title: "Predator Watch public data",
    description:
      "Read-only access to the public agency data shown on the Predator Watch map. Each collection is one source, at the precision the agency publishes.",
    links: [
      { href: `${base}/ogc`, rel: "self", type: "application/json", title: "This document" },
      { href: `${base}/ogc/conformance`, rel: "conformance", type: "application/json", title: "Conformance classes" },
      { href: `${base}/ogc/collections`, rel: "data", type: "application/json", title: "Collections" },
      {
        href: "https://github.com/steelhead99x/predator-watch-app/blob/main/docs/api.md",
        rel: "service-doc",
        type: "text/html",
        title: "API documentation",
      },
    ],
  };
}

export function collectionInfo(
  base: string,
  fc: Pick<NormalizedCollection, "metadata"> & { features?: NormalizedFeature[] },
) {
  const s = fc.metadata.source;
  const id = s.id;
  const out: Record<string, unknown> = {
    id,
    title: `${s.name} (${s.agency})`,
    description: `${s.cadence} Terms: ${s.license}`,
    attribution: s.attribution,
    itemType: "feature",
    crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"],
    links: [
      { href: `${base}/ogc/collections/${id}`, rel: "self", type: "application/json" },
      { href: `${base}/ogc/collections/${id}/items`, rel: "items", type: "application/geo+json" },
      { href: `${base}/api/sources/${id}.geojson`, rel: "enclosure", type: "application/geo+json", title: "Full GeoJSON download" },
      { href: `${base}/api/sources/${id}.kml`, rel: "enclosure", type: "application/vnd.google-earth.kml+xml", title: "KML download" },
      { href: `${base}/api/sources/${id}.csv`, rel: "enclosure", type: "text/csv", title: "CSV download" },
      { href: s.info_url, rel: "describedby", type: "text/html", title: "Agency page" },
      { href: s.url, rel: "via", title: "Agency endpoint" },
    ],
  };
  if (fc.features?.length) {
    let ext: BBox | null = null;
    for (const f of fc.features) {
      const b = bboxOf(f.geometry);
      if (!b) continue;
      ext = ext ? [Math.min(ext[0], b[0]), Math.min(ext[1], b[1]), Math.max(ext[2], b[2]), Math.max(ext[3], b[3])] : b;
    }
    if (ext) {
      const clamp = (x: number) => Math.max(-180, Math.min(180, x));
      out.extent = { spatial: { bbox: [[clamp(ext[0]), ext[1], clamp(ext[2]), ext[3]]] } };
    }
  }
  return out;
}

export function items(base: string, fc: NormalizedCollection, params: URLSearchParams) {
  for (const k of params.keys()) {
    if (!ALLOWED_ITEM_PARAMS.has(k)) throw new BadRequest(`unknown parameter: ${k}`);
  }
  const f = params.get("f");
  if (f !== null && f !== "json" && f !== "geojson") throw new BadRequest("f must be json or geojson");
  const bbox = parseBbox(params.get("bbox"));
  const limit = parseIntParam(params.get("limit"), "limit", OGC_DEFAULT_LIMIT, 1, OGC_MAX_LIMIT);
  const offset = parseIntParam(params.get("offset"), "offset", 0, 0, 10_000_000);

  const matched = bbox
    ? fc.features.filter((x) => {
        const b = bboxOf(x.geometry);
        return b !== null && bboxIntersects(b, bbox);
      })
    : fc.features;
  const page = matched.slice(offset, offset + limit);
  const id = fc.metadata.source.id;
  const q = (o: number) => {
    const p = new URLSearchParams();
    if (bbox) p.set("bbox", bbox.join(","));
    p.set("limit", String(limit));
    if (o) p.set("offset", String(o));
    return `${base}/ogc/collections/${id}/items?${p}`;
  };
  const links: { href: string; rel: string; type: string }[] = [
    { href: q(offset), rel: "self", type: "application/geo+json" },
    { href: `${base}/ogc/collections/${id}`, rel: "collection", type: "application/json" },
  ];
  if (offset + limit < matched.length) links.push({ href: q(offset + limit), rel: "next", type: "application/geo+json" });
  if (offset > 0) links.push({ href: q(Math.max(0, offset - limit)), rel: "prev", type: "application/geo+json" });
  return {
    type: "FeatureCollection",
    timeStamp: fc.metadata.received_at ?? fc.metadata.checked_at ?? null,
    numberMatched: matched.length,
    numberReturned: page.length,
    features: page,
    links,
  };
}
