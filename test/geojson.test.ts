import { beforeEach, describe, expect, it } from "vitest";
import { GeoJsonAdapter } from "../src/adapters/geojson";
import { SOURCES } from "../src/config/sources";
import { resetRateLimiter } from "../src/lib/http";
import { fixture, jsonResponse, stubFetch } from "./helpers";

const cdfw = SOURCES.find((s) => s.id === "cdfw-collared-wolf-cells");
if (!cdfw || cdfw.type !== "geojson") throw new Error("CDFW source missing");
const cfg = { ...cdfw, http: { minIntervalMs: 0 } };
const LM = "Sat, 31 Oct 2026 19:00:43 GMT";
const now = () => new Date("2026-10-31T19:30:00Z");

beforeEach(() => resetRateLimiter());

describe("GeoJsonAdapter with the CDFW wolf location fixture", () => {
  it("normalizes every cell without changing the agency geometry", async () => {
    const raw = fixture("cdfw-wolf-bins.json") as { features: { geometry: unknown; properties: Record<string, string> }[] };
    const stub = stubFetch([{ match: () => true, respond: () => jsonResponse(raw, { "last-modified": LM }) }]);
    const r = await new GeoJsonAdapter(cfg).load({ fetch: stub.fetch, now, env: {} });
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.features).toHaveLength(raw.features.length);
    expect(r.sourceUpdatedMs).toBe(Date.parse(LM));
    r.features.forEach((f, i) => expect(f.geometry).toEqual(raw.features[i]!.geometry));

    const p = r.features[0]!.properties;
    expect(p).toMatchObject({
      source_id: "cdfw-collared-wolf-cells",
      species: "Gray wolf",
      agency: "California Department of Fish and Wildlife",
      label: raw.features[0]!.properties.name,
      observed_at_precision: "day",
      received_at: "2026-10-31T19:30:00.000Z",
      precision: "hex-cell",
      geometry_type: "Polygon",
      url: "https://wildlife.ca.gov/Conservation/Mammals/Gray-Wolf/Location-Map",
    });
    expect(p.observed_at).toMatch(/^\d{4}-\d\d-\d\dT00:00:00.000Z$/);
    expect(p.details["Pack of origin"]).toBe(raw.features[0]!.properties.pack_origin);
    expect(new Set(r.features.map((f) => f.id)).size).toBe(r.features.length);
  });

  it("uses conditional requests and reports unchanged on 304", async () => {
    const stub = stubFetch([{ match: () => true, respond: () => new Response(null, { status: 304, headers: { "last-modified": LM } }) }]);
    const r = await new GeoJsonAdapter(cfg).load({
      fetch: stub.fetch,
      now,
      env: {},
      previous: { sourceUpdatedMs: Date.parse(LM), validator: `lm:${LM}`, hasData: true },
    });
    expect(r.changed).toBe(false);
    expect(new Headers(stub.calls[0]!.init?.headers).get("If-Modified-Since")).toBe(LM);
  });

  it("rejects responses that are not FeatureCollections", async () => {
    const stub = stubFetch([{ match: () => true, respond: () => jsonResponse({ hello: "world" }) }]);
    await expect(new GeoJsonAdapter(cfg).load({ fetch: stub.fetch, now, env: {} })).rejects.toThrow(/FeatureCollection/);
  });
});
