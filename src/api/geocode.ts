// Place search for "zoom to a location". Proxies OpenStreetMap Nominatim so
// that results are cached and requests are throttled to Nominatim's usage
// policy (at most one request per second, identified, no autocomplete):
// https://operations.osmfoundation.org/policies/nominatim/
// Only the search text is sent; nothing about the user is stored.

export interface GeocodeResult {
  name: string;
  lat: number;
  lon: number;
  bbox: [number, number, number, number] | null;
}

const ENDPOINT = "https://nominatim.openstreetmap.org/search";
let lastCall = 0;

export function normalizeQuery(q: string | null): string | null {
  if (q === null) return null;
  const s = q.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  if (s.length < 2 || s.length > 120) return null;
  return s;
}

export async function geocode(
  q: string,
  opts: { fetchImpl?: typeof fetch; userAgent?: string; now?: () => number } = {},
): Promise<GeocodeResult[] | "busy"> {
  const now = (opts.now ?? Date.now)();
  if (now - lastCall < 1100) return "busy";
  lastCall = now;
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({ q, format: "jsonv2", limit: "5", countrycodes: "us", "accept-language": "en" }).toString();
  const res = await (opts.fetchImpl ?? fetch)(url.toString(), {
    headers: { "User-Agent": opts.userAgent ?? "predator-watch-app", Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`geocoder HTTP ${res.status}`);
  const raw = (await res.json()) as { display_name?: string; lat?: string; lon?: string; boundingbox?: string[] }[];
  return raw
    .map((r) => {
      const lat = Number(r.lat);
      const lon = Number(r.lon);
      const bb = r.boundingbox?.map(Number);
      return {
        name: String(r.display_name ?? "").slice(0, 200),
        lat,
        lon,
        // Nominatim order: minLat, maxLat, minLon, maxLon
        bbox: bb && bb.length === 4 && bb.every(Number.isFinite) ? ([bb[2], bb[0], bb[3], bb[1]] as [number, number, number, number]) : null,
      };
    })
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
}

/** For tests. */
export function resetGeocodeThrottle() {
  lastCall = 0;
}
