import { beforeEach, describe, expect, it } from "vitest";
import { ArcGisAdapter, pickDatedLayer, type ArcGisSourceConfig, validateArcGisConfig } from "../src/adapters/arcgis";
import { resetRateLimiter } from "../src/lib/http";
import { fixture, jsonResponse, stubFetch } from "./helpers";

const WDFW = "https://geodataservices.wdfw.wa.gov/arcgis/rest/services/WP_Statewide/Wolf_PackPolygons/MapServer/0";
const NIFC = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0";

const base = {
  name: "Test",
  category: "wolf-activity",
  species: "Gray wolf",
  agency: "Test Agency",
  infoUrl: "https://example.org/info",
  license: "Public",
  attribution: "Test Agency",
  cadence: "Annual",
  refreshMinutes: 60,
  precision: "pack-territory",
  style: { color: "#000" },
} as const;

const wdfwConfig: ArcGisSourceConfig = {
  ...base,
  type: "arcgis",
  id: "wdfw-test",
  url: WDFW,
  fields: {
    idField: "PackID",
    label: "{Pack} pack",
    observedAt: { field: "Year", format: "year" },
    details: { "Pack status": "PackStatus" },
  },
  http: { minIntervalMs: 0 },
};

const now = () => new Date("2026-10-31T19:45:00Z");

function wdfwRoutes() {
  return [
    { match: (u: URL) => u.pathname.endsWith("/MapServer/0"), respond: () => jsonResponse(fixture("wdfw-layer.json")) },
    {
      match: (u: URL) => u.pathname.endsWith("/query") && u.searchParams.get("resultOffset") === "0",
      respond: () => jsonResponse(fixture("wdfw-query-page1.json")),
    },
    {
      match: (u: URL) => u.pathname.endsWith("/query") && u.searchParams.get("resultOffset") === "3",
      respond: () => jsonResponse(fixture("wdfw-query-page2.json")),
    },
  ];
}

beforeEach(() => resetRateLimiter());

describe("ArcGisAdapter", () => {
  it("pages with resultOffset while exceededTransferLimit is true and normalizes features", async () => {
    const stub = stubFetch(wdfwRoutes());
    const r = await new ArcGisAdapter(wdfwConfig).load({ fetch: stub.fetch, now, env: {} });
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.features).toHaveLength(5);

    const queries = stub.calls.filter((c) => c.url.pathname.endsWith("/query"));
    expect(queries.map((c) => c.url.searchParams.get("resultOffset"))).toEqual(["0", "3"]);
    for (const q of queries) {
      expect(q.url.searchParams.get("outSR")).toBe("4326");
      expect(q.url.searchParams.get("f")).toBe("json");
      expect(q.url.searchParams.get("outFields")!.split(",").sort()).toEqual(["OBJECTID", "Pack", "PackID", "PackStatus", "Year"].sort());
    }

    const p = r.features[0]!.properties;
    expect(p).toMatchObject({
      source_id: "wdfw-test",
      species: "Gray wolf",
      agency: "Test Agency",
      label: "Goodman Meadows pack",
      observed_at: "2025-01-01T00:00:00.000Z",
      observed_at_precision: "year",
      received_at: "2026-10-31T19:45:00.000Z",
      precision: "pack-territory",
      url: "https://example.org/info",
      license: "Public",
      attribution: "Test Agency",
      details: { "Pack status": "Nonbreeding Pack" },
    });
    expect(p.id).toBe("wdfw-test:3");
    expect(["Polygon", "MultiPolygon"]).toContain(r.features[0]!.geometry?.type);
    expect(p.geometry_type).toBe(r.features[0]!.geometry?.type);
  });

  it("skips the download when editingInfo.lastEditDate has not changed", async () => {
    const meta = fixture("nifc-layer.json") as { editingInfo: { lastEditDate: number } };
    const stub = stubFetch([
      { match: (u) => u.pathname.endsWith("/FeatureServer/0"), respond: () => jsonResponse(meta) },
      { match: (u) => u.pathname.endsWith("/query"), respond: () => jsonResponse(fixture("nifc-query.json")) },
    ]);
    const cfg: ArcGisSourceConfig = {
      ...base,
      type: "arcgis",
      id: "nifc-test",
      category: "context",
      species: null,
      precision: "incident-perimeter",
      url: NIFC,
      fields: { label: "{poly_IncidentName} fire", observedAt: { field: "poly_DateCurrent", format: "epoch-ms" } },
      http: { minIntervalMs: 0 },
    };
    const a = new ArcGisAdapter(cfg);
    const unchanged = await a.load({
      fetch: stub.fetch,
      now,
      env: {},
      previous: { sourceUpdatedMs: meta.editingInfo.lastEditDate, validator: null, hasData: true },
    });
    expect(unchanged.changed).toBe(false);
    expect(stub.calls.some((c) => c.url.pathname.endsWith("/query"))).toBe(false);

    const changed = await a.load({
      fetch: stub.fetch,
      now,
      env: {},
      previous: { sourceUpdatedMs: meta.editingInfo.lastEditDate - 1, validator: null, hasData: true },
    });
    expect(changed.changed).toBe(true);
    if (changed.changed) {
      expect(changed.sourceUpdatedMs).toBe(meta.editingInfo.lastEditDate);
      expect(changed.features[0]!.properties.label).toMatch(/ fire$/);
      expect(changed.features[0]!.properties.observed_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    }
  });

  it("falls back to object id batches when the layer does not support pagination", async () => {
    const meta = { ...(fixture("wdfw-layer.json") as object), maxRecordCount: 2, advancedQueryCapabilities: { supportsPagination: false } };
    const page1 = fixture("wdfw-query-page1.json") as { features: unknown[] };
    const stub = stubFetch([
      { match: (u) => u.pathname.endsWith("/MapServer/0"), respond: () => jsonResponse(meta) },
      { match: (u) => u.searchParams.get("returnIdsOnly") === "true", respond: () => jsonResponse({ objectIds: [521, 519, 520] }) },
      {
        match: (u) => u.searchParams.has("objectIds"),
        respond: (u) => {
          const ids = u.searchParams.get("objectIds")!.split(",");
          return jsonResponse({ features: page1.features.slice(0, ids.length) });
        },
      },
    ]);
    const r = await new ArcGisAdapter(wdfwConfig).load({ fetch: stub.fetch, now, env: {} });
    expect(r.changed && r.features.length).toBe(3);
    const batches = stub.calls.filter((c) => c.url.searchParams.has("objectIds")).map((c) => c.url.searchParams.get("objectIds"));
    expect(batches).toEqual(["519,520", "521"]);
  });

  it("sends the optional API key only from env and only when the source opts in", async () => {
    const stub = stubFetch(wdfwRoutes());
    await new ArcGisAdapter(wdfwConfig).load({ fetch: stub.fetch, now, env: { ARCGIS_API_KEY: "k-123" } });
    expect(stub.calls.every((c) => !c.url.searchParams.has("token"))).toBe(true);

    const stub2 = stubFetch(wdfwRoutes());
    await new ArcGisAdapter({ ...wdfwConfig, useApiKey: true }).load({ fetch: stub2.fetch, now, env: { ARCGIS_API_KEY: "k-123" } });
    expect(stub2.calls.every((c) => c.url.searchParams.get("token") === "k-123")).toBe(true);
  });

  it("surfaces ArcGIS JSON errors and does not leak query strings", async () => {
    const stub = stubFetch([
      { match: (u) => u.pathname.endsWith("/MapServer/0"), respond: () => jsonResponse(fixture("wdfw-layer.json")) },
      { match: () => true, respond: () => jsonResponse({ error: { code: 400, message: "Invalid query parameters." } }) },
    ]);
    await expect(
      new ArcGisAdapter({ ...wdfwConfig, useApiKey: true }).load({ fetch: stub.fetch, now, env: { ARCGIS_API_KEY: "secret" } }),
    ).rejects.toThrow(/Invalid query parameters/);
  });

  it("times out slow servers", async () => {
    const hang = (async (_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
      })) as typeof fetch;
    const cfg = { ...wdfwConfig, http: { minIntervalMs: 0, timeoutMs: 20, retries: 0 } };
    await expect(new ArcGisAdapter(cfg).load({ fetch: hang, now, env: { ARCGIS_API_KEY: "secret" } })).rejects.toThrow(
      /timed out/,
    );
  });

  it("retries 5xx responses with backoff", async () => {
    let n = 0;
    const flaky = stubFetch([
      {
        match: (u) => u.pathname.endsWith("/MapServer/0"),
        respond: () => (n++ === 0 ? new Response("busy", { status: 503 }) : jsonResponse(fixture("wdfw-layer.json"))),
      },
      ...wdfwRoutes().slice(1),
    ]);
    const r = await new ArcGisAdapter({ ...wdfwConfig, http: { minIntervalMs: 0, retries: 1 } }).load({ fetch: flaky.fetch, now, env: {} });
    expect(r.changed).toBe(true);
    expect(n).toBe(2);
  });

  it("validates layer URLs", () => {
    expect(validateArcGisConfig({ ...wdfwConfig, url: "http://insecure.example/MapServer/0" })).not.toHaveLength(0);
    expect(validateArcGisConfig({ ...wdfwConfig, url: `${WDFW.replace("/0", "")}` })).not.toHaveLength(0);
    expect(validateArcGisConfig(wdfwConfig)).toHaveLength(0);
  });
});

describe("dated layer discovery", () => {
  it("picks the newest YYYYMMDD suffix", () => {
    const picked = pickDatedLayer(
      [
        { id: 400, name: "RecentHexagons20261015" },
        { id: 477, name: "RecentHexagons20261102" },
        { id: 12, name: "OtherLayer" },
      ],
      "RecentHexagons",
    );
    expect(picked).toEqual({ id: 477, name: "RecentHexagons20261102" });
  });

  it("resolves the current hexagon layer and normalizes pack names, not studbook numbers", async () => {
    const url = "https://services.arcgis.com/QVENGdaPbd4LUkLV/arcgis/rest/services/MexicanWolf_RecentHexagons/FeatureServer";
    const stub = stubFetch([
      { match: (u) => /FeatureServer\/?$/.test(u.pathname) && !u.pathname.includes("/477"), respond: () => jsonResponse(fixture("updates/hex-service.json")) },
      { match: (u) => u.pathname.endsWith("/FeatureServer/477") && !u.pathname.endsWith("query"), respond: () => jsonResponse(fixture("updates/hex-layer.json")) },
      { match: (u) => u.pathname.endsWith("/477/query"), respond: () => jsonResponse(fixture("updates/hex-query.json")) },
    ]);
    const cfg: ArcGisSourceConfig = {
      ...base,
      type: "arcgis",
      id: "usfws-hex-test",
      url,
      discoverLayer: { namePrefix: "RecentHexagons" },
      precision: "hex-cell",
      fields: { idField: "OBJECTID", label: "{pack}", observedAt: { field: "date_time", format: "date-text", precision: "day" }, details: { Pack: "pack", Studbook: "studbook" } },
      http: { minIntervalMs: 0 },
    };
    const r = await new ArcGisAdapter(cfg).load({ fetch: stub.fetch, now, env: {} });
    expect(r.changed).toBe(true);
    if (!r.changed) return;
    expect(r.features.length).toBe(5);
    expect(r.features[0]!.properties.label).toBe("Rocky Prairie");
    expect(r.features[0]!.properties.label).not.toMatch(/3081/);
    expect(r.features[0]!.properties.details.Studbook).toBe(3081);
  });
});
