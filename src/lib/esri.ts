// Convert Esri JSON geometries (from ArcGIS REST `f=json`) to GeoJSON.
// Requested with outSR=4326, so coordinates are already longitude/latitude.
import type { Geometry } from "../schema";

export interface EsriGeometry {
  x?: number;
  y?: number;
  points?: number[][];
  paths?: number[][][];
  rings?: number[][][];
}

const xy = (c: number[]) => [c[0]!, c[1]!];

/** Shoelace sum. Positive means clockwise in lon/lat (y up). */
function ringSignedArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    sum += (b[0]! - a[0]!) * (b[1]! + a[1]!);
  }
  return sum;
}

function closeRing(ring: number[][]): number[][] {
  const r = ring.map(xy);
  if (r.length === 0) return r;
  const f = r[0]!;
  const l = r[r.length - 1]!;
  if (f[0] !== l[0] || f[1] !== l[1]) r.push([f[0]!, f[1]!]);
  return r;
}

function pointInRing(pt: number[], ring: number[][]): boolean {
  let inside = false;
  const [x, y] = pt as [number, number];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Esri polygons are a flat list of rings: clockwise rings are exterior,
 * counter-clockwise rings are holes. GeoJSON wants exterior-first polygons
 * (RFC 7946 prefers counter-clockwise exteriors, so we reverse orientation).
 */
function ringsToGeoJson(rings: number[][][]): Geometry | null {
  const outers: number[][][][] = [];
  const holes: number[][][] = [];
  for (const raw of rings) {
    if (raw.length < 4) continue;
    const ring = closeRing(raw);
    if (ringSignedArea(ring) >= 0) outers.push([ring.slice().reverse()]);
    else holes.push(ring.slice().reverse());
  }
  if (outers.length === 0 && holes.length > 0) {
    // Some servers emit counter-clockwise exteriors. Treat them as exteriors.
    for (const h of holes) outers.push([h.slice().reverse()]);
    holes.length = 0;
  }
  for (const hole of holes) {
    const probe = hole[0]!;
    const owner = outers.find((p) => pointInRing(probe, p[0]!)) ?? outers[outers.length - 1];
    owner?.push(hole);
  }
  if (outers.length === 0) return null;
  if (outers.length === 1) return { type: "Polygon", coordinates: outers[0]! };
  return { type: "MultiPolygon", coordinates: outers };
}

export function esriToGeoJson(g: EsriGeometry | null | undefined): Geometry | null {
  if (!g) return null;
  if (typeof g.x === "number" && typeof g.y === "number") {
    if (Number.isNaN(g.x) || Number.isNaN(g.y)) return null;
    return { type: "Point", coordinates: [g.x, g.y] };
  }
  if (g.points) return { type: "MultiPoint", coordinates: g.points.map(xy) };
  if (g.paths) {
    const paths = g.paths.map((p) => p.map(xy));
    return paths.length === 1
      ? { type: "LineString", coordinates: paths[0]! }
      : { type: "MultiLineString", coordinates: paths };
  }
  if (g.rings) return ringsToGeoJson(g.rings);
  return null;
}
