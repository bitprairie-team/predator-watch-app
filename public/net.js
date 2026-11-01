// Where the API lives, and saved copies for the store apps.
//
// On the website the API is this origin and sw.js keeps saved copies. In the
// iOS and Android apps (Capacitor) the pages are bundled on the device, so
// scripts/build-native.mjs adds <meta name="pw-api-base"> pointing at the
// public site, and this file keeps the saved copies itself, with the same
// x-pw-saved-at header the service worker uses. A saved copy is only used
// when the network fails, and the pages always show its time.
const meta = typeof document !== "undefined" ? document.querySelector('meta[name="pw-api-base"]') : null;
export const API_BASE = (meta?.getAttribute("content") || "").replace(/\/+$/, "");
/** True inside the store apps (bundled pages, remote API). */
export const NATIVE = Boolean(API_BASE);

/** Absolute URL for an API or OGC path; other paths are unchanged. */
export function api(path) {
  return NATIVE && /^\/(api|ogc)(\/|$)/.test(path) ? API_BASE + path : path;
}

const SAVE_RE = /^\/api\/(layers|changes|status|sources\/[a-z0-9-]+(\/changes)?)$/;
const CACHE = "pw-app-data-1";

/** fetch() for API paths. In the apps, saves good answers and falls back to them. */
export async function apiFetch(path, init) {
  const url = api(path);
  if (!NATIVE || !SAVE_RE.test(path) || typeof caches === "undefined") return fetch(url, init);
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { /* Cache API not available here */ }
  try {
    const res = await fetch(url, init);
    if (res.ok && cache) {
      const headers = new Headers(res.headers);
      headers.set("x-pw-saved-at", new Date().toISOString());
      cache.put(url, new Response(await res.clone().blob(), { status: res.status, headers })).catch(() => {});
    }
    return res;
  } catch (err) {
    const hit = cache && (await cache.match(url));
    if (hit) return hit;
    throw err;
  }
}
