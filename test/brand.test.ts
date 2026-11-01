import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { SOURCES } from "../src/config/sources";

const read = (p: string) => readFileSync(p, "utf8").toString();
const pages = ["public/index.html", "public/about.html", "public/status.html"];

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  const [r = 0, g = 0, b = 0] = c;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [x = 0, y = 0] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

describe("BitPrairie brand", () => {
  it("ships the brand assets, self-hosted fonts and their licenses", () => {
    for (const f of ["brand/bitprairie-symbol.svg", "brand/bitprairie-wordmark.svg", "brand/predator-watch-mark.svg", "brand.css", "theme.js",
      "fonts/ibm-plex-sans.woff2", "fonts/ibm-plex-mono-normal-500.woff2", "fonts/OFL-IBMPlexSans.txt", "fonts/OFL-IBMPlexMono.txt"]) {
      expect(existsSync(`public/${f}`), f).toBe(true);
    }
    expect(read("public/fonts/OFL-IBMPlexSans.txt")).toMatch(/SIL OPEN FONT LICENSE/i);
    // Warm BitPrairie tokens: paper, surface, ink and leather accent.
    for (const t of ["--paper: #f2ede4", "--card: #fffcf6", "--ink: #141416", "--accent: #6b4a2e"]) expect(read("public/brand.css")).toContain(t);
    expect(read("public/brand.css")).not.toMatch(/fonts\.googleapis|https?:\/\//);
  });

  it("puts the same masthead, theme script and credits on every page", () => {
    for (const p of pages) {
      const h = read(p);
      expect(h, p).toMatch(/<script src="\/theme\.js"><\/script>/);
      expect(h, p).toMatch(/href="\/brand\.css"/);
      expect(h, p).toMatch(/class="brand-home" href="https:\/\/bitprairie\.com\/"/);
      expect(h, p).toMatch(/by <a href="https:\/\/bitprairie\.com\/predator-watch\/">BitPrairie<\/a>/);
      expect(h, p).toMatch(/class="proj-mark"/);
      expect(h, p).toMatch(/<footer class="credits"/);
      expect(h, p).toMatch(/name="theme-color" content="#f2ede4"[^>]*data-dark="#161310"/);
      expect(h, p).not.toMatch(/<script>(?!<\/script>)/);
    }
  });

  it("uses the shared bp-theme key", () => {
    expect(read("public/theme.js")).toMatch(/KEY = "bp-theme"/);
    expect(read("public/app.js")).toMatch(/THEME_KEY = "bp-theme"/);
  });

  it("gives every layer one fixed color with at least 3:1 contrast on light and dark backgrounds", () => {
    const styled = SOURCES.filter((s) => s.style);
    expect(styled.length).toBeGreaterThan(5);
    for (const s of styled) {
      expect(s.style.color, s.id).toMatch(/^#[0-9a-f]{6}$/i);
      expect("colorDark" in s.style, s.id).toBe(false);
      expect(contrast(s.style.color, "#f2f3f0"), s.id).toBeGreaterThanOrEqual(3);
      expect(contrast(s.style.color, "#1b1d20"), s.id).toBeGreaterThanOrEqual(3);
    }
  });

  it("ships the lockup, favicon set and splash mark on every page", () => {
    for (const f of ["brand/predator-watch-lockup.svg", "brand/predator-watch-lockup-dark.svg", "favicon.svg", "favicon.ico",
      "icons/icon-32.png", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png"]) {
      expect(existsSync(`public/${f}`), f).toBe(true);
    }
    expect(read("public/brand/predator-watch-lockup.svg")).not.toMatch(/<text/);
    for (const p of pages) {
      const h = read(p);
      expect(h, p).toMatch(/rel="icon" href="\/favicon\.svg" type="image\/svg\+xml"/);
      expect(h, p).toMatch(/rel="icon" href="\/icons\/icon-32\.png" sizes="32x32"/);
      expect(h, p).toMatch(/rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png" sizes="180x180"/);
      expect(h, p).toMatch(/viewport-fit=cover/);
    }
    expect(read("public/index.html")).toMatch(/id="splash"/);
    const m = JSON.parse(read("public/manifest.webmanifest"));
    expect(m.icons.some((i: { purpose?: string; sizes?: string }) => i.purpose === "maskable" && i.sizes === "512x512")).toBe(true);
  });

  it("uses the brand colours in the manifest", () => {
    const m = JSON.parse(read("public/manifest.webmanifest"));
    expect(m.theme_color).toBe("#f2ede4");
    expect(m.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);
  });
});
