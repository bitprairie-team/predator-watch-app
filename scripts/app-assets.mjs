// Draws every app icon, favicon and launch screen from the official v9.1
// Predator Watch tiles (public/brand/predator-watch-mark.svg and
// predator-watch-mark-dark.svg): a trail camera on a fence post, in Stone
// #6E6259 (light) / #A59C94 (dark). The path data is copied from swag bot
// and is never recolored. Page colors come from src/config/palette.ts
// (APP_COLORS). Writes:
//   public/favicon.svg, favicon.ico, icons/icon-32.png        browser tab
//   public/icons/apple-touch-icon.png                          iOS home screen (web)
//   public/icons/icon-192.png, icon-512.png                    manifest, purpose "any"
//   public/icons/icon-maskable-192.png, icon-maskable-512.png  manifest, purpose "maskable"
//   assets/icon-only.png, icon-foreground.png,                 sources for `npx capacitor-assets generate`,
//   icon-background.png, splash.png, splash-dark.png           which writes the iOS and Android sizes
// Run: npm run app:assets   (needs Node 22.18+ for the .ts import)
import sharp from "sharp";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_COLORS } from "../src/config/palette.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const STONE = { light: "#6E6259", dark: "#A59C94" };
const INK = "#141416";
const NIGHT = "#161310";
const RX = 14 / 64; // official tile corner, same as the brand favicon tile

function markSvg(kind = "light") {
  return readFileSync(join(root, "public/brand", kind === "dark" ? "predator-watch-mark-dark.svg" : "predator-watch-mark.svg"), "utf8");
}

/** Rasterize the official tile at a high density, then downscale. */
async function tilePng(size, kind = "light") {
  const src = Math.max(size * 4, 1024);
  const hi = await sharp(Buffer.from(markSvg(kind)))
    .resize(src, src, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();
  return sharp(hi).resize(size, size, { kernel: sharp.kernel.lanczos3 }).png().toBuffer();
}

/**
 * Official tiles are a Stone plate with the camera knocked out (transparent).
 * For home-screen and tab icons, fill the knockouts with ink (light) or night
 * (dark) so the camera stays readable at 16 and 32 px, matching the v9.1
 * contact sheet. Corners outside the 14/64 plate stay transparent unless a
 * background is passed.
 */
async function iconPng(size, { kind = "light", bg = null, tileFraction = 1 } = {}) {
  const t = Math.round(size * tileFraction);
  const o = Math.round((size - t) / 2);
  const plate = kind === "dark" ? STONE.dark : STONE.light;
  const hole = kind === "dark" ? NIGHT : INK;
  const rx = Math.round(t * RX * 1000) / 1000;
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${t}" height="${t}"><rect width="${t}" height="${t}" rx="${rx}" fill="#fff"/></svg>`,
  );
  const ink = await sharp({ create: { width: t, height: t, channels: 4, background: hole } })
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
  const tile = await tilePng(t, kind);
  const layered = await sharp(ink).composite([{ input: tile, blend: "over" }]).png().toBuffer();
  const canvasBg = bg || { r: 0, g: 0, b: 0, alpha: 0 };
  const out = await sharp({ create: { width: size, height: size, channels: 4, background: canvasBg } })
    .composite([{ input: layered, left: o, top: o }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  return out;
}

async function writePng(file, buf) {
  const dest = join(root, file);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  console.log("wrote", file);
  return buf;
}

/** A .ico holding PNG images (supported by every current browser). */
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(({ size, buf }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size % 256, e); head.writeUInt8(size % 256, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(buf.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += buf.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.buf)]);
}

// Browser tab: the official rounded tile, camera filled with ink.
const i16 = await iconPng(16);
const i32 = await iconPng(32);
await writePng("public/icons/icon-16.png", i16);
await writePng("public/icons/icon-32.png", i32);
writeFileSync(join(root, "public/favicon.ico"), ico([{ size: 16, buf: i16 }, { size: 32, buf: i32 }]));
console.log("wrote public/favicon.ico");

// Manifest "any": official rounded tile on a transparent field.
await writePng("public/icons/icon-192.png", await iconPng(192));
await writePng("public/icons/icon-512.png", await iconPng(512));

// iOS rounds the corners itself: full-bleed Stone, ink camera.
await writePng("public/icons/apple-touch-icon.png", await iconPng(180, { bg: STONE.light }));
copyFileSync(join(root, "public/icons/apple-touch-icon.png"), join(root, "public/apple-touch-icon.png"));
console.log("wrote public/apple-touch-icon.png");
await writePng("assets/icon-only.png", await iconPng(1024, { bg: STONE.light }));

// Maskable: the tile stays inside the 80% safe zone, Stone behind.
await writePng("public/icons/icon-maskable-192.png", await iconPng(192, { bg: STONE.light, tileFraction: 0.8 }));
await writePng("public/icons/icon-maskable-512.png", await iconPng(512, { bg: STONE.light, tileFraction: 0.8 }));

// Android adaptive icon: the tile is the foreground, Stone is the background.
await writePng("assets/icon-foreground.png", await iconPng(1024, { tileFraction: 1 }));
await sharp({ create: { width: 1024, height: 1024, channels: 3, background: STONE.light } })
  .png()
  .toFile(join(root, "assets/icon-background.png"));
console.log("wrote assets/icon-background.png");

// Launch screens: the official tile, merch-style (shirt color shows through
// the camera), centered on the page paper / night color.
const splashTile = 0.16;
async function splash(file, size, kind, bg) {
  const t = Math.round(size * splashTile);
  const o = Math.round((size - t) / 2);
  const tile = await tilePng(t, kind);
  const buf = await sharp({ create: { width: size, height: size, channels: 3, background: bg } })
    .composite([{ input: tile, left: o, top: o }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  return writePng(file, buf);
}
await splash("assets/splash.png", 2732, "light", APP_COLORS.background);
await splash("assets/splash-dark.png", 2732, "dark", APP_COLORS.themeDark);
