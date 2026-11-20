import { beforeEach, describe, expect, it } from "vitest";
import { ArcGisJoinAdapter, districtKey, type ArcGisJoinSourceConfig } from "../src/adapters/arcgis-join";
import { PLANNED_SOURCES } from "../src/config/planned";
import { SOURCES } from "../src/config/sources";
import { SIMPLE_GROUPS, SIMPLE_LAYERS } from "../src/config/views";
import { resetRateLimiter } from "../src/lib/http";
import { refreshSource } from "../src/cache";
import { Registry } from "../src/registry";
import { jsonResponse, memoryKV, stubFetch } from "./helpers";

const TABLE = "https://example.test/harvest/FeatureServer/0";
const GEOM = "https://example.test/districts/MapServer/11";
const EDITED = 1700000000000;

const cfg: ArcGisJoinSourceConfig = {
  type: "arcgis-join",
  id: "mt-harvest-test",
  name: "Wolf harvest by deer and elk hunting district",
  category: "wolf-management",
  species: "Gray wolf",
  agency: "Montana Fish, Wildlife & Parks",
  tableUrl: TABLE,
  geometryUrl: GEOM,
  join: {
    tableKey: "Deer___Elk_Hunting_District",
    geometryKey: "DISTRICT",
    tableFields: ["Wolf_Harvest"],
    boundaryFields: ["REG", "REGYEAR", "AREA_AC", "OBJECTID", "MAPLINK"],
    countField: "Wolf_Harvest",
    maxCount: 5000,
  },
  infoUrl: "https://example.test/item",
  license: "Public",
  attribution: "Montana Fish, Wildlife & Parks (FWP)",
  cadence: "About once a day.",
  refreshMinutes: 24 * 60,
  precision: "management-unit",
  fields: {
    idField: "DISTRICT",
    label: "Hunting district {DISTRICT}",
    observedAt: { fromLayer: true },
    details: {
      "Wolf harvest": "Wolf_Harvest",
      Region: "REG",
      "Regulations year": "REGYEAR",
      "District map": "MAPLINK",
    },
  },
  maxAllowableOffset: 0.002,
  geometryPrecision: 5,
  http: { minIntervalMs: 0 },
  style: { color: "#a06a7c", fillOpacity: 0.18, dashed: true },
};

const square = (x: number, y: number) => ({
  rings: [[[x, y], [x, y + 1], [x + 1, y + 1], [x + 1, y], [x, y]]],
});

const tableMeta = {
  objectIdField: "ObjectId",
  maxRecordCount: 1,
  advancedQueryCapabilities: { supportsPagination: true },
  editingInfo: { lastEditDate: EDITED, dataLastEditDate: EDITED },
};

const geometryMeta = {
  objectIdField: "OBJECTID",
  maxRecordCount: 1000,
  advancedQueryCapabilities: { supportsPagination: true },
};

function row(id: number, district: number, harvest: number) {
  return { attributes: { ObjectId: id, Deer___Elk_Hunting_District: district, Wolf_Harvest: harvest } };
}

function boundary(id: number, district: string, extras: Record<string, unknown> = {}) {
  return {
    attributes: {
      OBJECTID: id,
      DISTRICT: district,
      REG: "1",
      REGYEAR: "2026",
      AREA_AC: 10 + id,
      MAPLINK: `https://example.test/hd${district}.pdf`,
      ...extras,
    },
    geometry: square(-112, 45 + id),
  };
}

/** Table pages one row at a time. Boundaries answer with an extra district the table does not mention. */
function routes(opts?: {
  attributes?: ReturnType<typeof boundary>[];
  shapes?: { attributes: Record<string, unknown>; geometry?: { rings: number[][][] } }[];
}) {
  const attributes = opts?.attributes ?? [boundary(9, "100"), boundary(10, "101"), boundary(11, "200")];
  const shapes = opts?.shapes ?? attributes;
  return [
    { match: (u: URL) => u.pathname.endsWith("/FeatureServer/0") && !u.pathname.endsWith("/query"), respond: () => jsonResponse(tableMeta) },
    { match: (u: URL) => u.pathname.endsWith("/MapServer/11") && !u.pathname.endsWith("/query"), respond: () => jsonResponse(geometryMeta) },
    {
      match: (u: URL) => u.pathname.endsWith("/FeatureServer/0/query") && u.searchParams.get("resultOffset") === "0",
      respond: () => jsonResponse({ features: [row(1, 100, 5)], exceededTransferLimit: true }),
    },
    {
      match: (u: URL) => u.pathname.endsWith("/FeatureServer/0/query") && u.searchParams.get("resultOffset") === "1",
      respond: () => jsonResponse({ features: [row(2, 101, 0)], exceededTransferLimit: false }),
    },
    {
      match: (u: URL) => u.pathname.includes("/MapServer/11/query") && u.searchParams.get("returnGeometry") === "false",
      respond: () => jsonResponse({ features: attributes.map(({ attributes: a }) => ({ attributes: a })), exceededTransferLimit: false }),
    },
    {
      match: (u: URL) => u.pathname.includes("/MapServer/11/query") && u.searchParams.get("returnGeometry") === "true",
      respond: () => jsonResponse({ features: shapes, exceededTransferLimit: false }),
    },
  ];
}

const now = () => new Date("2026-11-15T18:00:00Z");

beforeEach(() => resetRateLimiter());

describe("district keys", () => {
  it("matches a table integer to the boundary's text id, and rejects anything else", () => {
    expect(districtKey(100)).toBe("100");
    expect(districtKey("100")).toBe("100");
    expect(districtKey(" 0101 ")).toBe("101");
    expect(districtKey(0)).toBeNull();
    expect(districtKey("HD100")).toBeNull();
    expect(districtKey(1.5)).toBeNull();
    expect(districtKey(null)).toBeNull();
  });
});

describe("ArcGisJoinAdapter", () => {
  it("draws only table rows, keeps a published zero, and does not invent a district", async () => {
    const stub = stubFetch(routes());
    const result = await new ArcGisJoinAdapter(cfg).load({ fetch: stub.fetch, now, env: {} });
    expect(result.changed).toBe(true);
    if (!result.changed) return;
    expect(result.features.map((f) => f.properties.label)).toEqual(["Hunting district 100", "Hunting district 101"]);
    expect(result.features.map((f) => f.id)).toEqual(["mt-harvest-test:100", "mt-harvest-test:101"]);
    expect(result.features[0]!.properties.details).toMatchObject({
      "Wolf harvest": 5,
      Region: "1",
      "Regulations year": "2026",
      "District map": "https://example.test/hd100.pdf",
    });
    expect(result.features[1]!.properties.details["Wolf harvest"]).toBe(0);
    expect(result.features[0]!.geometry?.type).toBe("Polygon");
    expect(result.features[0]!.properties).toMatchObject({
      precision: "management-unit",
      observed_at: new Date(EDITED).toISOString(),
      observed_at_precision: "dataset",
      species: "Gray wolf",
    });
    expect(result.features.some((f) => f.id.endsWith(":200"))).toBe(false);

    const tablePages = stub.calls.filter((c) => c.url.pathname.endsWith("/FeatureServer/0/query"));
    expect(tablePages.map((c) => c.url.searchParams.get("resultOffset"))).toEqual(["0", "1"]);
    expect(tablePages[0]!.url.searchParams.get("outFields")).not.toContain("REG");
    const shape = stub.calls.find((c) => c.url.searchParams.get("returnGeometry") === "true")!;
    expect(shape.url.searchParams.get("where")).toBe("DISTRICT IN ('100','101')");
    expect(shape.url.searchParams.get("outSR")).toBe("4326");
    expect(shape.url.searchParams.get("maxAllowableOffset")).toBe("0.002");
    expect(shape.url.searchParams.get("geometryPrecision")).toBe("5");
  });

  it("skips the geometry download when the table edit date and the boundary hash are unchanged", async () => {
    const first = stubFetch(routes());
    const loaded = await new ArcGisJoinAdapter(cfg).load({ fetch: first.fetch, now, env: {} });
    expect(loaded.changed).toBe(true);
    if (!loaded.changed) return;
    const second = stubFetch(routes());
    const again = await new ArcGisJoinAdapter(cfg).load({
      fetch: second.fetch,
      now,
      env: {},
      previous: { sourceUpdatedMs: loaded.sourceUpdatedMs, validator: loaded.validator, hasData: true },
    });
    expect(again.changed).toBe(false);
    expect(second.calls.some((c) => c.url.searchParams.get("returnGeometry") === "true")).toBe(false);
    expect(second.calls.some((c) => c.url.pathname.includes("/MapServer/11/query"))).toBe(true);

    const moved = stubFetch(routes());
    const refetched = await new ArcGisJoinAdapter(cfg).load({
      fetch: moved.fetch,
      now,
      env: {},
      previous: { sourceUpdatedMs: loaded.sourceUpdatedMs, validator: "deadbeef", hasData: true },
    });
    expect(refetched.changed).toBe(true);
    expect(moved.calls.some((c) => c.url.searchParams.get("returnGeometry") === "true")).toBe(true);
  });

  it("rejects a harvest row with no polygon, and does not retry that answer", async () => {
    const stub = stubFetch(routes({ attributes: [boundary(9, "100")], shapes: [boundary(9, "100")] }));
    await expect(new ArcGisJoinAdapter(cfg).load({ fetch: stub.fetch, now, env: {} })).rejects.toThrow(
      /No hunting-district polygon for district 101/,
    );
    const calls = stub.calls.filter((c) => c.url.pathname.includes("/query")).length;

    const once = stubFetch(routes({ attributes: [boundary(9, "100")], shapes: [boundary(9, "100")] }));
    const status = await refreshSource(new ArcGisJoinAdapter(cfg), { LAYER_CACHE: memoryKV() }, {
      fetchImpl: once.fetch,
      now,
      force: true,
      attempts: 2,
      retryDelayMs: 1,
    });
    expect(status.state).toBe("error");
    expect(status.error).toMatch(/district 101/);
    expect(once.calls.filter((c) => c.url.pathname.includes("/query"))).toHaveLength(calls);
  });

  it("rejects two polygons for one district, and a count that is not a whole number", async () => {
    const dup = stubFetch(routes({ attributes: [boundary(9, "100"), boundary(12, "100"), boundary(10, "101")] }));
    await expect(new ArcGisJoinAdapter(cfg).load({ fetch: dup.fetch, now, env: {} })).rejects.toThrow(/More than one polygon for district 100/);

    const pages = routes();
    const stub = stubFetch([
      ...pages.slice(0, 3),
      {
        match: (u: URL) => u.pathname.endsWith("/FeatureServer/0/query") && u.searchParams.get("resultOffset") === "1",
        respond: () => jsonResponse({ features: [{ attributes: { ObjectId: 2, Deer___Elk_Hunting_District: 101, Wolf_Harvest: -1 } }], exceededTransferLimit: false }),
      },
    ]);
    await expect(new ArcGisJoinAdapter(cfg).load({ fetch: stub.fetch, now, env: {} })).rejects.toThrow(/no usable Wolf_Harvest/);
  });

  it("rejects a matched district whose geometry is missing", async () => {
    const shapes = [boundary(9, "100"), boundary(10, "101")].map((f, i) => (i === 1 ? { attributes: f.attributes } : f));
    const stub = stubFetch(routes({ shapes }));
    await expect(new ArcGisJoinAdapter(cfg).load({ fetch: stub.fetch, now, env: {} })).rejects.toThrow(/District 101 has no usable polygon/);
  });
});

describe("Montana wolf harvest source", () => {
  it("is a management layer, off by default, and no longer listed as planned", () => {
    const source = SOURCES.find((s) => s.id === "mtfwp-wolf-harvest-by-district");
    expect(source?.type).toBe("arcgis-join");
    expect(source?.category).toBe("wolf-management");
    expect(source?.style.defaultVisible).toBeFalsy();
    expect(source?.notes).toMatch(/not a count of wolves living there/);
    const adapter = new Registry().get("mtfwp-wolf-harvest-by-district");
    expect(adapter?.endpoint).toMatch(/\/FeatureServer\/0$/);
    expect(SIMPLE_GROUPS.flatMap((g) => g.layers)).not.toContain("mtfwp-wolf-harvest-by-district");
    expect(SIMPLE_LAYERS["mtfwp-wolf-harvest-by-district"]?.popup).toMatch(/not a count of wolves living here/);
    expect(PLANNED_SOURCES.some((p) => /Wolf harvest by deer/i.test(p.name))).toBe(false);
  });
});
