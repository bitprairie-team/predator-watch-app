import { describe, expect, it } from "vitest";
import { fieldsUsed, parseObserved, renderLabel } from "../src/lib/normalize";

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
});
