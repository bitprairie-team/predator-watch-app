// Brand alignment (stage 7): the Predator Watch line paw mark, the BitPrairie
// bison tile for every app icon, IBM Plex weights and copy style.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { APP_COLORS } from "../src/config/palette";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const PAGES = readdirSync("public").filter((f) => f.endsWith(".html"));
const PLATE = "#c4ae96";

describe("brand marks", () => {
  it("uses the line paw (1.8 stroke, round caps, currentColor) as the Predator Watch mark on every page", () => {
    for (const p of PAGES) {
      const marks = read(`public/${p}`).match(/<svg class="(?:proj|splash)-mark"[^>]*>/g) ?? [];
      expect(marks.length, p).toBeGreaterThan(0);
      for (const m of marks) {
        expect(m).toContain('fill="none"');
        expect(m).toContain('stroke="currentColor"');
        expect(m).toContain('stroke-width="1.8"');
        expect(m).toContain('stroke-linecap="round"');
      }
    }
    expect(read("public/brand/predator-watch-mark.svg")).toContain('stroke-width="1.8"');
  });
  it("keeps the BitPrairie symbol on its warm plate and uses it for the favicon", () => {
    const tile = read("public/brand/bitprairie-symbol.svg");
    expect(tile).toMatch(/<rect width="64" height="64" rx="14" fill="#c4ae96"\/>/);
    expect(read("public/favicon.svg").trim()).toBe(tile.trim());
    expect(APP_COLORS.icon).toBe(PLATE);
  });
  it("draws every app icon on the bison plate", async () => {
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
      const hex = "#" + [0, 1, 2].map((k) => data[i + k]!.toString(16).padStart(2, "0")).join("");
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
