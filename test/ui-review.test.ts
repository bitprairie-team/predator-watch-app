import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (f: string) => readFileSync(`public/${f}`, "utf8");
const index = read("index.html");
const about = read("about.html");
const status = read("status.html");
const app = read("app.js");
const prefs = read("prefs.js");
const theme = read("theme.js");
const statusJs = read("status.js");
const css = read("styles.css");
const page = read("page.css");
const review = css.slice(css.indexOf("/* ---- UI review (stage 6)"));
const pageReview = page.slice(page.indexOf("/* ---- UI review (stage 6)"));

describe("UI review (stage 6)", () => {
  it("drops the full phone sheet to peek while details show, then restores it", () => {
    expect(app).toMatch(/sheetBeforeDetails \?\?= panel\.dataset\.sheet;\s*setSheet\("peek"\)/);
    expect(app).toMatch(/setSheet\(sheetBeforeDetails\)/);
  });

  it("shows a visible boot error with a retry in the panel", () => {
    expect(app).toMatch(/panel\.dataset\.boot = "error"/);
    expect(app).toMatch(/class="load-error" role="alert"/);
    expect(app).toMatch(/id="boot-retry">Try again</);
    expect(review).toMatch(/\.panel\[data-boot="error"\] \.active-bar/);
  });

  it("uses one retry label in both views", () => {
    expect(app).not.toMatch(/>Retry</);
  });

  it("reports map-control location failures like the search-row button", () => {
    expect(app).toMatch(/geoControl\?\.on\("error", locateFailed\)/);
    expect(app).toMatch(/function locateFailed\(err\)/);
  });

  it("uses the same header links, in the same order, on the text pages", () => {
    for (const [html, cur] of [[about, "/about"], [status, "/status"]] as const) {
      const nav = html.slice(html.indexOf('class="topbar-actions"'), html.indexOf("</nav>"));
      const hrefs = [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      expect(hrefs).toEqual(["/", "/about", "/status"]);
      expect(nav).toMatch(new RegExp(`href="${cur}"[^>]*aria-current="page"`));
      expect(nav).toMatch(/data-theme-toggle aria-pressed="false" title="Switch to dark mode">/);
      expect(nav).toMatch(/<span class="btn-label">Dark mode<\/span>/);
    }
    expect(index).toMatch(/Dark mode/);
    expect(theme).toMatch(/setAttribute\("aria-pressed"/);
  });

  it("keeps text pages to a readable line length", () => {
    expect(about).toMatch(/<body class="page page-prose">/);
    expect(status).toMatch(/<body class="page page-wide">/);
    expect(pageReview).toMatch(/max-width: 68ch/);
  });

  it("stacks the status table on narrow screens with labeled cells and kept roles", () => {
    expect(pageReview).toMatch(/@media \(max-width: 640px\)/);
    expect(pageReview).toMatch(/content: attr\(data-label\)/);
    for (const label of ["State", "Last success", "Last attempt", "Items", "Last error"]) expect(statusJs).toContain(`data-label="${label}"`);
    expect(statusJs).toMatch(/setAttribute\("role", "cell"\)/);
    expect(statusJs).toMatch(/<time datetime=/);
    expect(statusJs).not.toMatch(/: "none"/);
  });

  it("holds space on the status page so it does not shift as it loads", () => {
    expect(status).toMatch(/aria-busy="true"/);
    expect(pageReview).toMatch(/\.status-wrap\[aria-busy="true"\] \{ min-height: 100vh; \}/);
    expect(pageReview).toMatch(/\.page-prefs:empty \{ min-height: 32px; \}/);
    for (const html of [about, status]) expect(html).toMatch(/rel="preload" href="\/fonts\/ibm-plex-sans\.woff2"/);
  });

  it("paints the first-visit hint before the map library loads", () => {
    expect(prefs).toMatch(/setAttribute\("data-first-visit", ""\)/);
    expect(review).toMatch(/:root\[data-first-visit\] \.first-hint\[hidden\] \{ display: block; \}/);
    expect(app).toMatch(/removeAttribute\("data-first-visit"\)/);
  });

  it("shows full chip names in Simple view and keeps spacing on a 4px grid", () => {
    expect(review).toMatch(/\.chips li \{ max-width: 100%; \}/);
    expect(review).toMatch(/--sp-1: \.25rem; --sp-2: \.5rem;/);
  });

  it("scopes the panel padding to the side panel so the phone sheet keeps its own", () => {
    expect(review).toMatch(/@media \(min-width: 761px\) \{ \.panel \{ padding: var\(--sp-3\) var\(--sp-4\) var\(--sp-6\) max\(var\(--sp-4\), env\(safe-area-inset-left\)\); \} \}/);
  });

  it("keeps sentence case in about copy", () => {
    expect(about).not.toMatch(/<strong>Planned<\/strong>/);
  });
});
