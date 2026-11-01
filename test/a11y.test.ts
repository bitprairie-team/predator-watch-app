import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const page = (f: string) => readFileSync(`public/${f}`, "utf8");
const index = page("index.html");
const app = page("app.js");
const prefs = page("prefs.js");
const brand = page("brand.css");
const styles = page("styles.css");

describe("display settings", () => {
  it("loads prefs.js before styles paint on every page, with no inline script", () => {
    for (const f of ["index.html", "about.html", "status.html"]) {
      const h = page(f);
      expect(h).toMatch(/<script src="\/prefs\.js"><\/script>/);
      expect(h).toMatch(/data-display-controls/);
      expect(h).toMatch(/class="skip-link" href="#/);
      expect(h).not.toMatch(/<script>(?!<\/script>)/);
    }
    expect(page("sw.js")).toContain('"/prefs.js"');
  });

  it("defaults to Simple view and lets a link ask for Expert view", () => {
    expect(prefs).toMatch(/s === "expert" \? "expert" : "simple"/);
    expect(prefs).toMatch(/mode=\(simple\|expert\)/);
    expect(index).toMatch(/data-with-mode/);
    expect(app).toMatch(/&mode=expert/);
  });

  it("offers three text sizes and high contrast, saved locally, as pressed buttons", () => {
    for (const k of ["pw-mode", "pw-text", "pw-contrast"]) expect(prefs).toContain(k);
    expect(prefs).toMatch(/aria-pressed/);
    expect(prefs).toMatch(/prefers-contrast: more/);
    expect(brand).toMatch(/data-text="2"\] \{ font-size: 112\.5%/);
    expect(brand).toMatch(/data-text="3"\]/);
    expect(brand).toMatch(/data-contrast="high"\]/);
    expect(brand).toMatch(/prefers-reduced-motion: reduce/);
  });
});

describe("screen reader and keyboard support", () => {
  it("labels the map and announces changes", () => {
    expect(index).toMatch(/id="map"[^>]*role="region"[^>]*aria-label=/);
    expect(index).toMatch(/id="announcer"[^>]*aria-live="polite"/);
    expect(app).toMatch(/announce\(`\$\{displayName\(layer\)\} turned/);
    expect(app).toMatch(/announce\(`Showing \$\{r\.name\}/);
  });

  it("has a text list view and a Use my location button", () => {
    expect(index).toMatch(/id="sec-list"/);
    expect(index).toMatch(/data-jump="sec-list"/);
    expect(app).toMatch(/function renderListView/);
    // An icon button beside Go, named by aria-label with a matching tooltip.
    expect(index).toMatch(/<button type="button" id="locate-me" class="btn icon-btn locate-btn" aria-label="Use my location" title="Use my location">/);
    expect(app).toMatch(/geolocation\.getCurrentPosition/);
  });

  it("makes scrolling tables reachable by keyboard", () => {
    for (const f of ["about.html", "status.html"]) {
      const wraps = page(f).match(/<div class="table-wrap"[^>]*>/g) || [];
      for (const w of wraps) expect(w).toMatch(/tabindex="0" role="region" aria-label="/);
    }
  });

  it("keeps body text at 16px or more", () => {
    expect(styles).toMatch(/\.hint, \.layer-agency, \.layer-summary[^{]*\{ font-size: 1rem; \}/);
  });
});
