import { describe, expect, it } from "vitest";
import { validateArcGisConfig } from "../src/adapters/arcgis";
import { RASTER_LAYERS, SOURCES } from "../src/config/sources";
import { publicInfo, Registry } from "../src/registry";

describe("source registry", () => {
  it("builds an adapter for every configured source", () => {
    const r = new Registry();
    expect(r.ids()).toEqual(SOURCES.map((s) => s.id));
    for (const a of r.all()) expect(publicInfo(a).url).toMatch(/^https:\/\//);
  });

  it("rejects duplicate ids", () => {
    expect(() => new Registry([SOURCES[0]!, SOURCES[0]!])).toThrow(/Duplicate/);
  });

  it("every source has attribution, license, cadence and an https info page", () => {
    for (const s of SOURCES) {
      expect(s.attribution, s.id).toBeTruthy();
      expect(s.license, s.id).toBeTruthy();
      expect(s.cadence, s.id).toBeTruthy();
      expect(s.agency, s.id).toBeTruthy();
      expect(s.infoUrl, s.id).toMatch(/^https:\/\//);
      if (s.type === "arcgis") expect(validateArcGisConfig(s)).toEqual([]);
    }
    for (const r of RASTER_LAYERS) {
      expect(r.tiles[0]).toMatch(/^https:\/\//);
      expect(r.attribution).toBeTruthy();
    }
  });

  it("keeps predator layers species-tagged and context layers species-free", () => {
    for (const s of SOURCES) {
      if (s.category === "context") expect(s.species).toBeNull();
      else if (s.category === "bear") expect(s.species).toMatch(/bear/i);
      else expect(s.species).toMatch(/wolf/i);
    }
  });

  it("turns on only wolf layers by default; bears, wildfire and context start off", () => {
    const on = SOURCES.filter((s) => s.style.defaultVisible);
    expect(on.length).toBeGreaterThan(0);
    for (const s of on) expect(s.category, s.id).toMatch(/^wolf-/);
    expect(SOURCES.some((s) => s.category === "bear")).toBe(true);
    for (const r of RASTER_LAYERS) expect((r.style as { defaultVisible?: boolean } | undefined)?.defaultVisible, r.id).toBeFalsy();
  });
});
