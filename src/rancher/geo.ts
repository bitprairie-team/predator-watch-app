// Small geometry helpers (WGS84 lon/lat). Accurate enough for "within N miles"
// and "inside this allotment" questions; not for surveying.
import type { Geometry } from "../schema";

export type LonLat = [number, number];
const R_MILES = 3958.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineMiles(a: LonLat, b: LonLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Polygons of a geometry as arrays of rings. Points and lines return []. */
export function polygonsOf(g: Geometry | null): number[][][][] {
  if (!g) return [];
  if (g.type === "Polygon") return [g.coordinates];
  if (g.type === "MultiPolygon") return g.coordinates;
  return [];
}

export function verticesOf(g: Geometry | null): LonLat[] {
  if (!g) return [];
  switch (g.type) {
    case "Point":
      return [g.coordinates as LonLat];
    case "MultiPoint":
    case "LineString":
      return g.coordinates as LonLat[];
    case "MultiLineString":
    case "Polygon":
      return g.coordinates.flat() as LonLat[];
    case "MultiPolygon":
      return g.coordinates.flat(2) as LonLat[];
  }
}

function segmentsOf(g: Geometry | null): [LonLat, LonLat][] {
  if (!g) return [];
  const lines: number[][][] =
    g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : g.type === "Polygon" ? g.coordinates : g.type === "MultiPolygon" ? g.coordinates.flat() : [];
  const out: [LonLat, LonLat][] = [];
  for (const l of lines) for (let i = 1; i < l.length; i++) out.push([l[i - 1] as LonLat, l[i] as LonLat]);
  return out;
}

function inRing(p: LonLat, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as LonLat;
    const [xj, yj] = ring[j] as LonLat;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInGeometry(p: LonLat, g: Geometry | null): boolean {
  return polygonsOf(g).some((poly) => poly[0] !== undefined && inRing(p, poly[0]) && !poly.slice(1).some((h) => inRing(p, h)));
}

/** Distance in miles from a point to a segment, using a local flat projection. */
function pointSegmentMiles(p: LonLat, a: LonLat, b: LonLat): number {
  const k = Math.cos(rad(p[1]));
  const ax = (a[0] - p[0]) * k, ay = a[1] - p[1];
  const bx = (b[0] - p[0]) * k, by = b[1] - p[1];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.sqrt(cx * cx + cy * cy) * 69.172;
}

/** Miles from a point to the nearest part of a geometry (0 if inside a polygon). */
export function distanceMiles(p: LonLat, g: Geometry | null): number {
  if (!g) return Infinity;
  if (pointInGeometry(p, g)) return 0;
  let best = Infinity;
  for (const [a, b] of segmentsOf(g)) best = Math.min(best, pointSegmentMiles(p, a, b));
  for (const v of verticesOf(g)) best = Math.min(best, haversineMiles(p, v));
  return best;
}

function segmentsCross(a: LonLat, b: LonLat, c: LonLat, d: LonLat): boolean {
  const o = (p: LonLat, q: LonLat, r: LonLat) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

/** True if two geometries overlap or touch (polygon/line/point combinations). */
export function intersects(a: Geometry | null, b: Geometry | null): boolean {
  if (!a || !b) return false;
  if (verticesOf(a).some((v) => pointInGeometry(v, b))) return true;
  if (verticesOf(b).some((v) => pointInGeometry(v, a))) return true;
  const sa = segmentsOf(a), sb = segmentsOf(b);
  for (const [p, q] of sa) for (const [r, s] of sb) if (segmentsCross(p, q, r, s)) return true;
  return false;
}
