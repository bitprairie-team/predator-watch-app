// Copies the MapLibre GL build into public/vendor so the app serves it from
// its own origin (no third-party script CDN). Runs on `npm install` and
// before `wrangler dev` / `wrangler deploy` via the build command in wrangler.jsonc.
//
// The folder name carries the library version (vendor/maplibre-gl-5.24.0/),
// so the files can be cached for a year as immutable (see public/_headers).
// When the package version changes, this script points index.html and sw.js
// at the new folder and removes the old one. test/stage7-mobile.test.ts checks that
// the references match the installed version.
import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(root, "node_modules", "maplibre-gl");
const src = join(pkgDir, "dist");

if (!existsSync(src)) {
  console.warn("maplibre-gl not installed yet; skipping vendor copy");
  process.exit(0);
}
const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
const folder = `maplibre-gl-${version}`;
const vendor = join(root, "public", "vendor");
const dest = join(vendor, folder);
mkdirSync(dest, { recursive: true });
for (const f of ["maplibre-gl.js", "maplibre-gl.css", "LICENSE.txt"]) {
  cpSync(join(src, f), join(dest, f));
}
for (const old of readdirSync(vendor)) {
  if (old.startsWith("maplibre-gl") && old !== folder) rmSync(join(vendor, old), { recursive: true, force: true });
}
for (const f of ["public/index.html", "public/sw.js"]) {
  const p = join(root, f);
  const text = readFileSync(p, "utf8");
  const next = text.replace(/\/vendor\/maplibre-gl(?:-[0-9][0-9A-Za-z.-]*)?\//g, `/vendor/${folder}/`);
  if (next !== text) writeFileSync(p, next);
}
console.log(`Copied maplibre-gl ${version} to public/vendor/${folder}`);
