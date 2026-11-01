// Copies the MapLibre GL build into public/vendor so the app serves it from
// its own origin (no third-party script CDN). Runs on `npm install` and
// before `wrangler dev` / `wrangler deploy` via the build command in wrangler.jsonc.
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "maplibre-gl", "dist");
const dest = join(root, "public", "vendor", "maplibre-gl");

if (!existsSync(src)) {
  console.warn("maplibre-gl not installed yet; skipping vendor copy");
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
for (const f of ["maplibre-gl.js", "maplibre-gl.css", "LICENSE.txt"]) {
  cpSync(join(src, f), join(dest, f));
}
console.log("Copied maplibre-gl to public/vendor/maplibre-gl");
