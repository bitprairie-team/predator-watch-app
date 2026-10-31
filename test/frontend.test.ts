import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const html = readFileSync("public/index.html", "utf8").toString();
const headers = readFileSync("public/_headers", "utf8").toString();
const sw = readFileSync("public/sw.js", "utf8").toString();

describe("front end", () => {
  it("labels the search box and has the legend, theme toggle and share controls", () => {
    expect(html).toMatch(/<label for="search-q">/);
    expect(html).toMatch(/id="legend"/);
    expect(html).toMatch(/id="theme-toggle"[^>]*aria-pressed/);
    expect(html).toMatch(/id="share-link"/);
    expect(html).toMatch(/Nominatim/);
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
});
