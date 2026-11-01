// Geometry and id helpers shared by adapters.
import type { Geometry, NormalizedFeature } from "../schema";

/**
 * Make a ring or line continuous across the antimeridian. Services that
 * return longitudes in -180..180 can jump from 179.9 to -179.9 inside one
 * ring, which renders as a band across the whole map. Shifting by 360 keeps
 * the shape intact; MapLibre draws longitudes outside -180..180 correctly.
 * Returns the input unchanged when there is no jump.
 */
export function unwrapLine(coords: number[][]): number[][] {
  let jumped = false;
  for (let i = 1; i < coords.length; i++) {
    if (Math.abs(coords[i]![0]! - coords[i - 1]![0]!) > 180) {
      jumped = true;
      break;
    }
  }
  if (!jumped) return coords;
  const out: number[][] = [];
  let prev: number | null = null;
  for (const c of coords) {
    let x = c[0]!;
    if (prev !== null) {
      while (x - prev > 180) x -= 360;
      while (x - prev < -180) x += 360;
    }
    out.push([x, ...c.slice(1)]);
    prev = x;
  }
  return out;
}

export function unwrapGeometry(g: Geometry | null): Geometry | null {
  if (!g) return g;
  switch (g.type) {
    case "LineString":
      return { ...g, coordinates: unwrapLine(g.coordinates) };
    case "MultiLineString":
    case "Polygon":
      return { ...g, coordinates: g.coordinates.map(unwrapLine) } as Geometry;
    case "MultiPolygon":
      return { ...g, coordinates: g.coordinates.map((p) => p.map(unwrapLine)) };
    default:
      return g;
  }
}

/**
 * Agencies sometimes repeat an "id" field (for example one weather alert that
 * covers many zones). Keep the first id as is and suffix later repeats so
 * every feature can be selected on its own.
 */
export function ensureUniqueIds(features: NormalizedFeature[]): NormalizedFeature[] {
  const seen = new Map<string, number>();
  for (const f of features) {
    const n = seen.get(f.id) ?? 0;
    seen.set(f.id, n + 1);
    if (n > 0) {
      let id = `${f.id}~${n + 1}`;
      while (seen.has(id)) id = `${id}~`;
      seen.set(id, 1);
      f.id = id;
      f.properties.id = id;
    }
  }
  return features;
}

export type BBox = [number, number, number, number];

/** [minX, minY, maxX, maxY] of a geometry, or null if it has no coordinates. */
export function bboxOf(g: Geometry | null): BBox | null {
  if (!g) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number") {
      const [x, y] = c as number[];
      if (x! < minX) minX = x!;
      if (x! > maxX) maxX = x!;
      if (y! < minY) minY = y!;
      if (y! > maxY) maxY = y!;
    } else if (Array.isArray(c)) c.forEach(walk);
  };
  walk(g.coordinates);
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

/**
 * Whether a feature box intersects a query box. Query boxes may cross the
 * antimeridian (minX > maxX, as OGC API Features allows), and feature boxes
 * may use longitudes beyond ±180 after unwrapping.
 */
export function bboxIntersects(f: BBox, q: BBox): boolean {
  if (f[1] > q[3] || f[3] < q[1]) return false;
  const spans: [number, number][] = q[0] <= q[2] ? [[q[0], q[2]]] : [[q[0], 180], [-180, q[2]]];
  for (const shift of [0, 360, -360]) {
    for (const [a, b] of spans) {
      if (f[0] + shift <= b && f[2] + shift >= a) return true;
    }
  }
  return false;
}
