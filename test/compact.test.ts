import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const html = readFileSync("public/index.html", "utf8");
const css = readFileSync("public/styles.css", "utf8");
const app = readFileSync("public/app.js", "utf8");
const headers = readFileSync("public/_headers", "utf8");
const compact = css;
const coarse = css.slice(css.indexOf("@media (pointer: coarse) {"));

describe("compact panel", () => {
  it("starts with View and text size folded", () => {
    expect(html).toMatch(/<details class="panel-prefs fold" id="panel-prefs">/);
    expect(compact).toMatch(/\.panel-prefs > summary, :root\[data-mode="simple"\] \.panel-prefs > summary \{[^}]*min-height: var\(--ctl\);/);
    expect(coarse).toMatch(/\.panel-prefs > summary, :root\[data-mode="simple"\] \.panel-prefs > summary,/);
  });

  it("folds secondary sections instead of jump tabs, 44px rows on touch", () => {
    expect(html).not.toMatch(/jump-tabs|data-jump/);
    expect(compact).not.toMatch(/\.jump-tabs/);
    expect(compact).toMatch(/\.fold > summary, :root\[data-mode="simple"\] \.fold > summary \{[^}]*min-height: var\(--ctl\);/);
    expect(coarse).toMatch(/\.fold > summary, :root\[data-mode="simple"\] \.fold > summary,/);
    expect(coarse).toMatch(/\.search-results button \{ min-height: 44px; \}/);
  });

  it("puts Use my location in the search row as an icon button", () => {
    const row = html.slice(html.indexOf('<div class="search-row">'), html.indexOf("</div>", html.indexOf('<div class="search-row">')));
    expect(row).toMatch(/type="submit">Go<\/button>\s*<button type="button" id="locate-me"[^>]*aria-label="Use my location" title="Use my location"/);
    expect(coarse).toMatch(/\.search \.icon-btn, :root\[data-mode="simple"\] \.search \.icon-btn, \.icon-btn, \.row-info \{ width: 44px; min-width: 44px; \}/);
  });

  it("shows the location note only after a failed tap, and allows geolocation for this site", () => {
    expect(html).toMatch(/<p id="locate-status" class="hint locate-status" role="status" aria-live="polite"><\/p>/);
    expect(css).toMatch(/\.locate-status:empty \{ display: none; \}/);
    // Set only inside the button's click handler.
    const writes = app.match(/locateMsg\.textContent = /g) || [];
    const handler = app.slice(app.indexOf('locateBtn.addEventListener("click"'), app.indexOf("// ------------------------------------------------ view and display settings"));
    expect((handler.match(/locateMsg\.textContent = /g) || []).length).toBe(writes.length - 1); // the other one clears it on typing
    expect(app).toMatch(/\$\("#search-q"\)\.addEventListener\("input", \(\) => \{ locateMsg\.textContent = ""; \}\);/);
    expect(app).not.toMatch(/turned off for this site/);
    expect(headers).toMatch(/Permissions-Policy: geolocation=\(self\)/);
  });

  it("has no chip row, and gives the layer info button a 44px target on touch", () => {
    expect(css).not.toMatch(/\.chips?\b/);
    expect(html).not.toMatch(/class="chips?"/);
    expect(coarse).toMatch(/\.icon-btn, \.row-info \{ height: 44px; \}/);
  });

  it("shows Reset and Turn all off as text links in the Layers heading line", () => {
    expect(html).toMatch(/<span class="tool-links"><button type="button" id="reset-layers" class="link-btn"[^>]*>Reset<\/button><span class="tool-sep" aria-hidden="true">·<\/span><button type="button" id="all-off" class="link-btn">Turn all off<\/button><\/span>/);
    expect(coarse).toMatch(/\.link-btn, :root\[data-mode="simple"\] #reset-layers, :root\[data-mode="simple"\] #all-off,/);
  });
});
