import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CONTROL_COLORS, LAND_MANAGER_COLORS, LAYER_COLORS, THEME_BACKGROUNDS, esriRgba, layerColor } from "../src/config/palette";
import { LAND_CLASSES, RASTER_LAYERS, SOURCES, landManagerTiles } from "../src/config/sources";
import { publicInfo, Registry } from "../src/registry";

// public/layer-style.js is the browser module that paints the selector, the
// legend and the map; load it as-is so the test checks the shipped code.
const STYLE_PATH = "../public/layer-style.js";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const styleJs: any = await import(/* @vite-ignore */ STYLE_PATH as string);

const HEX = /^#[0-9a-f]{6}$/;
function lum(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [x = 0, y = 0] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
/** CIE76 distance in Lab, so colors that look alike are caught. */
function lab(hex: string): [number, number, number] {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const Y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const Z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
const dE = (a: string, b: string) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]!));
const allBackgrounds = [...THEME_BACKGROUNDS.light, ...THEME_BACKGROUNDS.dark];

const registry = new Registry();
const vectorLayers = registry.all().map((a) => publicInfo(a));
const allLayers = [...vectorLayers.map((l) => ({ id: l.id, style: l.style })), ...RASTER_LAYERS.map((r) => ({ id: r.id, style: r.style }))];

describe("layer palette", () => {
  it("gives every layer a palette entry, and every palette entry a layer", () => {
    const ids = allLayers.map((l) => l.id).sort();
    expect(Object.keys(LAYER_COLORS).sort()).toEqual(ids);
  });

  it("gives each layer one fixed, unique color from the palette", () => {
    const seen = new Map<string, string>();
    for (const l of allLayers) {
      const c = l.style!.color;
      expect(c, l.id).toMatch(HEX);
      expect(c, l.id).toBe(layerColor(l.id as keyof typeof LAYER_COLORS));
      expect(seen.get(c), `${l.id} shares ${c}`).toBeUndefined();
      seen.set(c, l.id);
    }
  });

  it("keeps colors apart enough to tell layers from each other", () => {
    const cs = Object.entries(LAYER_COLORS);
    for (let i = 0; i < cs.length; i++)
      for (let j = i + 1; j < cs.length; j++)
        expect(dE(cs[i]![1], cs[j]![1]), `${cs[i]![0]} vs ${cs[j]![0]}`).toBeGreaterThan(12);
  });

  it("has at least 3:1 contrast on every light and dark background, so no dark variant is needed", () => {
    const all: [string, string][] = [...Object.entries(LAYER_COLORS), ...Object.entries(LAND_MANAGER_COLORS), ["checked", CONTROL_COLORS.checked]];
    for (const [id, c] of all) {
      for (const bg of allBackgrounds) expect(contrast(c, bg), `${id} on ${bg}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(CONTROL_COLORS.check, CONTROL_COLORS.checked)).toBeGreaterThanOrEqual(4.5);
  });

  it("is the same value in the selector swatch, the legend and the map paint, in both themes", () => {
    for (const l of vectorLayers) {
      const c = l.style.color;
      const sw = styleJs.swatchHtml(l) as string;
      expect(sw, l.id).toContain(`--swatch:${c}`);
      expect(sw, l.id).toContain(`data-color="${c}"`);
      for (const theme of ["light", "dark"]) {
        const p = styleJs.vectorPaint(l, theme);
        expect(p.fill["fill-color"], l.id).toBe(c);
        expect(p.line["line-color"], l.id).toBe(c);
        expect(p.circle["circle-color"], l.id).toBe(c);
      }
    }
    for (const r of RASTER_LAYERS) {
      expect(styleJs.colorOf(r), r.id).toBe(r.style!.color);
      if (r.vector) expect(styleJs.vectorTilePaint(r)["fill-color"], r.id).toBe(r.style!.color);
    }
  });

  it("does not pick colors from the theme, randomness, hashes or list order", () => {
    const js = readFileSync("public/layer-style.js", "utf8") + readFileSync("public/app.js", "utf8");
    expect(js).not.toMatch(/Math\.random|colorDark|hsl\(|COLORS\[\s*i|palette\[\s*(i|idx|index)/);
    expect(readFileSync("src/config/sources.ts", "utf8")).not.toMatch(/colorDark|Math\.random/);
    // Identical input gives identical output, whatever the theme.
    const l = vectorLayers[0]!;
    expect(styleJs.vectorPaint(l, "dark").fill).toEqual(styleJs.vectorPaint(l, "light").fill);
  });

  it("draws agency map services in the layer's palette color when drawn_in_palette is set", () => {
    for (const r of RASTER_LAYERS.filter((x) => x.drawn_in_palette && !x.classes && !x.vector)) {
      const url = decodeURIComponent(r.tiles[0]!);
      const [cr, cg, cb] = esriRgba(r.style!.color, 0);
      expect(url, r.id).toContain(`[${cr},${cg},${cb},`);
    }
  });
});

describe("land manager colors", () => {
  const sma = RASTER_LAYERS.find((r) => r.id === "blm-surface-management-agency")!;

  it("lists each managing agency once with a fixed, distinct color", () => {
    expect(sma.classes).toBe(LAND_CLASSES);
    expect(LAND_CLASSES.map((c) => c.key)).toEqual(["blm", "usfs", "nps", "usfws", "dod", "bor", "tribal", "state", "other"]);
    for (const c of LAND_CLASSES) expect(c.color).toBe(LAND_MANAGER_COLORS[c.key]);
    const cs = Object.values(LAND_MANAGER_COLORS);
    expect(new Set(cs).size).toBe(cs.length);
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) expect(dE(cs[i]!, cs[j]!)).toBeGreaterThan(12);
    const codes = LAND_CLASSES.flatMap((c) => c.codes);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("has the map server draw the same colors as the mini legend", () => {
    const url = new URL(landManagerTiles());
    const dl = JSON.parse(url.searchParams.get("dynamicLayers")!);
    const r = dl[0].drawingInfo.renderer;
    expect(r.field1).toBe("ADMIN_AGENCY_CODE");
    for (const c of LAND_CLASSES) {
      for (const code of c.codes) {
        const info = r.uniqueValueInfos.find((u: { value: string }) => u.value === code);
        expect(info.symbol.color.slice(0, 3), code).toEqual(esriRgba(c.color, 0).slice(0, 3));
      }
    }
    expect(r.defaultSymbol.color.slice(0, 3)).toEqual(esriRgba(LAND_MANAGER_COLORS.other, 0).slice(0, 3));
    expect(sma.tiles[0]).toBe(landManagerTiles());
  });

  it("explains the layer in plain words, starts off and needs zooming in", () => {
    expect(sma.name).toBe("Who manages the land");
    expect(sma.attribution).toBe("Bureau of Land Management, Surface Management Agency");
    expect(sma.summary).toMatch(/Not mineral rights or exact property lines/);
    expect(sma.minzoom).toBeGreaterThanOrEqual(6);
    expect(sma.zoom_hint).toBe("Zoom in to see land managers");
    expect(sma.identify?.url).toMatch(/^https:\/\/gis\.blm\.gov\/.+\/identify$/);
    for (const c of LAND_CLASSES) expect(c.meaning.length, c.key).toBeGreaterThan(10);
    expect((sma as { visible?: boolean }).visible).toBeFalsy();
  });
});

describe("source config", () => {
  it("uses one palette color for each configured source", () => {
    for (const s of SOURCES) expect(s.style.color, s.id).toBe(layerColor(s.id as keyof typeof LAYER_COLORS));
  });
});
