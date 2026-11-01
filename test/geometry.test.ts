import { describe, expect, it } from "vitest";
import { esriToGeoJson } from "../src/lib/esri";
import { ensureUniqueIds, unwrapGeometry, unwrapLine } from "../src/lib/geometry";
import type { NormalizedFeature } from "../src/schema";

describe("antimeridian handling", () => {
  it("leaves ordinary lines untouched (same array)", () => {
    const l = [[-120, 40], [-119, 41]];
    expect(unwrapLine(l)).toBe(l);
  });

  it("makes rings that jump across 180 degrees continuous", () => {
    const ring = [[179, 51], [-179, 51], [-179, 52], [179, 52], [179, 51]];
    expect(unwrapLine(ring)).toEqual([[179, 51], [181, 51], [181, 52], [179, 52], [179, 51]]);
  });

  it("applies to Esri rings before orientation is computed", () => {
    // Clockwise exterior crossing the antimeridian.
    const g = esriToGeoJson({ rings: [[[179, 51], [179, 52], [-179, 52], [-179, 51], [179, 51]]] });
    expect(g?.type).toBe("Polygon");
    if (g?.type !== "Polygon") throw new Error();
    const xs = g.coordinates[0]!.map((c) => c[0]!);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(2);
  });

  it("unwraps every part of a MultiPolygon", () => {
    const g = unwrapGeometry({ type: "MultiPolygon", coordinates: [[[[179, 0], [-179, 0], [-179, 1], [179, 0]]]] });
    expect(g?.type === "MultiPolygon" && g.coordinates[0]![0]![1]![0]).toBe(181);
  });
});

describe("ensureUniqueIds", () => {
  const f = (id: string) => ({ type: "Feature", id, geometry: null, properties: { id } }) as unknown as NormalizedFeature;
  it("suffixes repeated ids and keeps properties.id in sync", () => {
    const out = ensureUniqueIds([f("a"), f("a"), f("b"), f("a")]);
    expect(out.map((x) => x.id)).toEqual(["a", "a~2", "b", "a~3"]);
    expect(out.map((x) => x.properties.id)).toEqual(["a", "a~2", "b", "a~3"]);
  });
});
