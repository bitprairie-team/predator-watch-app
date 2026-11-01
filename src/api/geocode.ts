// Street address search for "Find a place".
//
// Places, counties and ZIP codes are searched in the browser against a static
// index built from the Census Bureau Gazetteer (scripts/build-gazetteer.mjs),
// so they never reach an outside service. Only text that looks like a street
// address ("123 Main St, Helena MT") comes here, and is sent to the U.S.
// Census Bureau Geocoder (public, no key):
// https://geocoding.geo.census.gov/geocoder/
// Results are cached at the edge, each client is rate limited, and calls to
// the Census service are capped across all clients (see src/lib/ratelimit.ts).
// Only the search text is sent; nothing about the user is stored.

export interface GeocodeResult {
  name: string;
  lat: number;
  lon: number;
  bbox: [number, number, number, number] | null;
}

export const GEOCODER_ATTRIBUTION =
  "Address search: U.S. Census Bureau Geocoder. This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau.";

const ENDPOINT = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
/** Minimum spacing between calls from one isolate, on top of the shared limiter. */
const MIN_INTERVAL_MS = 1000;
let lastCall = 0;

export function normalizeQuery(q: string | null): string | null {
  if (q === null) return null;
  const s = q.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  if (s.length < 2 || s.length > 120) return null;
  return s;
}

/** A street address starts with a house number and has a street name after it. */
export function looksLikeAddress(q: string): boolean {
  return /^\d{1,6}[a-z]?\s+\S+.*[a-z]{2,}/i.test(q) && q.length >= 8;
}

/** The address service failed or sent something unreadable. */
export class GeocoderError extends Error {}

export async function geocode(
  q: string,
  opts: { fetchImpl?: typeof fetch; userAgent?: string; referer?: string; now?: () => number } = {},
): Promise<GeocodeResult[] | "busy"> {
  const now = (opts.now ?? Date.now)();
  if (now - lastCall < MIN_INTERVAL_MS) return "busy";
  lastCall = now;
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({ address: q, benchmark: "Public_AR_Current", format: "json" }).toString();
  const res = await (opts.fetchImpl ?? fetch)(url.toString(), {
    headers: {
      "User-Agent": opts.userAgent ?? "predator-watch-app",
      Accept: "application/json",
      ...(opts.referer ? { Referer: opts.referer } : {}),
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new GeocoderError(`geocoder HTTP ${res.status}`);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GeocoderError(`geocoder sent non-JSON (HTTP ${res.status}): ${text.slice(0, 120).replace(/\s+/g, " ")}`);
  }
  const raw = parsed as {
    result?: { addressMatches?: { matchedAddress?: string; coordinates?: { x?: number; y?: number } }[] };
  };
  return (raw.result?.addressMatches ?? [])
    .slice(0, 5)
    .map((m) => ({
      name: String(m.matchedAddress ?? "").slice(0, 200),
      lat: Number(m.coordinates?.y),
      lon: Number(m.coordinates?.x),
      bbox: null,
    }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon) && Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180);
}

/** For tests. */
export function resetGeocodeThrottle() {
  lastCall = 0;
}
