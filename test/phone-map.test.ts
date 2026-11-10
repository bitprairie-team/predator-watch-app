import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const html = readFileSync("public/index.html", "utf8");
const css = readFileSync("public/styles.css", "utf8");
const app = readFileSync("public/app.js", "utf8");
const phoneRules = css.slice(css.indexOf("@media (max-width: 760px) {"));

describe("phone map layout", () => {
  it("keeps the basemap credit on one compact strip and moves agency credits behind a Data button", () => {
    const bar = html.slice(html.indexOf('id="credits-bar"'), html.indexOf("</div>", html.indexOf('id="sources-open"')));
    expect(bar).toMatch(/<span class="osm-short" aria-hidden="true">OSM<\/span>/);
    expect(bar).toMatch(/<span class="src-phone"><span id="credits-count">/);
    expect(bar).toMatch(/<span class="src-wide">Sources<\/span>/);
    expect(phoneRules).toMatch(/\.credits-agencies \{ display: none; \}/);
    // Fixed px sizes: larger text settings do not grow the credits bar.
    expect(phoneRules).toMatch(/:root\[data-text\] \.credits-bar \{\s*font-size: 11px/);
    expect(phoneRules).toMatch(/\.credits-agencies \{ display: none; \}/);
    expect(phoneRules).toMatch(/\.credits-btn, :root\[data-text\] \.credits-btn \{[^}]*min-height: 44px/);
    expect(app).toMatch(/#credits-count"\)\.textContent = `\$\{n\} source\$\{n === 1 \? "" : "s"\}`/);
  });

  it("keeps at least 45% of the screen for the map when the sheet is at half", () => {
    expect(phoneRules).toMatch(/\.panel\[data-sheet="half"\] \{ height: max\(120px, min\(46%, calc\(100% - var\(--credits-h, 46px\) - 45vh\)\)\); \}/);
    expect(phoneRules).toMatch(/45dvh/);
    expect(app).toMatch(/half: halfSheetPx\(total\)/);
    expect(app).toMatch(/total - creditsH - window\.innerHeight \* 0\.45/);
  });

  it("shows the legend as a 44px icon and label chip on phones", () => {
    expect(html).toMatch(/<summary><svg class="ico legend-icon"[^>]*aria-hidden="true"[^>]*>.*<\/svg><span>Legend<\/span><\/summary>/);
    expect(phoneRules).toMatch(/\.legend summary, :root\[data-text\] \.legend summary \{ min-height: 44px/);
    expect(phoneRules).toMatch(/\.legend \{\s*top: var\(--sp-2\); right: var\(--sp-2\); bottom: auto;/);
  });

  it("fits the first view to the data that is on, inside map padding that follows the sheet", () => {
    expect(app).toMatch(/bounds: DEFAULT_DATA_BOUNDS/);
    expect(app).toMatch(/let autoView = !initial\.view;/);
    expect(app).toMatch(/map\.setPadding\(pad\)/);
    expect(app).toMatch(/map\.easeTo\(\{ padding: pad/);
    expect(app).toMatch(/bottom: Math\.round\(sheetH \+ creditsH\)/);
    // syncOffsets (sheet and credits height changes) updates the padding.
    const sync = app.slice(app.indexOf("function syncOffsets()"), app.indexOf("function halfSheetPx"));
    expect(sync).toMatch(/applyMapPadding\(\)/);
    // Once the data loads, the view fits the real data unless the person moved the map.
    expect(app).toMatch(/refineAutoView\(\);\n\}/);
    expect(app).toMatch(/if \(e\.originalEvent\) autoView = false;/);
    // Wide screens keep the data above the open legend; short screens shrink the margins.
    expect(app).toMatch(/!isPhone\(\) && legend\?\.open\) m\.bottom = Math\.max/);
    expect(app).toMatch(/freeH - m\.top - m\.bottom < 160/);
  });

  it("drops the compass and touch rotation on phones so the control stack stays short", () => {
    expect(app).toMatch(/showCompass: !PHONE_AT_START/);
    expect(app).toMatch(/touchZoomRotate\.disableRotation\(\)/);
  });

  it("hides the first-run tip when the layers sheet is open and keeps the credits bar opaque", () => {
    expect(css).toMatch(/:root:has\(\.panel\[data-sheet="half"\]\) \.first-hint/);
    expect(css).toMatch(/:root:has\(\.panel\[data-sheet="full"\]\) \.first-hint/);
    expect(css).toMatch(/\.credits-bar \{[^}]*z-index: 8;/);
    expect(css).toMatch(/\.credits-bar \{[^}]*background: var\(--surface\)/);
  });

  it("gives map controls and header actions 44 px targets on phones", () => {
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.maplibregl-ctrl-group button \{ width: 44px; height: 44px; \}/);
    const brand = readFileSync("public/brand.css", "utf8");
    expect(brand).toMatch(/@media \(max-width: 760px\)[\s\S]*\.topbar-actions \.btn, \.topbar-actions \.btn-theme \{ min-height: 44px; min-width: 44px; \}/);
  });
});
