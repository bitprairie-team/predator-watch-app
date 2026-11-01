import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import inbound from "../schemas/integrations/pasturetrace/v1/inbound.schema.json";
import outbound from "../schemas/integrations/pasturetrace/v1/outbound.schema.json";
import type { PastureTraceInbound, PastureTraceOutbound } from "../src/private/types";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const vIn = ajv.compile(inbound);
const vOut = ajv.compile(outbound);

const goodIn: PastureTraceInbound = {
  tenant_id: "ranch-0001",
  animal_id: "tag-4471",
  event_type: "herd_scatter",
  timestamp: "2026-10-31T05:12:00-06:00",
  confidence: 0.82,
  source: "pasturetrace",
};
const goodOut: PastureTraceOutbound = {
  tenant_id: "ranch-0001",
  alert_level: "watch",
  species: "gray_wolf",
  window_start: "2026-10-28T00:00:00Z",
  window_end: "2026-10-31T00:00:00Z",
  reviewed: true,
};
const LOCATION_FIELDS = ["lat", "lon", "lng", "latitude", "longitude", "geometry", "coordinates", "location", "position", "wkt", "geojson", "bbox"];

/** The cross-field check receivers apply after schema validation. */
const windowOk = (m: PastureTraceOutbound) => Date.parse(m.window_end) >= Date.parse(m.window_start);

describe("PastureTrace v1 inbound schema", () => {
  it("accepts a valid event", () => {
    expect(vIn(goodIn), JSON.stringify(vIn.errors)).toBe(true);
  });
  it.each(LOCATION_FIELDS)("rejects a %s field", (k) => {
    expect(vIn({ ...goodIn, [k]: k === "geometry" ? { type: "Point", coordinates: [-110, 44] } : 44.1 })).toBe(false);
  });
  it("rejects unknown fields, a wrong source, bad confidence and bad times", () => {
    expect(vIn({ ...goodIn, note: "x" })).toBe(false);
    expect(vIn({ ...goodIn, source: "other" })).toBe(false);
    expect(vIn({ ...goodIn, confidence: 1.2 })).toBe(false);
    expect(vIn({ ...goodIn, confidence: -0.1 })).toBe(false);
    expect(vIn({ ...goodIn, timestamp: "yesterday" })).toBe(false);
    expect(vIn({ ...goodIn, event_type: "sighting_at_coordinates" })).toBe(false);
    expect(vIn({ ...goodIn, tenant_id: "../etc" })).toBe(false);
  });
  it("requires every field", () => {
    for (const k of Object.keys(goodIn)) {
      const m: Record<string, unknown> = { ...goodIn };
      delete m[k];
      expect(vIn(m), k).toBe(false);
    }
  });
});

describe("PastureTrace v1 outbound schema", () => {
  it("accepts a valid alert", () => {
    expect(vOut(goodOut), JSON.stringify(vOut.errors)).toBe(true);
    expect(windowOk(goodOut)).toBe(true);
  });
  it.each(LOCATION_FIELDS)("rejects a %s field", (k) => {
    expect(vOut({ ...goodOut, [k]: 1 })).toBe(false);
  });
  it("rejects unknown fields and bad values", () => {
    expect(vOut({ ...goodOut, pasture_name: "North" })).toBe(false);
    expect(vOut({ ...goodOut, alert_level: "critical" })).toBe(false);
    expect(vOut({ ...goodOut, reviewed: "yes" })).toBe(false);
    expect(vOut({ ...goodOut, window_start: "2026-13-01T00:00:00Z" })).toBe(false);
  });
  it("leaves the window order to the receiver check", () => {
    const backwards = { ...goodOut, window_start: goodOut.window_end, window_end: goodOut.window_start };
    expect(vOut(backwards)).toBe(true);
    expect(windowOk(backwards)).toBe(false);
  });
});

describe("public build isolation", () => {
  it("no public module imports src/private", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) { if (f !== "private") walk(p); }
        else if (/\.(ts|js|mjs)$/.test(f)) files.push(p);
      }
    };
    walk("src");
    walk("public");
    for (const f of files.filter((x) => !x.includes("/vendor/"))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/from\s+["'][^"']*private[^"']*["']|import\(["'][^"']*private/);
    }
  });
});
