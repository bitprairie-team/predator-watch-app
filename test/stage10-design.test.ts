import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");
const html = read("public/index.html");
const app = read("public/app.js");
const updatesJs = read("public/updates.js");
const updates = read("public/updates.html");
const about = read("public/about.html");
const privacy = read("public/privacy.html");
const status = read("public/status.html");
const statusJs = read("public/status.js");
const page = read("public/page.css");
const css = read("public/styles.css");
const stage10 = page.slice(page.indexOf("Layout round (stage 10)"));

describe("stage 10: official updates are data, not a disclaimer", () => {
  it("says the caveat once on the page, not in every row", () => {
    expect(updates).toMatch(/written as reported by the agency and the date/);
    expect(updatesJs).not.toMatch(/as reported by \$\{/);
    expect(updatesJs).not.toMatch(/>Source</);
    expect(app).not.toMatch(/as reported by \$\{/);
  });
  it("renders counts as a value plus a source link, and reports as date, title and agency", () => {
    expect(updatesJs).toMatch(/class="fact-value"/);
    expect(updatesJs).toMatch(/class="fact-label"/);
    expect(updatesJs).toMatch(/class="updates-title"/);
    expect(updatesJs).toMatch(/class="updates-agency"/);
    expect(app).toMatch(/class="fact-value"/);
    expect(app).toMatch(/credit_short \|\| i\.agency/);
  });
  it("aligns the number or date in a column, with tabular numerals", () => {
    expect(stage10).toMatch(/grid-template-columns: 9\.5rem 1fr/);
    expect(stage10).toMatch(/font-variant-numeric: tabular-nums/);
    expect(css).toMatch(/\.updates-list li \{ display: grid; grid-template-columns: 7\.5rem 1fr;/);
    expect(stage10).toMatch(/\.updates-facts \.fact-value, \.updates-facts \.fact-detail \{ grid-column: 1; \}/);
  });
  it("drops the panel helper sentence and the cached-yet jargon", () => {
    const fold = html.slice(html.indexOf('id="sec-updates"'), html.indexOf('id="sec-sources"'));
    expect(fold).not.toMatch(/<p class="hint">/);
    expect(updatesJs).toMatch(/No official (counts|updates) are listed yet/);
    expect(app).toMatch(/No official updates are listed yet/);
    expect(updatesJs + app + updates + html).not.toMatch(/cached yet/);
  });
});

describe("stage 10: quiet text pages", () => {
  it("has no kicker above the title", () => {
    for (const t of [updates, about, privacy, status]) {
      expect(t).not.toMatch(/class="eyebrow"/);
    }
  });
  it("styles the current page as an underline, not a box", () => {
    expect(stage10).toMatch(/\.topbar-actions \.btn\[aria-current="page"\] \{ border-color: transparent;/);
  });
  it("makes the text-size row a small text control and keeps 44px targets on touch", () => {
    expect(stage10).toMatch(/\.page-prefs \.pref-btn \{[^}]*border: 0; background: transparent;/);
    expect(stage10).toMatch(/\.page-prefs \.pref-btn\[aria-pressed="true"\] \{[^}]*text-decoration: underline/);
    expect(stage10).toMatch(/@media \(pointer: coarse\) \{ \.page-prefs \.pref-btn \{ min-height: 44px; min-width: 44px; \}/);
  });
  it("draws status labels as colored words, not pills", () => {
    expect(stage10).toMatch(/\.page \.badge \{[^}]*border: 0; background: none;/);
    expect(stage10).toMatch(/\.page \.ok \{ background: none; color: var\(--ok-ink\); \}/);
  });
  it("does not claim IBM Plex Mono is in use", () => {
    expect(about).not.toMatch(/Plex Mono/);
  });
  it("keeps the status table's labeled cells and roles on small screens", () => {
    for (const label of ["State", "Last success", "Last attempt", "Items", "Last error"]) {
      expect(statusJs).toContain(`data-label="${label}"`);
    }
    expect(statusJs).toMatch(/src-cadence/);
  });
});

describe("stage 10: display-only title spacing", () => {
  it("inserts a space in titles like \"report- October\" and leaves already-spaced titles alone", () => {
    const tidy = (s: string) => s.replace(/([A-Za-z])-\s+([A-Za-z])/g, "$1 - $2");
    expect(tidy("Monthly wolf report- October 2026")).toBe("Monthly wolf report - October 2026");
    expect(tidy("Monthly wolf report - September 2026")).toBe("Monthly wolf report - September 2026");
    const updatesJs = read("public/updates.js");
    const app = read("public/app.js");
    expect(updatesJs).toMatch(/tidyTitle\(i\.title\)/);
    expect(app).toMatch(/tidyTitle\(i\.title\)/);
  });
});

describe("stage 10: the public map does not show exact locations", () => {
  const line = "Areas are general. The map never shows exact locations or den sites.";
  it("renders a short caption by the map credits, and the same sentence on About and Privacy", () => {
    expect(html).toContain(`<p id="map-precision" class="map-precision">${line}</p>`);
    expect(html).toContain(`id="details-note">${line}`);
    expect(about).toContain(line);
    expect(privacy).toContain(line);
    expect(css).toMatch(/\.map-precision \{/);
  });
});
