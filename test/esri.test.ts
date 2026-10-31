import { describe, expect, it } from "vitest";
import { esriToGeoJson } from "../src/lib/esri";

describe("esriToGeoJson", () => {
  it("converts points", () => {
    expect(esriToGeoJson({ x: -120.5, y: 40.1 })).toEqual({ type: "Point", coordinates: [-120.5, 40.1] });
  });

  it("returns null for missing or empty geometry", () => {
    expect(esriToGeoJson(null)).toBeNull();
    expect(esriToGeoJson({ rings: [] })).toBeNull();
    expect(esriToGeoJson({ x: Number.NaN, y: 1 })).toBeNull();
  });

  it("converts a clockwise exterior with a counter-clockwise hole into one polygon", () => {
    const outer = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]; // clockwise (Esri exterior)
    const hole = [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]]; // counter-clockwise (Esri hole)
    const g = esriToGeoJson({ rings: [outer, hole] });
    expect(g?.type).toBe("Polygon");
    if (g?.type !== "Polygon") throw new Error();
    expect(g.coordinates).toHaveLength(2);
    // RFC 7946 orientation: exterior counter-clockwise
    expect(g.coordinates[0]).toEqual([...outer].reverse());
  });

  it("converts two exteriors into a MultiPolygon and closes open rings", () => {
    const a = [[0, 0], [0, 1], [1, 1], [1, 0]];
    const b = [[5, 5], [5, 6], [6, 6], [6, 5], [5, 5]];
    const g = esriToGeoJson({ rings: [a, b] });
    expect(g?.type).toBe("MultiPolygon");
    if (g?.type !== "MultiPolygon") throw new Error();
    const first = g.coordinates[0]![0]!;
    expect(first[0]).toEqual(first[first.length - 1]);
  });

  it("converts paths to LineString / MultiLineString", () => {
    expect(esriToGeoJson({ paths: [[[0, 0], [1, 1]]] })?.type).toBe("LineString");
    expect(esriToGeoJson({ paths: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] })?.type).toBe("MultiLineString");
  });
});
