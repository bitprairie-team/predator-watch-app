// Brand alignment: the v9.1 Predator Watch tile (Stone), IBM Plex weights and copy style.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { APP_COLORS } from "../src/config/palette";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const PAGES = readdirSync("public").filter((f) => f.endsWith(".html"));
const PLATE = "#6E6259";

describe("brand marks", () => {
  it("uses the v9.1 Predator Watch tile (Stone) as the mark on every page", () => {
    const light = read("public/brand/predator-watch-mark.svg");
    const dark = read("public/brand/predator-watch-mark-dark.svg");
    expect(light).toContain('fill="#6E6259"');
    expect(dark).toContain('fill="#A59C94"');
    expect(light).toContain('viewBox="0 0 300 300"');
    expect(dark).toContain('viewBox="0 0 300 300"');
    // The official merch path, not the old line paw.
    expect(light).not.toContain("stroke-width");
    expect(light).not.toMatch(/<ellipse/);
    for (const p of PAGES) {
      const h = read(`public/${p}`);
      expect(h, p).toMatch(/src="\/brand\/predator-watch-mark\.svg"/);
      expect(h, p).toMatch(/src="\/brand\/predator-watch-mark-dark\.svg"/);
      expect(h, p).not.toMatch(/class="brand-home"/);
      expect(h, p).not.toMatch(/class="byline"/);
    }
  });
  it("uses the Stone tile for the favicon and app icon plate", () => {
    const fav = read("public/favicon.svg");
    expect(fav).toContain('fill="#6E6259"');
    expect(fav).toContain('fill="#A59C94"');
    expect(fav).toMatch(/prefers-color-scheme: dark/);
    expect(APP_COLORS.icon).toBe(PLATE);
  });
  it("draws every app icon on the Stone plate", async () => {
    const files = [
      "public/icons/icon-512.png", "public/icons/icon-maskable-512.png", "public/icons/apple-touch-icon.png",
      "assets/icon-only.png", "assets/icon-background.png",
      "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png",
    ];
    for (const f of files) {
      const { data, info } = await sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      // A pixel a little in from the left edge, halfway down, is plate.
      const x = Math.round(info.width * 0.06), y = Math.round(info.height * 0.5);
      const i = (y * info.width + x) * info.channels;
      const hex = "#" + [0, 1, 2].map((k) => data[i + k]!.toString(16).padStart(2, "0")).join("").toUpperCase();
      expect(hex, f).toBe(PLATE);
    }
  });
});

describe("brand type and copy", () => {
  it("never sets weight 700 (IBM Plex Sans 400, 500, 600)", () => {
    for (const f of ["brand.css", "styles.css", "page.css"]) {
      expect(read(`public/${f}`), f).not.toMatch(/font-weight:\s*(700|800|900|bold)|font:\s*(700|bold)\b/);
    }
    expect(read("public/brand.css")).toMatch(/h1, h2, h3, h4, h5, h6, b, strong, th, dt, legend \{ font-weight: 600; \}/);
  });
  it("uses no banned fonts and self-hosts IBM Plex", () => {
    for (const f of ["brand.css", "styles.css", "page.css"]) {
      expect(read(`public/${f}`)).not.toMatch(/Inter\b|Space Grotesk|DM Sans|Geist|fonts\.googleapis/);
    }
    expect(read("public/brand.css")).toContain('url("/fonts/ibm-plex-sans.woff2")');
  });
  it("has no em dashes in public pages or store copy", () => {
    for (const p of PAGES) expect(read(`public/${p}`), p).not.toContain("\u2014");
    for (const f of readdirSync("docs/app-store").filter((n) => n.endsWith(".md"))) {
      expect(read(`docs/app-store/${f}`), f).not.toContain("\u2014");
    }
  });
});

describe("project site link", () => {
  it("links predatorwatch.org in the footer, not in the header", () => {
    for (const p of ["index.html", "about.html", "status.html", "privacy.html"]) {
      const h = read(`public/${p}`);
      const header = h.split("<footer")[0];
      expect(header, p).not.toMatch(/class="byline"/);
      expect(h, p).toMatch(/bitprairie\.com\/predator-watch<\/a><\/li>\s*<li><a href="https:\/\/predatorwatch\.org\/">predatorwatch\.org<\/a><\/li>/);
    }
  });
});
