import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

const read = (f: string) => readFileSync(`public/${f}`, "utf8");
const index = read("index.html");
const about = read("about.html");
const credits = read("credits.js");
const app = read("app.js");
const sw = read("sw.js");
const headers = read("_headers");
const css = read("styles.css");
const page = read("page.css");
// Stage 8 folded the per-round override sections into one stylesheet.
const stage7 = css;
const page7 = page.slice(page.indexOf("/* ---- Mobile and app round (stage 7)"));
const maplibreVersion = JSON.parse(readFileSync("node_modules/maplibre-gl/package.json", "utf8")).version;

describe("mobile round (stage 7)", () => {
  it("stacks the /about sources table into cards on phones, with labels and kept roles", () => {
    expect(about).toMatch(/<table class="sources-table stack-table"/);
    expect(about).not.toMatch(/scrolls sideways/);
    expect(credits).toMatch(/<td data-label="Credit">/);
    expect(credits).toMatch(/<td data-label="Agency updated">/);
    expect(credits).toMatch(/keepTableRoles\(tbody\.closest\("table"\)\)/);
    expect(page7).toMatch(/@media \(max-width: 640px\)[\s\S]*\.sources-table\.stack-table tr \{ grid-template-columns: 1fr;/);
  });

  it("links the status page from the map masthead", () => {
    const actions = index.slice(index.indexOf('class="topbar-actions"'), index.indexOf("</header>"));
    expect(actions).toMatch(/<a id="status-link" class="btn btn-ghost" href="\/status">Status<\/a>/);
    expect(actions.indexOf('id="about-open"')).toBeLessThan(actions.indexOf('id="status-link"'));
  });

  it("never cuts the word Layers in the phone sheet header", () => {
    expect(index).toMatch(/<span class="sheet-title">Layers<\/span><span id="sheet-count" class="sheet-count"><\/span>/);
    expect(stage7).toMatch(/\.sheet-title, :root\[data-text\] \.sheet-title \{ flex: none; overflow: visible; text-overflow: clip; font: 600 16px\/1\.2 var\(--sans\);/);
    // Only the view name may shorten, never the title.
    expect(stage7).toMatch(/\.sheet-mode, :root\[data-text\] \.sheet-mode \{ flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;/);
  });

  it("serves the map library from a versioned folder cached as immutable", () => {
    const folder = `/vendor/maplibre-gl-${maplibreVersion}/`;
    expect(index).toContain(`href="${folder}maplibre-gl.css"`);
    expect(app).toContain(`from "${folder}maplibre-gl.mjs"`);
    expect(index).not.toMatch(/maplibre-gl\.js/);
    expect(sw).toContain(`"${folder}maplibre-gl.mjs"`);
    expect(sw).toContain(`"${folder}maplibre-gl-worker.mjs"`);
    expect(index).not.toMatch(/\/vendor\/maplibre-gl\//);
    expect(headers).toMatch(/\/vendor\/\*\n\s+Cache-Control: public, max-age=31536000, immutable/);
    expect(existsSync(`public${folder}maplibre-gl.mjs`)).toBe(true);
    expect(existsSync(`public${folder}maplibre-gl-worker.mjs`)).toBe(true);
  });

  it("stops pull-to-refresh and page bounce on the map, keeps inner scrolling", () => {
    expect(stage7).toMatch(/html, body \{ overscroll-behavior: none; \}/);
    expect(stage7).toMatch(/\.details, \.sources-panel, \.legend ul \{ overscroll-behavior: contain; \}/);
    expect(page7).not.toMatch(/overscroll-behavior: none/);
  });

  it("keeps a one-line masthead and clears the side notch on landscape phones", () => {
    expect(stage7).toMatch(/@media \(max-width: 760px\) and \(max-height: 500px\) \{\n\s+\.byline \{ display: none; \}/);
    expect(stage7).toMatch(/\.maplibregl-ctrl-top-right \{ padding-right: env\(safe-area-inset-right\); \}/);
  });

  it("gives Sources links full touch targets and keeps search input at 16px or more", () => {
    const coarse = css.slice(css.indexOf("@media (pointer: coarse) {"), css.indexOf("/* ------------------------------------------------------------ phones */"));
    expect(coarse).toMatch(/\.sources-list a, \.sources-more a, \.search-results button \{ min-height: 44px; \}/);
    expect(coarse).toMatch(/\.exports a, \.sources-list a, \.sources-more a \{ display: inline-flex; align-items: center; \}/);
    // iOS zooms into inputs under 16px; the search and filter boxes use 1rem or more.
    expect(css).not.toMatch(/#search-q[^{]*\{[^}]*font-size: (?:0?\.\d+rem|1[0-5]px)/);
  });

  it("says plainly when the map shows saved data, with the time", () => {
    expect(index).toMatch(/<p id="offline-bar" class="offline-bar" role="status" aria-live="polite" hidden><\/p>/);
    expect(app).toMatch(/Showing data saved on this device, last updated \$\{fmtTime\(saved\[0\]\)\}\. It may be out of date\./);
    expect(app).toMatch(/addEventListener\("offline", renderOffline\)/);
    expect(app).toMatch(/addEventListener\("online"/);
  });
});
