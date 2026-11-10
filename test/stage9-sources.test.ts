import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SOURCES } from "../src/config/sources";
import { LAYER_COLORS } from "../src/config/palette";
import { UPDATE_SOURCES } from "../src/config/updates";
import { handleRequest } from "../src/index";
import { memoryKV } from "./helpers";

describe("stage 9 sources and updates", () => {
  it("adds the new USFWS layers off by default and keeps only the original four wolf activity layers on", () => {
    const hex = SOURCES.find((s) => s.id === "usfws-mexican-wolf-recent-hexagons");
    const range2023 = SOURCES.find((s) => s.id === "usfws-mexican-wolf-occupied-range-2023");
    const range2020 = SOURCES.find((s) => s.id === "usfws-mexican-wolf-occupied-range-2020");
    expect(hex?.style.defaultVisible).toBeFalsy();
    expect(range2020?.style.defaultVisible).toBeFalsy();
    expect(range2023?.style.defaultVisible).toBe(true);
    expect("discoverLayer" in (hex ?? {}) && (hex as { discoverLayer?: { namePrefix: string } }).discoverLayer?.namePrefix).toBe("RecentHexagons");
    const on = SOURCES.filter((s) => s.style.defaultVisible).map((s) => s.id).sort();
    expect(on).toEqual([
      "cdfw-collared-wolf-cells",
      "mtfwp-wolf-distribution",
      "usfws-mexican-wolf-occupied-range-2023",
      "wdfw-wolf-packs-current",
    ]);
    expect(LAYER_COLORS["usfws-mexican-wolf-recent-hexagons"]).toBe("#c05850");
    expect(LAYER_COLORS["usfws-mexican-wolf-occupied-range-2023"]).toBe("#2870c0");
  });

  it("lists only official government update sources", () => {
    expect(UPDATE_SOURCES.length).toBeGreaterThanOrEqual(6);
    for (const s of UPDATE_SOURCES) {
      expect(s.url.startsWith("https://")).toBe(true);
      expect(s.agency.length).toBeGreaterThan(3);
      expect(s.refreshMinutes).toBeGreaterThanOrEqual(60);
    }
  });

  it("serves /api/updates and includes updates in /api/status", async () => {
    const env = { LAYER_CACHE: memoryKV() };
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const updates = await handleRequest(new Request("https://example.org/api/updates"), env, ctx);
    expect(updates.status).toBe(200);
    const body = await updates.json() as { items: { id?: string }[]; state: string; facts: { id: string; value: string }[] };
    expect(body.state).toBe("ok");
    expect(body.facts.some((f) => f.id === "cdfw-minimum-count" && f.value === "at least 55 wolves")).toBe(true);
    const status = await handleRequest(new Request("https://example.org/api/status"), env, ctx);
    const s = await status.json() as { updates?: { state: string; fact_count?: number } };
    expect(s.updates?.state).toBe("ok");
    expect((s.updates?.fact_count ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("ships the Updates fold and the official updates page", () => {
    const html = readFileSync("public/index.html", "utf8");
    expect(html).toMatch(/<details class="fold" id="sec-updates">/);
    const page = readFileSync("public/updates.html", "utf8");
    expect(page).toMatch(/Official updates/);
    expect(page).not.toContain("\u2014");
    expect(page).not.toMatch(/\bAI\b|artificial intelligence|intelligence and realtime systems/);
  });
});
