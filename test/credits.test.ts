import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BASEMAP_CREDITS, RASTER_LAYERS, SOURCES } from "../src/config/sources";
import { publicInfo, Registry } from "../src/registry";

const STYLE_PATH = "../public/layer-style.js";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const styleJs: any = await import(/* @vite-ignore */ STYLE_PATH as string);
const html = readFileSync("public/index.html", "utf8");

describe("credits", () => {
  it("shows the basemap credit, from sources.ts, in the always-visible credits bar", () => {
    const bar = html.slice(html.indexOf('id="credits-bar"'), html.indexOf('id="sources-open"'));
    expect(bar.length).toBeGreaterThan(0);
    // What assistive tech reads: drop the aria-hidden short form ("OSM") and
    // the wrapper spans around the full form, which phones show visually short.
    const spoken = bar.replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, "").replace(/<\/?span[^>]*>/g, "");
    for (const c of BASEMAP_CREDITS) expect(spoken).toContain(`<a href="${c.url}" rel="noopener">${c.name}</a>`);
    expect(BASEMAP_CREDITS.map((c) => c.url)).toContain("https://www.openstreetmap.org/copyright");
    // MapLibre's own collapsible attribution control is replaced, not stacked.
    expect(readFileSync("public/app.js", "utf8")).toMatch(/attributionControl: false/);
  });

  it("gives every layer a short credit and an https source page", () => {
    for (const s of SOURCES) {
      const p = publicInfo(new Registry().get(s.id)!);
      expect(p.credit_short, s.id).toBeTruthy();
      expect(p.credit_short.length, s.id).toBeLessThanOrEqual(40);
      expect(p.info_url, s.id).toMatch(/^https:\/\//);
    }
    for (const r of RASTER_LAYERS) {
      expect(r.credit_short, r.id).toBeTruthy();
      expect(r.info_url, r.id).toMatch(/^https:\/\//);
    }
  });

  it("names each agency once in the credits line and links its source page", () => {
    const groups = styleJs.creditGroups([
      { credit_short: "BLM", info_url: "https://www.blm.gov/a" },
      { credit_short: "BLM", info_url: "https://www.blm.gov/b" },
      { credit_short: "Montana FWP", info_url: "javascript:alert(1)" },
      { agency: "NIFC", info_url: "https://data-nifc.opendata.arcgis.com/" },
    ]);
    expect(groups.map((g: { name: string }) => g.name)).toEqual(["BLM", "Montana FWP", "NIFC"]);
    expect(groups[0].url).toBe("https://www.blm.gov/a");
    expect(groups[0].layers).toHaveLength(2);
    expect(groups[1].url).toBeNull();
  });

  it("lists all sources with full credits on /about and links /status from the Sources panel", () => {
    const about = readFileSync("public/about.html", "utf8");
    expect(about).toMatch(/id="sources-rows"/);
    expect(about).toMatch(/<script type="module" src="\/credits\.js"><\/script>|<script src="\/credits\.js"/);
    expect(html).toMatch(/id="sources-panel"/);
    expect(html.slice(html.indexOf('id="sources-panel"'))).toMatch(/href="\/status"/);
  });
});
