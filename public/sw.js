// Predator Watch service worker: keeps a last-good copy so the app opens on
// a weak or missing connection. Only same-origin files are cached; basemap
// and agency map tiles always come from their providers.
//
// Rules:
// - Pages and app files: network first, so an online visitor always gets the
//   current version; the saved copy is used only when the network fails or
//   takes longer than NET_TIMEOUT_MS. A page never saved shows /offline.html.
// - Versioned files (vendor/maplibre-gl-<version>/, fonts): cache first; a
//   new version is a new URL.
// - Agency data and status (/api/...): network first. A saved copy is
//   returned only with an x-pw-saved-at header holding the time it was
//   saved, and the pages show that time ("Saved copy", offline line). Saved
//   data is never served silently.
const VERSION = "pw-12";
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;
const NET_TIMEOUT_MS = 5000;
const DATA_TIMEOUT_MS = 10000;
// The extensionless URL: /offline.html redirects there, and a redirected
// response cannot answer a navigation.
const OFFLINE_PAGE = "/offline";
const PAGES = ["/", "/about", "/status", "/privacy"];
const SHELL_FILES = [
  ...PAGES,
  OFFLINE_PAGE,
  "/app.js",
  "/net.js",
  "/search.js",
  "/styles.css",
  "/page.css",
  "/brand.css",
  "/theme.js",
  "/prefs.js",
  "/credits.js",
  "/status.js",
  "/layer-style.js",
  "/manifest.webmanifest",
  "/fonts/ibm-plex-sans.woff2",
  "/fonts/ibm-plex-mono-normal-500.woff2",
  "/brand/bitprairie-symbol.svg",
  "/brand/bitprairie-wordmark.svg",
  "/brand/predator-watch-mark.svg",
  "/favicon.svg",
  "/icons/icon-32.png",
  "/icons/icon-192.png",
  "/vendor/maplibre-gl-5.24.0/maplibre-gl.js",
  "/vendor/maplibre-gl-5.24.0/maplibre-gl.css",
];
const IMMUTABLE_RE = /^\/(vendor|fonts)\//;
const DATA_RE = /^\/api\/(layers|changes|status|sources\/[a-z0-9-]+(\/changes)?)$/;

self.addEventListener("install", (event) => {
  // Each file on its own, so one missing file cannot leave the cache empty.
  event.waitUntil(
    caches.open(SHELL)
      .then((c) => Promise.all(SHELL_FILES.map((f) => c.add(f).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** fetch() that rejects after ms, so a stalled connection falls back. */
function fetchWithin(request, ms, init) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("network timeout")), ms);
    fetch(request, init).then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Pages and app files: network first, saved copy on failure. */
async function networkFirstShell(request, key, fallback) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetchWithin(request, NET_TIMEOUT_MS);
    if (res.ok && !res.redirected && res.type === "basic") cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = (await cache.match(key)) || (fallback && (await cache.match(fallback)));
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request, key) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(key, res.clone());
  return res;
}

/** Data: network first; a saved copy always carries x-pw-saved-at. */
async function networkFirstData(request) {
  const cache = await caches.open(DATA);
  try {
    // Revalidate (cheap with ETag) so a dead connection falls through to
    // the saved copy instead of a stale HTTP-cache entry.
    const res = await fetchWithin(request, DATA_TIMEOUT_MS, { cache: "no-cache" });
    if (res.ok) {
      const headers = new Headers(res.headers);
      headers.set("x-pw-saved-at", new Date().toISOString());
      const copy = new Response(await res.clone().blob(), { status: res.status, statusText: res.statusText, headers });
      await cache.put(request.url, copy);
    }
    return res;
  } catch (err) {
    const hit = await cache.match(request.url);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "").replace(/\.html$/, "") : "/";
  if (DATA_RE.test(url.pathname) && !url.search) {
    event.respondWith(networkFirstData(req));
    return;
  }
  if (req.mode === "navigate") {
    const key = PAGES.includes(path) ? path : null;
    event.respondWith(key ? networkFirstShell(req, key, OFFLINE_PAGE) : fetch(req).catch(() => caches.match(OFFLINE_PAGE)));
    return;
  }
  if (IMMUTABLE_RE.test(url.pathname)) {
    event.respondWith(cacheFirst(req, url.pathname));
    return;
  }
  if (SHELL_FILES.includes(url.pathname)) {
    event.respondWith(networkFirstShell(req, url.pathname));
    return;
  }
  // Place index shards: kept once fetched, so search works offline for letters already used.
  if (url.pathname.startsWith("/data/gazetteer/")) event.respondWith(cacheFirst(req, url.pathname));
});
