import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LAYER_COLORS } from "../src/config/palette";
import { LAYER_MARKS, LINE_DASH, SIMPLE_GROUPS, SIMPLE_LAYERS } from "../src/config/views";
import { RASTER_LAYERS, SOURCES } from "../src/config/sources";

const DEFAULT_ON: string[] = [
  ...SOURCES.filter((s) => s.style?.defaultVisible).map((s) => s.id),
  ...RASTER_LAYERS.filter((r) => (r as { defaultVisible?: boolean }).defaultVisible).map((r) => r.id),
];

const STATES = ["Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware","Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts","Michigan","Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey","New Mexico","New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania","Rhode Island","South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont","Virginia","Washington","West Virginia","Wisconsin","Wyoming"];

describe("Simple view", () => {
  it("lists only real layers, each once, and every one has plain copy", () => {
    const ids = SIMPLE_GROUPS.flatMap((g) => g.layers);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(LAYER_COLORS[id]).toBeTruthy();
      const s = SIMPLE_LAYERS[id];
      expect(s?.name.length).toBeGreaterThan(3);
      expect(s?.popup).toMatch(/\.$|by$/);
    }
    expect(SIMPLE_GROUPS.length).toBeLessThanOrEqual(4);
  });

  it("starts with only the four wolf activity layers on", () => {
    expect(DEFAULT_ON.sort()).toEqual(["cdfw-collared-wolf-cells", "mtfwp-wolf-distribution", "usfws-mexican-wolf-occupied-range-2023", "wdfw-wolf-packs-current"]);
  });

  it("includes every layer that is on by default, so defaults match Expert view", () => {
    const ids = new Set(SIMPLE_GROUPS.flatMap((g) => g.layers));
    for (const id of DEFAULT_ON) expect(ids.has(id as never)).toBe(true);
  });

  it("uses plain words and follows the copy rules", () => {
    const text = JSON.stringify([SIMPLE_GROUPS, SIMPLE_LAYERS]);
    for (const st of STATES) expect(text).not.toContain(st);
    expect(text).not.toMatch(/\bproducers?\b|\bAI\b|in the middle/i);
    expect(text).not.toMatch(/OBJECTID|GlobalID|FeatureServer|MapServer/);
  });
});

describe("non-color cues", () => {
  it("gives every layer a mark, and the default layers distinct ones", () => {
    for (const id of Object.keys(LAYER_COLORS)) expect(LAYER_MARKS[id as keyof typeof LAYER_MARKS]).toBeTruthy();
    const marks = DEFAULT_ON.map((id) => JSON.stringify(LAYER_MARKS[id as keyof typeof LAYER_MARKS]));
    expect(new Set(marks).size).toBe(marks.length);
    expect(LINE_DASH.solid).toBeNull();
  });

  it("draws the marks in swatches and on the map", () => {
    const style = readFileSync("public/layer-style.js", "utf8");
    const css = readFileSync("public/styles.css", "utf8");
    expect(style).toMatch(/mark-fill-/);
    expect(style).toMatch(/line-dasharray/);
    for (const m of ["hatch", "dots", "cross"]) expect(css).toContain(`.mark-fill-${m}`);
  });
});
