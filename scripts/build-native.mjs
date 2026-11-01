// Builds the web files for the iOS and Android apps (Capacitor) into
// dist/native, which capacitor.config.ts uses as webDir.
//
//   npm run build:native     # then: npx cap sync
//
// The apps load these bundled files from the device and get live data from
// the public site's API (CORS is open on /api and /ogc). Changes from public/:
// - <meta name="pw-api-base"> tells net.js where the API is, and turns on
//   its saved copies (the service worker is not used in the apps).
// - A Content-Security-Policy <meta> (the site sends it as a header via
//   _headers, which the apps do not read), with the API origin added.
// - Page links get .html (the app's local server has no /about -> about.html
//   rewrite) and API links in the pages point at the public site.
// - _headers, sw.js and the /api/layers preload are left out.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "public");
const OUT = join(ROOT, "dist", "native");
export const API_ORIGIN = process.env.PW_API_ORIGIN || "https://app.predatorwatch.org";
const SKIP = new Set(["_headers", "sw.js", "_redirects"]);
const PAGES = ["about", "status", "privacy", "offline"];

/** The site's CSP from _headers, adjusted for a page loaded from the app. */
export function nativeCsp(headersText, apiOrigin = API_ORIGIN) {
  const m = /Content-Security-Policy:\s*(.+)/.exec(headersText);
  if (!m) throw new Error("no Content-Security-Policy in public/_headers");
  return m[1]
    .split(";").map((d) => d.trim()).filter(Boolean)
    // Not allowed in a <meta> CSP, or meaningless on the app's local origin.
    .filter((d) => !/^(frame-ancestors|upgrade-insecure-requests|report-uri|sandbox)\b/.test(d))
    .map((d) => (/^(connect-src|img-src)\b/.test(d) ? `${d} ${apiOrigin}` : d))
    .join("; ");
}

/** Rewrites one HTML page for the app bundle. */
export function nativeHtml(html, csp, apiOrigin = API_ORIGIN) {
  let out = html
    .replace(/\s*<link rel="preload" href="\/api\/[^"]*"[^>]*>/g, "")
    .replace(/href="\/(api|ogc)([/"#?])/g, `href="${apiOrigin}/$1$2`)
    .replace(new RegExp(`href="/(${PAGES.join("|")})(?=["#?])`, "g"), 'href="/$1.html');
  const metas = `\n  <meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, "&quot;")}">\n  <meta name="pw-api-base" content="${apiOrigin}">`;
  out = out.replace(/<meta charset="utf-8">/, (m) => m + metas);
  if (!out.includes('name="pw-api-base"')) throw new Error("page has no <meta charset> to anchor the app tags");
  return out;
}

function build() {
  if (!existsSync(join(SRC, "vendor"))) throw new Error("public/vendor is missing: run `npm install` (or `npm run vendor`) first");
  rmSync(OUT, { recursive: true, force: true });
  cpSync(SRC, OUT, { recursive: true, filter: (p) => !SKIP.has(p.slice(SRC.length + 1)) });
  const csp = nativeCsp(readFileSync(join(SRC, "_headers"), "utf8"));
  const pages = readdirSync(OUT).filter((f) => f.endsWith(".html"));
  for (const f of pages) writeFileSync(join(OUT, f), nativeHtml(readFileSync(join(OUT, f), "utf8"), csp));
  console.log(`dist/native: ${pages.length} pages, API ${API_ORIGIN}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) build();
