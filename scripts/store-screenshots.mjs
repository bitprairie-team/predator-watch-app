// Store screenshots and the manifest's install screenshots, taken from a
// running copy of the site (default: `npm run dev` at http://127.0.0.1:8787).
//
//   npm run dev                       # in one terminal
//   npm run store:shots               # in another
//
// Needs Playwright (not a project dependency): `npm i -g playwright` and
// `npx playwright install chromium`, or set PLAYWRIGHT_MODULE to its path.
// Writes:
//   public/icons/screenshot-narrow.png, screenshot-wide.png  (manifest)
//   docs/app-store/screenshots/<store>/<nn>-<scene>.jpg       (listings)
// Each store image has the app name and a one-line caption above a real
// screenshot of the app. Colors and fonts come from the site's brand.css.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE || "http://127.0.0.1:8787").replace(/\/$/, "");
const NAME = "Predator Watch by BitPrairie";

// Pixel sizes the stores accept (portrait). css = pixels / dpr.
const STORES = [
  { dir: "ios-6.7in", w: 1290, h: 2796, dpr: 3 }, // iPhone 6.7"/6.9" (required)
  { dir: "ios-6.5in", w: 1284, h: 2778, dpr: 3 }, // iPhone 6.5"
  { dir: "ios-ipad-12.9in", w: 2048, h: 2732, dpr: 2 }, // iPad Pro 12.9"/13" (required for iPad)
  { dir: "play-phone", w: 1080, h: 1920, dpr: 3 },
  { dir: "play-tablet-7in", w: 1200, h: 1920, dpr: 2 },
  { dir: "play-tablet-10in", w: 1600, h: 2560, dpr: 2 },
];
const SCENES = [
  { id: "map", caption: "Wolf activity from public agency data, on one map" },
  { id: "layers", caption: "Every layer names its agency and when it was updated" },
  { id: "dark", caption: "Dark mode, larger text and high contrast" },
  { id: "sources", caption: "Sources and credits for every dataset" },
  { id: "status", caption: "See when each source was last checked" },
];

// The CSP's upgrade-insecure-requests would send local http requests over
// https; strip it for local captures only.
async function localOnly(ctx) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(BASE)) return;
  await ctx.route(`${BASE}/**`, async (route) => {
    const res = await route.fetch();
    const headers = { ...res.headers() };
    if (headers["content-security-policy"]) headers["content-security-policy"] = headers["content-security-policy"].replace(/;\s*upgrade-insecure-requests/, "");
    delete headers["strict-transport-security"];
    await route.fulfill({ response: res, headers });
  });
}

async function capture(browser, scene, width, height, dpr) {
  const touch = width < 761;
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, isMobile: touch, hasTouch: touch, serviceWorkers: "block", colorScheme: scene === "dark" ? "dark" : "light" });
  await localOnly(ctx);
  await ctx.addInitScript((dark) => {
    localStorage.setItem("pw-hint-dismissed", "1");
    localStorage.setItem("pw-text-v", "2");
    if (dark) localStorage.setItem("bp-theme", "dark");
  }, scene === "dark");
  const page = await ctx.newPage();
  const path = scene === "sources" ? "/about#sources" : scene === "status" ? "/status" : "/";
  await page.goto(BASE + path, { waitUntil: "load" });
  await page.waitForTimeout(path === "/" ? 3500 : 1500);
  if (scene === "layers" && touch) {
    // Open the sheet all the way and show the layer cards.
    await page.click("#sheet-handle").catch(() => {});
    await page.waitForTimeout(700);
    if ((await page.getAttribute("#panel", "data-sheet")) !== "full") await page.click("#sheet-handle").catch(() => {});
    await page.waitForTimeout(700);
    await page.evaluate(() => document.getElementById("h-layers")?.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(500);
  }
  const png = await page.screenshot({ type: "png" });
  await ctx.close();
  return png;
}

async function frame(browser, shot, s, caption) {
  const w = s.w / s.dpr, h = s.h / s.dpr;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: s.dpr });
  const page = await ctx.newPage();
  const tablet = w >= 600;
  await page.setContent(`<!doctype html><html><head><link rel="stylesheet" href="${BASE}/brand.css"><style>
    html,body{margin:0;height:100%;background:var(--paper);font-family:var(--sans)}
    .wrap{height:100%;display:flex;flex-direction:column;align-items:center;box-sizing:border-box;padding:${tablet ? 40 : 22}px ${tablet ? 48 : 20}px 0}
    .name{font:600 ${tablet ? 22 : 15}px/1.2 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--accent);margin:0}
    h1{font:600 ${tablet ? 44 : 27}px/1.18 var(--sans);color:var(--ink);text-align:center;margin:${tablet ? 14 : 8}px 0 ${tablet ? 32 : 18}px;max-width:${tablet ? 760 : 360}px}
    .shot{flex:1;min-height:0;width:100%;display:flex;justify-content:center;align-items:flex-start;overflow:hidden}
    .shot img{display:block;width:auto;height:auto;max-width:100%;border:1px solid var(--rule-strong);border-bottom:0;border-radius:${tablet ? 18 : 14}px ${tablet ? 18 : 14}px 0 0}
  </style></head><body><div class="wrap"><p class="name">${NAME}</p><h1>${caption}</h1><div class="shot"><img src="data:image/png;base64,${shot.toString("base64")}"></div></div></body></html>`, { waitUntil: "load" });
  await page.waitForTimeout(300);
  const jpg = await page.screenshot({ type: "jpeg", quality: 88 });
  await ctx.close();
  return jpg;
}

const browser = await chromium.launch();
// Manifest install screenshots: the app itself, no caption.
const icons = join(ROOT, "public", "icons");
writeFileSync(join(icons, "screenshot-narrow.png"), await capture(browser, "map", 360, 640, 3));
writeFileSync(join(icons, "screenshot-wide.png"), await capture(browser, "map", 960, 540, 2));
console.log("manifest screenshots written");

for (const s of STORES) {
  const out = join(ROOT, "docs", "app-store", "screenshots", s.dir);
  mkdirSync(out, { recursive: true });
  const w = s.w / s.dpr, h = s.h / s.dpr;
  const tablet = w >= 600;
  // The app area under the caption: keep the store image's width, trim the top.
  const innerW = Math.round(w - (tablet ? 96 : 40) - 2);
  const innerH = Math.round(h - (tablet ? 190 : 125));
  for (const [i, sc] of SCENES.entries()) {
    const shot = await capture(browser, sc.id, innerW, innerH, s.dpr);
    writeFileSync(join(out, `${String(i + 1).padStart(2, "0")}-${sc.id}.jpg`), await frame(browser, shot, s, sc.caption));
  }
  console.log(`${s.dir}: ${SCENES.length} screenshots (${s.w}x${s.h})`);
}
await browser.close();
// Record the sizes for docs/app-store/README.md.
writeFileSync(join(ROOT, "docs", "app-store", "screenshots", "sizes.json"), JSON.stringify(STORES, null, 2) + "\n");

