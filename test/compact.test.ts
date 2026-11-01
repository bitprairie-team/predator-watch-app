import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const html = readFileSync("public/index.html", "utf8");
const css = readFileSync("public/styles.css", "utf8");
const app = readFileSync("public/app.js", "utf8");
const headers = readFileSync("public/_headers", "utf8");
const compact = css.slice(css.indexOf("/* ---- Compact panel (stage 5)"));
const coarse = compact.slice(compact.indexOf("@media (pointer: coarse)"));

describe("compact panel", () => {
  it("starts with View and text size folded", () => {
    expect(html).toMatch(/<details class="panel-prefs" id="panel-prefs">/);
    expect(compact).toMatch(/\.panel-prefs > summary, :root\[data-mode="simple"\] \.panel-prefs > summary \{ min-height: 32px;/);
  });

  it("uses a compact segmented control for the jump tabs, 44px on touch", () => {
    expect(compact).toMatch(/\.jump-tabs a, :root\[data-mode="simple"\] \.jump-tabs a \{ min-height: 32px;/);
    expect(coarse).toMatch(/\.jump-tabs a, :root\[data-mode="simple"\] \.jump-tabs a,/);
    expect(coarse).toMatch(/\{ min-height: 44px; \}/);
  });

  it("puts Use my location in the search row as an icon button", () => {
    const row = html.slice(html.indexOf('<div class="search-row">'), html.indexOf("</div>", html.indexOf('<div class="search-row">')));
    expect(row).toMatch(/type="submit">Go<\/button>\s*<button type="button" id="locate-me"[^>]*aria-label="Use my location" title="Use my location"/);
    expect(coarse).toMatch(/\.icon-btn, :root\[data-mode="simple"\] \.search \.icon-btn \{ width: 44px; min-width: 44px; \}/);
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

  it("wraps small chips inline and keeps 44px hit areas on touch", () => {
    expect(compact).toMatch(/\.chip, :root\[data-mode="simple"\] \.chip \{ min-height: 28px;/);
    expect(coarse).toMatch(/\.chip, :root\[data-mode="simple"\] \.chip,/);
  });

  it("shows Reset to defaults and Turn all off as text links on one line", () => {
    expect(html).toMatch(/<span class="tool-links"><button type="button" id="reset-layers" class="link-btn">Reset to defaults<\/button><span class="tool-sep" aria-hidden="true">·<\/span><button type="button" id="all-off" class="link-btn">Turn all off<\/button><\/span>/);
    expect(coarse).toMatch(/\.link-btn, :root\[data-mode="simple"\] #reset-layers, :root\[data-mode="simple"\] #all-off \{ min-height: 44px; \}/);
  });
});
