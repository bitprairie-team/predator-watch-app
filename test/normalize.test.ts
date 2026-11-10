import { describe, expect, it } from "vitest";
import { dateOnly, fieldsUsed, parseObserved, renderLabel, sanitizePublicFeature } from "../src/lib/normalize";
import type { NormalizedFeature } from "../src/schema";

describe("field mapping", () => {
  it("renders templates and falls back when all fields are empty", () => {
    expect(renderLabel({ label: "{Pack} pack" }, { Pack: "Wedge" }, "x")).toBe("Wedge pack");
    expect(renderLabel({ label: "{Pack} pack" }, { Pack: "" }, "fallback")).toBe("fallback");
    expect(renderLabel({ label: "Fixed label" }, {}, "fallback")).toBe("Fixed label");
  });

  it("lists only fields referenced by the mapping", () => {
    expect(
      fieldsUsed({
        idField: "PackID",
        label: "{Pack} pack",
        observedAt: { field: "Year", format: "year" },
        details: { Status: "PackStatus" },
      }).sort(),
    ).toEqual(["Pack", "PackID", "PackStatus", "Year"]);
    expect(fieldsUsed({ label: "Fixed label" })).toEqual([]);
  });

  it("parses agency time formats with their precision", () => {
    expect(parseObserved({ field: "d", format: "date-text" }, { d: "Oct 31, 2026" }, null)).toEqual({
      observed_at: "2026-10-31T00:00:00.000Z",
      observed_at_precision: "day",
    });
    expect(parseObserved({ field: "y", format: "year" }, { y: 2025 }, null)).toEqual({
      observed_at: "2025-01-01T00:00:00.000Z",
      observed_at_precision: "year",
    });
    expect(parseObserved({ field: "t", format: "epoch-ms" }, { t: 0 }, null).observed_at).toBe("1970-01-01T00:00:00.000Z");
    expect(parseObserved({ field: "t", format: "iso" }, { t: "2026-10-31T15:03:00-04:00" }, null).observed_at).toBe(
      "2026-10-31T19:03:00.000Z",
    );
    expect(parseObserved({ fromLayer: true }, {}, Date.UTC(2023, 9, 3))).toEqual({
      observed_at: "2023-10-03T00:00:00.000Z",
      observed_at_precision: "dataset",
    });
    expect(parseObserved({ field: "d", format: "date-text" }, { d: null }, null).observed_at).toBeNull();
  });

  it("parses month/day/year text as the calendar date, ignoring the time of day", () => {
    expect(parseObserved({ field: "d", format: "date-text", precision: "day" }, { d: "11/1/2026, 5:01 PM" }, null)).toEqual({
      observed_at: "2026-11-01T00:00:00.000Z",
      observed_at_precision: "day",
    });
    expect(parseObserved({ field: "d", format: "date-text", precision: "day" }, { d: "10/31/2026, 2:00 AM" }, null)).toEqual({
      observed_at: "2026-10-31T00:00:00.000Z",
      observed_at_precision: "day",
    });
    expect(dateOnly("2026-11-01T17:01:00.000Z")).toBe("2026-11-01T00:00:00.000Z");
  });

  it("drops studbook fields and truncates day-precision times on public output", () => {
    const f = {
      type: "Feature",
      id: "usfws-mexican-wolf-recent-hexagons:1",
      geometry: { type: "Polygon", coordinates: [] },
      properties: {
        id: "usfws-mexican-wolf-recent-hexagons:1",
        source_id: "usfws-mexican-wolf-recent-hexagons",
        source_name: "Recent Mexican wolf locations (generalized cells)",
        category: "wolf-activity",
        species: "Mexican wolf",
        agency: "U.S. Fish and Wildlife Service",
        label: "Rocky Prairie",
        observed_at: "2026-11-01T12:00:00.000Z",
        observed_at_precision: "day",
        received_at: "2026-11-02T00:00:00.000Z",
        precision: "hex-cell",
        geometry_type: "Polygon",
        attribution: "USFWS",
        url: "https://example.org",
        license: "public domain",
        details: { Pack: "Rocky Prairie", Studbook: 3081, "Animal ID": "M1234" },
      },
    } as unknown as NormalizedFeature;
    const out = sanitizePublicFeature(f);
    expect(out.properties.details).toEqual({ Pack: "Rocky Prairie" });
    expect(out.properties.observed_at).toBe("2026-11-01T00:00:00.000Z");
    expect(out.properties.label).toBe("Rocky Prairie");
  });
});
