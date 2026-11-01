// Draws the app icons and launch screens from the Predator Watch paw mark
// (public/brand/predator-watch-mark.svg) in the colors from
// src/config/palette.ts (APP_COLORS). Writes:
//   public/icons/icon-maskable-192.png            web app manifest (maskable)
//   assets/icon-only.png, icon-foreground.png,    sources for `npx capacitor-assets generate`,
//   icon-background.png, splash.png, splash-dark.png   which writes the iOS and Android sizes
// Run: npm run app:assets   (needs Node 22.18+ for the .ts import)
import sharp from "sharp";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_COLORS } from "../src/config/palette.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mark = readFileSync(join(root, "public/brand/predator-watch-mark.svg"), "utf8");
// The paw shapes only (ellipses and path), from the brand mark.
const PAW = mark.replace(/^[\s\S]*?<\/title>/, "").replace(/<\/svg>\s*$/, "");

/** A square canvas with the paw centered at `fraction` of the side. */
function svg(size, { bg, fg, fraction }) {
  const s = (size * fraction) / 26; // the paw is about 26 units tall in its 32-unit box
  const t = size / 2 - 16 * s;
  const rect = bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : "";
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${rect}<g transform="translate(${t} ${t}) scale(${s})" fill="${fg}">${PAW}</g></svg>`);
}
async function png(file, size, opts) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  await sharp(svg(size, opts)).png({ compressionLevel: 9 }).toFile(join(root, file));
  console.log("wrote", file);
}

// Maskable: the paw stays inside the 80% safe circle.
await png("public/icons/icon-maskable-192.png", 192, { bg: APP_COLORS.icon, fg: APP_COLORS.iconMark, fraction: 0.42 });
// iOS: full-bleed square, no transparency (iOS rounds the corners).
await png("assets/icon-only.png", 1024, { bg: APP_COLORS.icon, fg: APP_COLORS.iconMark, fraction: 0.52 });
// Android adaptive icon: foreground inside the 66/108 safe zone, plain background.
await png("assets/icon-foreground.png", 1024, { fg: APP_COLORS.iconMark, fraction: 0.36 });
await png("assets/icon-background.png", 1024, { bg: APP_COLORS.icon, fg: APP_COLORS.icon, fraction: 0.01 });
// Launch screens: the paw on the page background, light and dark.
await png("assets/splash.png", 2732, { bg: APP_COLORS.background, fg: APP_COLORS.splashMark, fraction: 0.16 });
await png("assets/splash-dark.png", 2732, { bg: APP_COLORS.themeDark, fg: APP_COLORS.splashMarkDark, fraction: 0.16 });
