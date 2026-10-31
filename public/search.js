// "Find a place": places, counties and ZIP codes are matched in the browser
// against a static index of the U.S. Census Bureau Gazetteer (public domain),
// loaded one letter at a time. Only street addresses ("123 Main St, Helena MT")
// go to the server, which looks them up with the Census Bureau Geocoder.
// Loaded on first use, so it adds nothing to the first page load.

const STATES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  "puerto rico": "PR", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX",
  utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
const CODES = new Set(Object.values(STATES));

export const fold = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const shards = new Map();
function load(path) {
  if (!shards.has(path)) {
    const p = fetch(path).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    p.catch(() => shards.delete(path));
    shards.set(path, p);
  }
  return shards.get(path);
}

export function parseLatLon(q) {
  const m = q.match(/^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!m) return null;
  let a = Number(m[1]), b = Number(m[2]);
  if (Math.abs(a) > 90 && Math.abs(b) <= 90) [a, b] = [b, a];
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return { lat: a, lon: b, name: `${a.toFixed(4)}, ${b.toFixed(4)}`, zoom: 10 };
}

export function looksLikeAddress(q) {
  return /^\d{1,6}[a-z]?\s+\S+.*[a-z]{2,}/i.test(q) && q.length >= 8;
}

/** Split "Bozeman, MT", "Bozeman Montana" or "Gallatin County MT" into name and state. */
export function splitState(q) {
  const f = fold(q);
  for (const [name, code] of Object.entries(STATES)) {
    if (f.endsWith(` ${name}`) && f.length > name.length + 1) return { name: f.slice(0, -name.length - 1).trim(), state: code };
  }
  const m = f.match(/^(.*\S)\s+([a-z]{2})$/);
  if (m && CODES.has(m[2].toUpperCase()) && q.match(/[,\s][A-Za-z]{2}\s*$/)) return { name: m[1], state: m[2].toUpperCase() };
  return { name: f, state: null };
}

function zoomFor(kind, sqmi) {
  if (kind === "c") return sqmi > 3000 ? 7.5 : 8.5;
  if (kind === "z") return 11;
  return sqmi > 200 ? 9.5 : sqmi > 20 ? 10.5 : 11.5;
}

/** Local search: returns up to `limit` matches, best first. */
export async function searchLocal(q, limit = 8) {
  const raw = q.trim();
  if (/^\d{5}$/.test(raw)) {
    const m = await load(`/data/gazetteer/zip/${raw.slice(0, 2)}.json`).catch(() => ({}));
    const hit = m[raw];
    return hit ? [{ name: `ZIP ${raw}`, lat: hit[0], lon: hit[1], zoom: 11 }] : [];
  }
  const { name, state } = splitState(raw);
  if (name.length < 2) return [];
  const first = /[a-z]/.test(name[0]) ? name[0] : "other";
  const list = await load(`/data/gazetteer/${first}.json`);
  const out = [];
  for (const e of list) {
    const n = fold(e[0]);
    if (!n.startsWith(name)) continue;
    if (state && e[1] !== state) continue;
    const exact = n === name || n === `${name} county`;
    out.push({ e, score: (exact ? 1e9 : 0) + (e[4] === "c" ? 5e5 : 0) + e[5] });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit).map(({ e }) => ({
    name: `${e[0]}, ${e[1]}`,
    kind: e[4] === "c" ? "County" : "Place",
    lat: e[2],
    lon: e[3],
    zoom: zoomFor(e[4], e[5]),
  }));
}

export async function searchAddress(q) {
  const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(12000) });
  if (res.status === 429) return { busy: true, results: [] };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return { results: body.results.map((r) => ({ ...r, kind: "Address", zoom: 15 })), attribution: body.attribution };
}
