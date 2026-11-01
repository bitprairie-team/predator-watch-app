// Predator Watch service worker: keeps a last-good copy so the map opens
// on a weak or missing connection. Only same-origin files are cached;
// basemap and agency map tiles always come from their providers.
const VERSION = "pw-5";
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;
const SHELL_FILES = [
  "/",
  "/app.js",
  "/search.js",
  "/styles.css",
  "/brand.css",
  "/theme.js",
  "/fonts/ibm-plex-sans.woff2",
  "/fonts/ibm-plex-mono-normal-500.woff2",
  "/brand/bitprairie-symbol.svg",
  "/brand/bitprairie-wordmark.svg",
  "/favicon.svg",
  "/vendor/maplibre-gl/maplibre-gl.js",
  "/vendor/maplibre-gl/maplibre-gl.css",
];
const DATA_RE = /^\/api\/(layers|changes|sources\/[a-z0-9-]+(\/changes)?)$/;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(DATA);
  try {
    // Revalidate (cheap with ETag) so a dead connection falls through to
    // the saved copy instead of a stale HTTP-cache entry.
    const res = await fetch(request, { cache: "no-cache" });
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

async function staleWhileRevalidate(request, key) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(key);
  const fresh = fetch(request)
    .then((res) => {
      if (res.ok && !res.redirected) cache.put(key, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || fresh;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (DATA_RE.test(url.pathname) && !url.search) {
    event.respondWith(networkFirst(req));
    return;
  }
  if (req.mode === "navigate" && url.pathname === "/") {
    event.respondWith(staleWhileRevalidate(req, "/"));
    return;
  }
  if (SHELL_FILES.includes(url.pathname)) {
    event.respondWith(staleWhileRevalidate(req, url.pathname));
    return;
  }
  // Place index shards: kept once fetched, so search works offline for letters already used.
  if (url.pathname.startsWith("/data/gazetteer/")) event.respondWith(staleWhileRevalidate(req, url.pathname));
});
