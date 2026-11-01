import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const html = readFileSync("public/index.html", "utf8");
const app = readFileSync("public/app.js", "utf8");

// Side panel navigation: the same panel serves desktop, the tablet side
// panel and the phone bottom sheet.
describe("side panel navigation", () => {
  it("has folded sections, a layer filter, active-only, reset and all-off", () => {
    expect(html).toContain(`id="sec-layers"`);
    for (const j of ["sec-list", "sec-sources", "sec-share"]) {
      expect(html).toMatch(new RegExp(`<details class="fold[^"]*" id="${j}">`));
    }
    expect(html).toMatch(/<label for="layer-filter">/);
    expect(html).toMatch(/id="layer-filter" type="search"/);
    expect(html).toMatch(/id="active-only"/);
    expect(html).toMatch(/id="reset-layers" class="link-btn"[^>]*>Reset</);
    expect(html).toMatch(/id="all-off" class="link-btn">Turn all off</);
    // One quiet "N on" line replaces the old chip row; the map legend is the only legend.
    expect(html).not.toMatch(/id="active-chips"/);
    expect(html).toMatch(/<p class="active-summary" id="active-summary"/);
    expect(html).not.toMatch(/id="panel-legend"|id="sec-legend"/);
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
    // The heading line counts what is on.
    expect(app).toMatch(/function renderActiveSummary\(\)/);
    expect(app).toMatch(/n \? `\$\{n\} on` : "None on"/);
  });
});
