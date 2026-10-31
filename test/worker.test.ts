import { beforeEach, describe, expect, it } from "vitest";
import { configHash, refreshSource, type Env } from "../src/cache";
import { handleRequest } from "../src/index";
import { resetRateLimiter } from "../src/lib/http";
import { Registry } from "../src/registry";
import { fixture, jsonResponse, memoryKV, stubFetch } from "./helpers";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const LM = "Sat, 31 Oct 2026 19:00:43 GMT";
const cdfw = () => new Registry().get("cdfw-collared-wolf-cells")!;

beforeEach(() => resetRateLimiter());

describe("refreshSource", () => {
  it("stores normalized GeoJSON and status in KV, then reports unchanged", async () => {
    const env: Env = { LAYER_CACHE: memoryKV() };
    const stub = stubFetch([
      {
        match: () => true,
        respond: (_u, init) =>
          new Headers(init?.headers).get("If-Modified-Since") === LM
            ? new Response(null, { status: 304 })
            : jsonResponse(fixture("cdfw-wolf-bins.json"), { "last-modified": LM }),
      },
    ]);
    let t = Date.parse("2026-10-31T19:30:00Z");
    const now = () => new Date(t);
    const s1 = await refreshSource(cdfw(), env, { fetchImpl: stub.fetch, now });
    expect(s1.state).toBe("ok");
    expect(s1.feature_count).toBeGreaterThan(0);
    expect(s1.source_updated_at).toBe(new Date(LM).toISOString());
    expect(s1.config_hash).toBe(configHash(cdfw().config));

    // Not due yet: no request made.
    const before = stub.calls.length;
    await refreshSource(cdfw(), env, { fetchImpl: stub.fetch, now });
    expect(stub.calls.length).toBe(before);

    t += 61 * 60_000;
    const s2 = await refreshSource(cdfw(), env, { fetchImpl: stub.fetch, now });
    expect(s2.state).toBe("unchanged");
    expect(s2.received_at).toBe(s1.received_at);
    expect(s2.checked_at).not.toBe(s1.checked_at);
  });

  it("serves bundled sample data, clearly marked, when the network fails on first load", async () => {
    const env: Env = { LAYER_CACHE: memoryKV() };
    const down = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    const adapter = cdfw();
    (adapter.config as { http?: object }).http = { minIntervalMs: 0, retries: 0 };
    const s = await refreshSource(adapter, env, { fetchImpl: down });
    expect(s.state).toBe("fixture");
    expect(s.feature_count).toBeGreaterThan(0);
    expect(s.error).toMatch(/network error/);
    delete (adapter.config as { http?: object }).http;
  });
});

describe("HTTP API", () => {
  it("GET /api/layers lists vector and raster layers with status, plus Planned items", async () => {
    const env: Env = { LAYER_CACHE: memoryKV() };
    const res = await handleRequest(new Request("http://x/api/layers"), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { layers: { id: string; type: string; status: { state: string } }[]; planned: { status: string }[] };
    expect(body.layers.find((l) => l.id === "cdfw-collared-wolf-cells")?.status.state).toBe("never");
    expect(body.layers.some((l) => l.type === "raster")).toBe(true);
    expect(body.planned[0]?.status).toBe("Planned");
  });

  it("GET /api/sources/:id serves cached GeoJSON with source metadata", async () => {
    const kv = memoryKV();
    const env: Env = { LAYER_CACHE: kv };
    const stub = stubFetch([{ match: () => true, respond: () => jsonResponse(fixture("cdfw-wolf-bins.json"), { "last-modified": LM }) }]);
    await refreshSource(cdfw(), env, { fetchImpl: stub.fetch });
    const res = await handleRequest(new Request("http://x/api/sources/cdfw-collared-wolf-cells"), env, ctx);
    expect(res.status).toBe(200);
    const fc = (await res.json()) as {
      type: string;
      features: { properties: { source_id: string; observed_at: string; received_at: string } }[];
      metadata: { state: string; source: { attribution: string; license: string } };
    };
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.metadata.state).toBe("ok");
    expect(fc.metadata.source.attribution).toMatch(/CDFW/);
    for (const f of fc.features) {
      expect(f.properties.source_id).toBe("cdfw-collared-wolf-cells");
      expect(f.properties.received_at).toBeTruthy();
    }
    expect(JSON.stringify(fc)).not.toMatch(/validator|config_hash|source_updated_ms/);
  });

  it("returns 404 for unknown sources and 405 for writes", async () => {
    const env: Env = { LAYER_CACHE: memoryKV() };
    expect((await handleRequest(new Request("http://x/api/sources/nope-nope"), env, ctx)).status).toBe(404);
    expect((await handleRequest(new Request("http://x/api/layers", { method: "POST" }), env, ctx)).status).toBe(405);
  });
});
