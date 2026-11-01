import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const html = readFileSync("public/index.html", "utf8");
const app = readFileSync("public/app.js", "utf8");

// Side panel navigation: the same panel serves desktop, the tablet side
// panel and the phone bottom sheet.
describe("side panel navigation", () => {
  it("has jump links, a layer filter, active-only, reset and all-off", () => {
    for (const j of ["sec-layers", "sec-legend", "sec-sources"]) {
      expect(html).toContain(`data-jump="${j}"`);
      expect(html).toContain(`id="${j}"`);
    }
    expect(html).toMatch(/<label for="layer-filter">/);
    expect(html).toMatch(/id="layer-filter" type="search"/);
    expect(html).toMatch(/id="active-only"/);
    expect(html).toMatch(/id="reset-layers" class="link-btn">Reset to defaults</);
    expect(html).toMatch(/id="all-off" class="link-btn">Turn all off</);
    expect(html).toMatch(/id="active-chips"/);
  });

  it("has an edge toggle with aria-expanded and a keyboard shortcut", () => {
    expect(html).toMatch(/id="panel-edge"[^>]*aria-controls="panel"[^>]*aria-expanded="true"[^>]*aria-keyshortcuts="\["/);
    expect(app).toMatch(/e\.key !== "\["/);
  });

  it("renders collapsible groups with aria-expanded and per-group counts", () => {
    expect(app).toMatch(/class="group-toggle"[^`]*aria-expanded="\$\{open\}" aria-controls="grp-\$\{g\.id\}-body"/);
    expect(app).toMatch(/`\$\{on\} of \$\{list\.length\} on`/);
  });

  it("announces toggles and resets to the shared defaults", () => {
    expect(html).toMatch(/id="announcer"[^>]*aria-live="polite"/);
    expect(app).toMatch(/turned \$\{on \? "on" : "off"\}/);
    expect(app).toMatch(/setMany\(\(l\) => Boolean\(l\.style\?\.defaultVisible\)/);
    // Chips remove a layer with a labelled button.
    expect(app).toMatch(/aria-label="Turn off \$\{esc\(displayName\(l\)\)\}"/);
  });
});
