import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PAPER, THEME_BACKGROUNDS } from "../src/config/palette";

// Stage 8 design round: the map is the hero, the panel is a quiet control,
// warm BitPrairie chrome, Plex Sans only, no slop patterns.
const read = (p: string) => readFileSync(p, "utf8").toString();
const html = read("public/index.html");
const app = read("public/app.js");
const css = read("public/styles.css");
const brand = read("public/brand.css");
const page = read("public/page.css");
const allCss = [css, brand, page].join("\n");
const textPages = ["about", "status", "privacy", "offline"].map((p) => read(`public/${p}.html`));

describe("stage 8: panel is a control, not a document", () => {
  it("has no chip row, one legend and no jump tabs", () => {
    expect(html).not.toMatch(/active-chips|panel-legend|jump-tabs|data-jump/);
    expect(app).not.toMatch(/\[data-jump\]|jump-tabs/);
    expect(html.match(/class="legend"/g) ?? []).toHaveLength(1);
  });
  it("folds everything below the layer list into closed rows", () => {
    for (const id of ["sec-list", "sec-items", "sec-changes", "sec-updates", "sec-sources", "sec-share", "sec-planned", "panel-prefs"]) {
      const m = html.match(new RegExp(`<details class="([^"]*)" id="${id}">`));
      expect(m, id).not.toBeNull();
      expect(m![1]).toMatch(/\bfold\b/);
    }
    expect(html).not.toMatch(/<details class="fold[^"]*" id="[^"]+" open/);
    expect(css).toMatch(/\.fold > summary::-webkit-details-marker \{ display: none; \}/);
  });
  it("puts the layer list right after search, with Display last", () => {
    const iSearch = html.indexOf('class="search"');
    const iLayers = html.indexOf('id="sec-layers"');
    const iPrefs = html.indexOf('id="panel-prefs"');
    expect(iSearch).toBeGreaterThan(0);
    expect(iLayers).toBeGreaterThan(iSearch);
    expect(iPrefs).toBeGreaterThan(html.indexOf('id="sec-share"'));
  });
  it("replaces the welcome card with a one-line dismissible tip", () => {
    const hint = html.slice(html.indexOf('<aside id="first-hint"'), html.indexOf("</aside>", html.indexOf('<aside id="first-hint"')));
    expect(hint).not.toMatch(/<ul|<li|<h2/);
    expect(hint.match(/<p>/g) ?? []).toHaveLength(1);
    expect(hint).toMatch(/aria-label="Dismiss tip"/);
    expect(css).toMatch(/\.first-hint \{\s*position: absolute;[^}]*bottom:/);
  });
  it("has one filled primary action in the panel", () => {
    expect(html.match(/btn-solid/g) ?? []).toHaveLength(1);
    expect(html).toMatch(/class="btn btn-solid search-go"/);
  });
});

describe("stage 8: names, not codes", () => {
  it("shows agency codes as an Agency ID line, never as the name", () => {
    expect(app).toMatch(/const CODE_RE = /);
    expect(app).toMatch(/function itemName\(label, fallback\)/);
    expect(app).not.toMatch(/\$\{esc\(label\)\}<\/button>/);
    expect(app).toMatch(/<dt>Agency ID<\/dt>/);
    // Mirror the rule in the test so "CA131" is a code and a pack name is a name.
    const re = /^[A-Z]{1,5}[-_ ]?\d{1,7}\b/;
    expect(re.test("CA131")).toBe(true);
    expect(re.test("Lassen pack")).toBe(false);
  });
});

describe("stage 8: type, lines and icons", () => {
  it("uses Plex weights 400, 500 and 600 only", () => {
    const weights = [...allCss.matchAll(/font-weight: (\d{3})|font: (\d{3}) /g)].map((m) => m[1] ?? m[2]);
    expect(weights.length).toBeGreaterThan(10);
    for (const w of weights) expect(["400", "500", "600"]).toContain(w);
  });
  it("has no mono all-caps labels on the map or the text pages", () => {
    expect(allCss).not.toMatch(/text-transform: uppercase/);
    const monoUses = [...allCss.matchAll(/var\(--mono\)/g)];
    expect(monoUses).toHaveLength(0);
  });
  it("uses hairlines, no soft shadows and no decorative gradients", () => {
    for (const m of allCss.matchAll(/box-shadow: ([^;]+);/g)) {
      expect(m[1]).toMatch(/^(none|0 0 0 \dpx var\(--[a-z-]+\))$/);
    }
    for (const m of allCss.matchAll(/^.*gradient\(.*$/gm)) expect(m[0]).toMatch(/\.swatch\.mark-/);
  });
  it("draws UI icons at a 1.5 stroke; only the paw mark is 1.8", () => {
    for (const m of html.matchAll(/<svg class="([^"]*)"[^>]*stroke-width="([\d.]+)"/g)) {
      if (m[2] !== "1.5") expect(m[1]).toMatch(/proj-mark|splash-mark/);
    }
  });
  it("keeps 44px rows on touch", () => {
    const coarse = css.slice(css.indexOf("@media (pointer: coarse) {"));
    expect(coarse).toMatch(/--ctl: 44px;/);
    expect(coarse).toMatch(/\.fold > summary/);
  });
  it("has no em dashes in visible copy", () => {
    for (const t of [html, app, ...textPages]) expect(t).not.toContain("\u2014");
  });
});

describe("stage 8: warm BitPrairie chrome", () => {
  it("defines the warm tokens for light and dark", () => {
    for (const t of ["--paper: #f2ede4", "--card: #fffcf6", "--ink: #141416", "--accent: #6b4a2e", "--pasture: #5c6b4a", "--gold: #b0893e"]) {
      expect(brand).toContain(t);
    }
    expect(brand).toMatch(/--paper: #161310/);
    expect(brand).toMatch(/--ink: #f7f1e8/);
  });
  it("tints the basemap to match the launch screens", () => {
    expect(brand).toContain(`--map-bg: ${THEME_BACKGROUNDS.light[1]}`);
    expect(brand).toContain(`--map-bg: ${THEME_BACKGROUNDS.dark[0]}`);
    expect(app).toMatch(/map\.on\("style\.load", tintBasemap\)/);
    const manifest = JSON.parse(read("public/manifest.webmanifest"));
    expect(manifest.background_color).toBe(PAPER.light);
    expect(manifest.theme_color).toBe(PAPER.light);
  });
  it("lines text pages up with the masthead instead of a centered column", () => {
    const s8 = page.slice(page.indexOf("Design round (stage 8)"));
    expect(s8).toMatch(/main, \.page-prose main, \.page-wide main \{ margin: 0;/);
  });
});
