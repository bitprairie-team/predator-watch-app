// Builds the offline place index used by "Find a place" from the U.S. Census
// Bureau Gazetteer files (public domain). The output is static JSON under
// public/data/gazetteer/, so place, county and ZIP search never calls an
// outside service.
//
//   node scripts/build-gazetteer.mjs            # downloads the 2024 files
//   node scripts/build-gazetteer.mjs /path/dir  # uses already unzipped .txt files
//
// Needs `curl` and `unzip` on PATH when downloading.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const YEAR = "2024";
const BASE = `https://www2.census.gov/geo/docs/maps-data/data/gazetteer/${YEAR}_Gazetteer`;
const FILES = { place: `${YEAR}_Gaz_place_national`, county: `${YEAR}_Gaz_counties_national`, zcta: `${YEAR}_Gaz_zcta_national` };
const OUT = "public/data/gazetteer";

let dir = process.argv[2];
if (!dir) {
  dir = mkdtempSync(join(tmpdir(), "gaz-"));
  for (const f of Object.values(FILES)) {
    execFileSync("curl", ["-sSfL", "-o", join(dir, `${f}.zip`), `${BASE}/${f}.zip`]);
    execFileSync("unzip", ["-oq", join(dir, `${f}.zip`), "-d", dir]);
  }
}

function rows(name) {
  const [head, ...lines] = readFileSync(join(dir, `${name}.txt`), "latin1").trim().split(/\r?\n/);
  const cols = head.split("\t").map((c) => c.trim());
  return lines.map((l) => Object.fromEntries(l.split("\t").map((v, i) => [cols[i], v.trim()])));
}

const round = (n) => Math.round(Number(n) * 1e4) / 1e4;
// "Abbeville city" -> "Abbeville", "Abanda CDP" -> "Abanda"
const PLACE_SUFFIX = / (city and borough|city|town|village|borough|CDP|municipality|comunidad|zona urbana|urban county|consolidated government.*|unified government.*|metro government.*|metropolitan government.*|corporation|plantation|\(balance\))$/i;
const fold = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// Entry: [name, state, lat, lon, kind, land_sqmi]  kind: p = place, c = county
const entries = [];
for (const r of rows(FILES.place)) {
  let n = r.NAME;
  for (let i = 0; i < 2; i++) n = n.replace(PLACE_SUFFIX, "");
  entries.push([n, r.USPS, round(r.INTPTLAT), round(r.INTPTLONG), "p", Math.round(Number(r.ALAND_SQMI))]);
}
for (const r of rows(FILES.county)) {
  entries.push([r.NAME, r.USPS, round(r.INTPTLAT), round(r.INTPTLONG), "c", Math.round(Number(r.ALAND_SQMI))]);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "zip"), { recursive: true });

const shards = {};
for (const e of entries) {
  const k = fold(e[0])[0];
  const key = /[a-z]/.test(k) ? k : "other";
  (shards[key] ??= []).push(e);
}
for (const [k, list] of Object.entries(shards)) {
  list.sort((a, b) => fold(a[0]).localeCompare(fold(b[0])) || b[5] - a[5]);
  writeFileSync(join(OUT, `${k}.json`), JSON.stringify(list));
}

// ZIP code tabulation areas, sharded by the first two digits: { "59715": [lat, lon], ... }
const zips = {};
for (const r of rows(FILES.zcta)) (zips[r.GEOID.slice(0, 2)] ??= {})[r.GEOID] = [round(r.INTPTLAT), round(r.INTPTLONG)];
for (const [k, m] of Object.entries(zips)) writeFileSync(join(OUT, "zip", `${k}.json`), JSON.stringify(m));

writeFileSync(
  join(OUT, "meta.json"),
  JSON.stringify({
    source: `U.S. Census Bureau, ${YEAR} Gazetteer Files (public domain)`,
    url: "https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html",
    places_and_counties: entries.length,
    zips: Object.values(zips).reduce((n, m) => n + Object.keys(m).length, 0),
    built: new Date().toISOString().slice(0, 10),
  }, null, 2) + "\n",
);
console.log(`wrote ${entries.length} places and counties, ${Object.keys(zips).length} ZIP shards to ${OUT}`);
