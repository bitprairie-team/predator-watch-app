import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/cache";
import { SOURCES } from "../src/config/sources";
import { handleRequest } from "../src/index";
import { parseObserved } from "../src/lib/normalize";
import { allow } from "../src/lib/ratelimit";
import { memoryKV } from "./helpers";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const broken = { limit: async () => { throw new Error("limiter down"); } } as unknown as RateLimit;

describe("security hardening (2026-11-10)", () => {
  it("fails closed for search, upstream and exports when the limiter errors, open for catalog reads", async () => {
    const env = { API_LIMITER: broken, EXPORT_LIMITER: broken, SEARCH_LIMITER: broken, UPSTREAM_LIMITER: broken };
    expect(await allow(env, "api", "k")).toBe(true);
    expect(await allow(env, "search", "k")).toBe(false);
    expect(await allow(env, "upstream", "k")).toBe(false);
    expect(await allow(env, "export", "k")).toBe(false);
  });

  it("returns 429 for geocode and exports when the limiter is down", async () => {
    const env = { LAYER_CACHE: memoryKV(), SEARCH_LIMITER: broken, EXPORT_LIMITER: broken } as unknown as Env;
    const geo = await handleRequest(new Request("https://app.predatorwatch.org/api/geocode?q=123+Main+St+Helena+MT"), env, ctx);
    expect(geo.status).toBe(429);
    const exp = await handleRequest(new Request("https://app.predatorwatch.org/api/sources/cdfw-collared-wolf-cells.csv"), env, ctx);
    expect(exp.status).toBe(429);
  });

  it("limits address search CORS to the app origin and keeps open data CORS open", async () => {
    const env = { LAYER_CACHE: memoryKV() } as unknown as Env;
    const geo = await handleRequest(new Request("https://app.predatorwatch.org/api/geocode?q=a"), env, ctx);
    expect(geo.status).toBe(400);
    expect(geo.headers.get("access-control-allow-origin")).toBe("https://app.predatorwatch.org");
    const pre = await handleRequest(new Request("https://app.predatorwatch.org/api/geocode", { method: "OPTIONS" }), env, ctx);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://app.predatorwatch.org");
    const app = await handleRequest(new Request("https://app.predatorwatch.org/api/geocode?q=a", { headers: { Origin: "capacitor://localhost" } }), env, ctx);
    expect(app.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");
    const other = await handleRequest(new Request("https://app.predatorwatch.org/api/geocode?q=a", { headers: { Origin: "https://evil.example" } }), env, ctx);
    expect(other.headers.get("access-control-allow-origin")).toBe("https://app.predatorwatch.org");
    expect(other.headers.get("vary")).toMatch(/Origin/);
    const layersPre = await handleRequest(new Request("https://app.predatorwatch.org/api/layers", { method: "OPTIONS" }), env, ctx);
    expect(layersPre.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("does not publish studbook numbers for Mexican wolf cells", () => {
    const src = SOURCES.find((s) => s.id === "usfws-mexican-wolf-recent-hexagons")!;
    const fields = (src as { fields: { details?: Record<string, string> } }).fields;
    expect(Object.values(fields.details ?? {}).map((v) => v.toLowerCase())).not.toContain("studbook");
  });

  it("cuts day-precision times to the date", () => {
    expect(parseObserved({ field: "d", format: "date-text", precision: "day" }, { d: "2026-10-31T14:00:00Z" }, null)).toEqual({
      observed_at: "2026-10-31T00:00:00.000Z",
      observed_at_precision: "day",
    });
    expect(parseObserved({ field: "t", format: "epoch-ms", precision: "day" }, { t: Date.UTC(2026, 9, 31, 17, 5) }, null).observed_at).toBe(
      "2026-10-31T00:00:00.000Z",
    );
  });

  it("pins workers.dev and preview URLs off and redacts query strings in logs", () => {
    const raw = readFileSync(join(__dirname, "..", "wrangler.jsonc"), "utf8");
    expect(raw).toMatch(/"workers_dev":\s*false/);
    expect(raw).toMatch(/"preview_urls":\s*false/);
    expect(raw).toMatch(/"redact_query_string":\s*true/);
  });
});
