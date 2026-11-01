import { beforeEach, describe, expect, it } from "vitest";
import { csvCell, geometryToWkt, toCsv, toKml } from "../src/api/export";
import { normalizeQuery } from "../src/api/geocode";
import { parseBbox } from "../src/api/ogc";
import { refreshDue, refreshSource, readStatus, type Env } from "../src/cache";
import { handleRequest } from "../src/index";
import { diffFeatures } from "../src/lib/changes";
import { bboxIntersects } from "../src/lib/geometry";
import { resetRateLimiter } from "../src/lib/http";
import { Registry } from "../src/registry";
import type { NormalizedCollection, NormalizedFeature } from "../src/schema";
import { fixture, jsonResponse, memoryKV, stubFetch } from "./helpers";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const LM = "Sat, 31 Oct 2026 19:00:43 GMT";
const ID = "cdfw-collared-wolf-cells";

async function seeded(): Promise<Env> {
  const env: Env = { LAYER_CACHE: memoryKV() };
  const stub = stubFetch([{ match: () => true, respond: () => jsonResponse(fixture("cdfw-wolf-bins.json"), { "last-modified": LM }) }]);
  await refreshSource(new Registry().get(ID)!, env, { fetchImpl: stub.fetch });
  return env;
}
const get = (env: Env, path: string, init?: RequestInit) => handleRequest(new Request(`https://app.example${path}`, init), env, ctx);

beforeEach(() => resetRateLimiter());

describe("API hardening", () => {
  it("sets security, cache and ETag headers, and answers If-None-Match with 304", async () => {
    const env = await seeded();
    const res = await get(env, `/api/sources/${ID}`);
    expect(res.status).toBe(200);
    for (const h of ["strict-transport-security", "x-content-type-options", "referrer-policy", "permissions-policy", "content-security-policy"]) {
      expect(res.headers.get(h), h).toBeTruthy();
    }
    expect(res.headers.get("cache-control")).toMatch(/max-age=60/);
    const etag = res.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"/);
    const again = await get(env, `/api/sources/${ID}`, { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  it("returns no body for HEAD", async () => {
    const env = await seeded();
    const res = await get(env, `/api/sources/${ID}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("validates input", async () => {
    const env = await seeded();
    expect((await get(env, "/api/sources/UPPER")).status).toBe(404);
    expect((await get(env, "/api/sources/../../etc")).status).toBe(404);
    expect((await get(env, `/api/sources/${ID}.exe`)).status).toBe(404);
    expect((await get(env, `/api/layers?${"x".repeat(600)}`)).status).toBe(414);
    expect((await get(env, "/api/layers", { method: "DELETE" })).headers.get("allow")).toMatch(/GET/);
    expect((await get(env, "/api/geocode?q=a")).status).toBe(400);
    expect((await get(env, "/api/nope")).status).toBe(404);
    expect((await get(env, "/api/layers", { method: "OPTIONS" })).status).toBe(204);
  });
});

describe("exports", () => {
  it("serves GeoJSON, KML and CSV downloads with filenames", async () => {
    const env = await seeded();
    const g = await get(env, `/api/sources/${ID}.geojson`);
    expect(g.headers.get("content-type")).toMatch(/geo\+json/);
    expect(g.headers.get("content-disposition")).toMatch(/cdfw-collared-wolf-cells-\d{4}-\d{2}-\d{2}\.geojson/);
    const k = await get(env, `/api/sources/${ID}.kml`);
    const kml = await k.text();
    expect(kml).toMatch(/^<\?xml/);
    expect(kml).toMatch(/<Placemark id="cdfw-collared-wolf-cells:/);
    expect(kml).toMatch(/<Polygon><outerBoundaryIs>/);
    const c = await get(env, `/api/sources/${ID}.csv`);
    const csv = await c.text();
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toMatch(/^id,label,species,agency,/);
    expect(lines[0]).toMatch(/,wkt$/);
    expect(lines).toHaveLength(16);
  });

  it("escapes XML and neutralizes spreadsheet formulas", () => {
    const f = {
      type: "Feature",
      id: "x:1",
      geometry: { type: "Point", coordinates: [-120, 40] },
      properties: { id: "x:1", label: '<b>"A&B"</b>', details: { note: "=HYPERLINK(1)" } },
    } as unknown as NormalizedFeature;
    const fc = { type: "FeatureCollection", features: [f], metadata: { received_at: null, source: { name: "n", agency: "a", attribution: "t", license: "l", info_url: "u" } } } as unknown as NormalizedCollection;
    expect(toKml(fc)).toContain("&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;");
    expect(toCsv([f])).toContain("'=HYPERLINK(1)");
    expect(csvCell("-12.5")).toBe("-12.5");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(geometryToWkt({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] })).toBe("POLYGON ((0 0, 1 0, 1 1, 0 0))");
  });
});

describe("OGC API Features", () => {
  it("serves landing, conformance and collections", async () => {
    const env = await seeded();
    const land = (await (await get(env, "/ogc")).json()) as { links: { rel: string }[] };
    expect(land.links.map((l) => l.rel)).toEqual(expect.arrayContaining(["self", "conformance", "data"]));
    const conf = (await (await get(env, "/ogc/conformance")).json()) as { conformsTo: string[] };
    expect(conf.conformsTo).toContain("http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson");
    const cols = (await (await get(env, "/ogc/collections")).json()) as { collections: { id: string }[] };
    expect(cols.collections.map((c) => c.id)).toContain(ID);
    const one = (await (await get(env, `/ogc/collections/${ID}`)).json()) as { extent: { spatial: { bbox: number[][] } } };
    expect(one.extent.spatial.bbox[0]).toHaveLength(4);
  });

  it("filters items by bbox and pages with limit/offset", async () => {
    const env = await seeded();
    const all = (await (await get(env, `/ogc/collections/${ID}/items?limit=5`)).json()) as {
      numberMatched: number; numberReturned: number; links: { rel: string; href: string }[]; features: NormalizedFeature[];
    };
    expect(all.numberMatched).toBe(15);
    expect(all.numberReturned).toBe(5);
    const next = all.links.find((l) => l.rel === "next")!;
    expect(next.href).toMatch(/offset=5/);
    const none = (await (await get(env, `/ogc/collections/${ID}/items?bbox=-80,30,-70,40`)).json()) as { numberMatched: number };
    expect(none.numberMatched).toBe(0);
    const some = (await (await get(env, `/ogc/collections/${ID}/items?bbox=-125,32,-114,42.1`)).json()) as { numberMatched: number };
    expect(some.numberMatched).toBe(15);
    const fid = all.features[0]!.id;
    const item = await get(env, `/ogc/collections/${ID}/items/${encodeURIComponent(fid)}`);
    expect(item.status).toBe(200);
    expect(((await item.json()) as { id: string }).id).toBe(fid);
  });

  it("rejects bad parameters", async () => {
    const env = await seeded();
    for (const q of ["bbox=1,2,3", "bbox=a,b,c,d", "bbox=-200,0,0,1", "bbox=0,10,1,5", "limit=0", "limit=5000", "offset=-1", "foo=1", "f=xml"]) {
      expect((await get(env, `/ogc/collections/${ID}/items?${q}`)).status, q).toBe(400);
    }
    expect((await get(env, "/ogc/collections/nope-nope/items")).status).toBe(404);
  });

  it("handles bboxes across the antimeridian", () => {
    expect(parseBbox("170,50,-170,60")).toEqual([170, 50, -170, 60]);
    expect(bboxIntersects([175, 51, 178, 52], [170, 50, -170, 60])).toBe(true);
    expect(bboxIntersects([-178, 51, -175, 52], [170, 50, -170, 60])).toBe(true);
    expect(bboxIntersects([179, 51, 181, 52], [-179.5, 50, -179, 60])).toBe(true);
    expect(bboxIntersects([0, 51, 1, 52], [170, 50, -170, 60])).toBe(false);
  });
});

describe("changes feed", () => {
  const feat = (id: string, label: string, x = 0): NormalizedFeature =>
    ({ type: "Feature", id, geometry: { type: "Point", coordinates: [x, 0] }, properties: { id, label, received_at: String(Math.random()) } }) as unknown as NormalizedFeature;

  it("reports added, removed and modified items and ignores our receive time", () => {
    const d = diffFeatures([feat("a", "A"), feat("b", "B"), feat("c", "C")], [feat("a", "A"), feat("b", "B", 1), feat("d", "D")], "t")!;
    expect([d.added, d.removed, d.modified]).toEqual([1, 1, 1]);
    expect(d.added_items[0]!.label).toBe("D");
    expect(diffFeatures([feat("a", "A")], [feat("a", "A")], "t")).toBeNull();
    expect(diffFeatures(null, [feat("a", "A")], "t")).toBeNull();
  });

  it("records changes on refresh and serves them", async () => {
    const env = await seeded();
    const raw = fixture("cdfw-wolf-bins.json") as { features: { properties: Record<string, string> }[] };
    const changed = { ...raw, features: raw.features.slice(1) };
    const stub = stubFetch([{ match: () => true, respond: () => jsonResponse(changed, { "last-modified": "Sun, 01 Nov 2026 19:00:00 GMT" }) }]);
    await refreshSource(new Registry().get(ID)!, env, { fetchImpl: stub.fetch, force: true });
    const body = (await (await get(env, `/api/sources/${ID}/changes`)).json()) as { changes: { removed: number }[] };
    expect(body.changes[0]!.removed).toBeGreaterThanOrEqual(1);
    const all = (await (await get(env, "/api/changes")).json()) as { sources: { source_id: string }[] };
    expect(all.sources.length).toBe(new Registry().ids().length);
    // Internal fields stay private.
    const layer = await (await get(env, `/api/sources/${ID}`)).text();
    expect(layer).not.toMatch(/"changes"/);
  });
});

describe("cron request budget", () => {
  it("defers sources once the outbound request budget is used", async () => {
    const env: Env = { LAYER_CACHE: memoryKV() };
    const down = (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch;
    const reg = new Registry();
    for (const a of reg.all()) (a.config as { http?: object }).http = { minIntervalMs: 0, retries: 0 };
    const r = await refreshDue(reg, env, { fetchImpl: down, requestBudget: 8 });
    const deferred = Object.values(r).filter((s) => s === "deferred").length;
    expect(deferred).toBeGreaterThan(0);
    expect(Object.keys(r)).toHaveLength(reg.ids().length);
    expect((await readStatus(env.LAYER_CACHE, reg.ids()[0]!)).state).not.toBe("never");
  });
});

describe("geocode input", () => {
  it("normalizes and bounds the query", () => {
    expect(normalizeQuery("  Boise \n Idaho ")).toBe("Boise Idaho");
    expect(normalizeQuery("x")).toBeNull();
    expect(normalizeQuery("y".repeat(121))).toBeNull();
    expect(normalizeQuery(null)).toBeNull();
  });
});
