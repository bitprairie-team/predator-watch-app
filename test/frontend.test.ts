import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

const html = readFileSync("public/index.html", "utf8").toString();
const headers = readFileSync("public/_headers", "utf8").toString();
const sw = readFileSync("public/sw.js", "utf8").toString();

describe("front end", () => {
  it("labels the search box and has the legend, theme toggle and share controls", () => {
    expect(html).toMatch(/<label for="search-q">/);
    expect(html).toMatch(/id="legend"/);
    expect(html).toMatch(/id="theme-toggle"[^>]*aria-pressed/);
    expect(html).toMatch(/id="share-link"/);
    expect(html).toMatch(/Census Bureau Gazetteer/);
    expect(html).toMatch(/not endorsed or certified by the Census Bureau/);
  });

  it("preloads the layer list and defers the map library", () => {
    expect(html).toMatch(/rel="preload" href="\/api\/layers" as="fetch"/);
    expect(html).toMatch(/maplibre-gl\.js" defer/);
  });

  it("serves the service worker uncached and keeps it same-origin only", () => {
    expect(headers).toMatch(/\/sw\.js\n\s+Cache-Control: no-cache/);
    expect(sw).toMatch(/url\.origin !== self\.location\.origin\) return/);
    expect(sw).not.toMatch(/openfreemap|arcgis|nationalmap/);
  });

  it("has share cards, icons and a manifest", () => {
    for (const tag of ['property="og:image" content="https://app.predatorwatch.org/og.png"', 'name="twitter:card" content="summary_large_image"', 'rel="manifest"', 'rel="apple-touch-icon"']) {
      expect(html).toContain(tag);
    }
    const manifest = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8"));
    for (const icon of manifest.icons) expect(existsSync(`public${icon.src}`)).toBe(true);
    expect(existsSync("public/og.png")).toBe(true);
    expect(existsSync("public/favicon.ico")).toBe(true);
  });

  it("links the methodology, status and source-suggestion pages", () => {
    expect(html).toContain('href="/about"');
    expect(html).toContain('href="/status"');
    expect(html).toContain("issues/new?template=new-source.yml");
    expect(existsSync(".github/ISSUE_TEMPLATE/new-source.yml")).toBe(true);
    for (const page of ["public/about.html", "public/status.html"]) {
      const p = readFileSync(page, "utf8");
      expect(p).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
      expect(p).toMatch(/<main[ >]/);
    }
  });

  it("has a dismissible first-visit hint", () => {
    expect(html).toMatch(/id="first-hint"[^>]*aria-labelledby="first-hint-title"[^>]*hidden/);
    expect(html).toContain('id="first-hint-close"');
  });
  it("keeps layer rows usable with a screen reader and after a failed download", () => {
    const app = readFileSync("public/app.js", "utf8").toString();
    expect(app).toMatch(/About this source<span class="sr-only">: \$\{nm\}/);
    expect(app).toMatch(/GeoJSON<span class="sr-only"> for \$\{nm\}/);
    expect(app).toMatch(/class="link-btn retry">Try again<span class="sr-only">: \$\{nm\}<\/span>/);
    expect(app).toMatch(/if \(focusSel\) li\.querySelector\(focusSel\)\?\.focus\(\)/);
  });
});
