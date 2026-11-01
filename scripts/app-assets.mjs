// Draws every app icon, favicon and launch screen from the BitPrairie bison
// tile (public/brand/bitprairie-symbol.svg, the same file the brand owner
// shares as bitprairie-bison-mark.svg): the symbol always sits on the warm
// #c4ae96 plate and is never recolored. Page colors come from
// src/config/palette.ts (APP_COLORS). Writes:
//   public/favicon.svg, favicon.ico, icons/icon-32.png        browser tab
//   public/icons/apple-touch-icon.png                          iOS home screen (web)
//   public/icons/icon-192.png, icon-512.png                    manifest, purpose "any" (rounded tile)
//   public/icons/icon-maskable-192.png, icon-maskable-512.png  manifest, purpose "maskable"
//   assets/icon-only.png, icon-foreground.png,                 sources for `npx capacitor-assets generate`,
//   icon-background.png, splash.png, splash-dark.png           which writes the iOS and Android sizes
// Run: npm run app:assets   (needs Node 22.18+ for the .ts import)
import sharp from "sharp";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_COLORS } from "../src/config/palette.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tile = readFileSync(join(root, "public/brand/bitprairie-symbol.svg"), "utf8");
// The drawing group (with its own transform into the 64-unit tile) and the plate.
const DRAWING = tile.slice(tile.indexOf("<g "), tile.lastIndexOf("</g>") + 4);
const PLATE = /<rect[^>]*fill="(#[0-9a-fA-F]{6})"/.exec(tile)[1];
// Where the drawing sits inside the 64-unit tile (measured from the master).
const BOX = { x: 3.687, y: 14.726, w: 56.626, h: 34.548 };

/**
 * A square canvas. `plate`: "full" (edge to edge, for masks the OS applies),
 * "tile" (rounded 14/64 tile, as in the brand files) or none. `width` is the
 * drawing's width as a fraction of the plate. `bg` fills the canvas first.
 */
function svg(size, { plate = "full", width, tileFraction = 1, bg }) {
  const t = size * tileFraction; // plate side
  const o = (size - t) / 2;
  const s = (t * width) / BOX.w;
  const cx = BOX.x + BOX.w / 2, cy = BOX.y + BOX.h / 2;
  const tx = size / 2 - cx * s, ty = size / 2 - cy * s;
  const back = bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : "";
  const p = plate === "full" ? `<rect x="${o}" y="${o}" width="${t}" height="${t}" fill="${PLATE}"/>`
    : plate === "tile" ? `<rect x="${o}" y="${o}" width="${t}" height="${t}" rx="${(t * 14) / 64}" fill="${PLATE}"/>` : "";
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${back}${p}<g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${s.toFixed(5)})">${DRAWING}</g></svg>`);
}
async function png(file, size, opts) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  const buf = await sharp(svg(size, opts)).png({ compressionLevel: 9 }).toBuffer();
  writeFileSync(join(root, file), buf);
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

const TILE = { plate: "tile", width: BOX.w / 64 }; // exactly the brand tile
// Browser tab: the brand tile itself.
writeFileSync(join(root, "public/favicon.svg"), tile.endsWith("\n") ? tile : tile + "\n");
console.log("wrote public/favicon.svg");
const i16 = await png("public/icons/icon-16.png", 16, TILE);
const i32 = await png("public/icons/icon-32.png", 32, TILE);
writeFileSync(join(root, "public/favicon.ico"), ico([{ size: 16, buf: i16 }, { size: 32, buf: i32 }]));
console.log("wrote public/favicon.ico");
// Manifest "any": the rounded tile, as in the brand files.
await png("public/icons/icon-192.png", 192, TILE);
await png("public/icons/icon-512.png", 512, TILE);
// iOS rounds the corners itself: full-bleed plate, no transparency.
await png("public/icons/apple-touch-icon.png", 180, { width: 0.78 });
await png("assets/icon-only.png", 1024, { width: 0.78 });
// Maskable: the drawing stays inside the 80% safe circle.
await png("public/icons/icon-maskable-192.png", 192, { width: 0.62 });
await png("public/icons/icon-maskable-512.png", 512, { width: 0.62 });
// Android adaptive icon: drawing inside the 66/108 safe circle, plate behind.
await png("assets/icon-foreground.png", 1024, { plate: "none", width: 0.52 });
await sharp({ create: { width: 1024, height: 1024, channels: 3, background: PLATE } }).png().toFile(join(root, "assets/icon-background.png"));
console.log("wrote assets/icon-background.png");
// Launch screens: the rounded tile centered on the page color, light and dark.
await png("assets/splash.png", 2732, { ...TILE, tileFraction: 0.16, bg: APP_COLORS.background });
await png("assets/splash-dark.png", 2732, { ...TILE, tileFraction: 0.16, bg: APP_COLORS.themeDark });
