import { describe, expect, it } from "vitest";
// @ts-expect-error plain browser module
import { fold, looksLikeAddress, parseLatLon, splitState } from "../public/search.js";

describe("browser place search", () => {
  it("splits a trailing state code or name", () => {
    expect(splitState("Bozeman, MT")).toEqual({ name: "bozeman", state: "MT" });
    expect(splitState("Gallatin County Montana")).toEqual({ name: "gallatin county", state: "MT" });
    expect(splitState("Bozeman")).toEqual({ name: "bozeman", state: null });
  });
  it("folds accents and punctuation", () => {
    expect(fold("Española, N.M.")).toBe("espanola n m");
  });
  it("reads coordinates in either order", () => {
    expect(parseLatLon("44.5, -110.5")).toMatchObject({ lat: 44.5, lon: -110.5 });
    expect(parseLatLon("-110.5 44.5")).toMatchObject({ lat: 44.5, lon: -110.5 });
    expect(parseLatLon("Bozeman")).toBeNull();
  });
  it("only treats house-number input as an address", () => {
    expect(looksLikeAddress("12 Elm St Helena MT")).toBe(true);
    expect(looksLikeAddress("59715")).toBe(false);
  });
});
