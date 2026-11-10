import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geocode, looksLikeAddress, resetGeocodeThrottle } from "../src/api/geocode";
import { refreshSource, type Env } from "../src/cache";
import { handleRequest, isOverdue } from "../src/index";
import { LIMITS, resetLimits } from "../src/lib/ratelimit";
import { Registry } from "../src/registry";
import { fixture, jsonResponse, memoryKV, stubFetch } from "./helpers";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const ID = "cdfw-collared-wolf-cells";
const get = (env: Env, path: string, init?: RequestInit) => handleRequest(new Request(`https://app.example${path}`, init), env, ctx);

const PUBLIC_PATHS = [
  "/api/layers",
  "/api/status",
  "/api/changes",
  ...new Registry().ids().flatMap((id) => [`/api/sources/${id}`, `/api/sources/${id}.csv`, `/api/sources/${id}/changes`]),
  "/ogc",
  "/ogc/collections",
  `/ogc/collections/${ID}`,
  `/ogc/collections/${ID}/items?limit=10`,
];

beforeEach(() => resetLimits());
afterEach(() => vi.unstubAllGlobals());

describe("traffic spike safety", () => {
  it("never calls an agency server from a public request, even with an empty cache", async () => {
    const spy = vi.fn(async () => new Response("should not be called", { status: 599 }));
    vi.stubGlobal("fetch", spy);
    const env: Env = { LAYER_CACHE: memoryKV() };
    for (const p of PUBLIC_PATHS) {
      const res = await get(env, p);
      expect(res.status, p).toBeLessThan(500);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("serves a never-loaded source empty (or as the marked sample) instead of fetching", async () => {
    const env: Env = { LAYER_CACHE: memoryKV() };
    const other = new Registry().ids().find((id) => id !== ID)!;
    const fc = (await (await get(env, `/api/sources/${other}`)).json()) as { features: unknown[]; metadata: { state: string } };
    expect(fc.features).toHaveLength(0);
    expect(fc.metadata.state).toBe("never");
    const sample = (await (await get(env, `/api/sources/${ID}`)).json()) as { features: unknown[]; metadata: { state: string } };
    expect(sample.metadata.state).toBe("fixture");
    expect(sample.features.length).toBeGreaterThan(0);
  });

  it("sets an edge cache lifetime on public responses", async () => {
    const env: Env = { LAYER_CACHE: memoryKV() };
    for (const p of ["/api/layers", `/api/sources/${ID}`, `/api/sources/${ID}.kml`, "/ogc/collections"]) {
      expect((await get(env, p)).headers.get("cache-control"), p).toMatch(/public, max-age=\d+, s-maxage=\d+/);
    }
    expect((await get(env, "/api/health")).headers.get("cache-control")).toBe("no-store");
    for (const p of ["/api/status", "/api/updates"]) {
      expect((await get(env, p)).headers.get("cache-control"), p).toMatch(/max-age=30/);
      expect((await get(env, p)).headers.get("cache-control"), p).toMatch(/must-revalidate/);
    }
  });

  it("serves repeat requests from the edge cache and answers If-None-Match there", async () => {
    const store = new Map<string, Response>();
    const cache = {
      async match(r: Request) {
        return store.get(r.url)?.clone();
      },
      async put(r: Request, res: Response) {
        store.set(r.url, res);
      },
    };
    vi.stubGlobal("caches", { default: cache });
    const kv = memoryKV();
    const reads = vi.spyOn(kv, "get");
    const env: Env = { LAYER_CACHE: kv };
    const first = await get(env, "/api/layers");
    expect(first.headers.get("x-edge-cache")).toBe("MISS");
    await new Promise((r) => setTimeout(r, 0));
    const n = reads.mock.calls.length;
    const second = await get(env, "/api/layers?");
    expect(second.headers.get("x-edge-cache")).toBe("HIT");
    expect(reads.mock.calls.length).toBe(n);
    const etag = first.headers.get("etag")!;
    const cond = await get(env, "/api/layers", { headers: { "If-None-Match": etag } });
    expect(cond.status).toBe(304);
    const head = await get(env, "/api/layers", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("rate limits each client, with a tighter limit on exports", async () => {
    const env: Env = { LAYER_CACHE: memoryKV() };
    const ip = { headers: { "cf-connecting-ip": "203.0.113.9" } };
    let last = 0;
    for (let i = 0; i <= LIMITS.export.limit; i++) last = (await get(env, `/api/sources/${ID}.csv`, ip)).status;
    expect(last).toBe(429);
    // Another client is unaffected.
    expect((await get(env, `/api/sources/${ID}.csv`, { headers: { "cf-connecting-ip": "203.0.113.10" } })).status).toBe(200);
    const limited = await get(env, `/api/sources/${ID}.csv`, ip);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(((await limited.json()) as { status: number }).status).toBe(429);
  });
});

describe("address search", () => {
  it("only sends street addresses to the outside geocoder", async () => {
    expect(looksLikeAddress("123 Main St, Helena MT")).toBe(true);
    expect(looksLikeAddress("Bozeman")).toBe(false);
    expect(looksLikeAddress("59715")).toBe(false);
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const res = await get({ LAYER_CACHE: memoryKV() }, "/api/geocode?q=Bozeman");
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("parses Census Geocoder results and spaces out calls", async () => {
    resetGeocodeThrottle();
    const stub = stubFetch([
      {
        match: (u) => u.hostname === "geocoding.geo.census.gov",
        respond: () =>
          jsonResponse({ result: { addressMatches: [{ matchedAddress: "1 MAIN ST, HELENA, MT, 59601", coordinates: { x: -112.03, y: 46.59 } }] } }),
      },
    ]);
    const r = await geocode("1 Main St, Helena MT", { fetchImpl: stub.fetch, userAgent: "ua-test", referer: "https://app.example", now: () => 10_000 });
    expect(r).toEqual([{ name: "1 MAIN ST, HELENA, MT, 59601", lat: 46.59, lon: -112.03, bbox: null }]);
    const h = new Headers(stub.calls[0]!.init!.headers);
    expect(h.get("user-agent")).toBe("ua-test");
    expect(h.get("referer")).toBe("https://app.example");
    expect(await geocode("2 Main St, Helena MT", { fetchImpl: stub.fetch, now: () => 10_500 })).toBe("busy");
  });

  it("answers 502 when the Census service sends an error page", async () => {
    resetGeocodeThrottle();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>down</html>", { status: 200, headers: { "content-type": "text/html" } })));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await get({ LAYER_CACHE: memoryKV() }, "/api/geocode?q=" + encodeURIComponent("1 Main St, Helena MT"));
    expect(res.status).toBe(502);
  });
});

describe("status", () => {
  it("reports last success, failures in a row and feature count, and flags overdue sources", async () => {
    const env: Env = { LAYER_CACHE: memoryKV() };
    const adapter = new Registry().get(ID)!;
    const ok = stubFetch([{ match: () => true, respond: () => jsonResponse(fixture("cdfw-wolf-bins.json"), { "last-modified": "Sat, 31 Oct 2026 19:00:43 GMT" }) }]);
    await refreshSource(adapter, env, { fetchImpl: ok.fetch });
    (adapter.config as { http?: object }).http = { minIntervalMs: 0, retries: 0 };
    const down = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    await refreshSource(adapter, env, { fetchImpl: down, force: true });
    await refreshSource(adapter, env, { fetchImpl: down, force: true });
    delete (adapter.config as { http?: object }).http;
    const body = (await (await get(env, "/api/status")).json()) as {
      sources: { id: string; state: string; failures_in_a_row: number; feature_count: number; last_success_at: string; last_error: string }[];
    };
    const s = body.sources.find((x) => x.id === ID)!;
    expect(s.state).toBe("error");
    expect(s.failures_in_a_row).toBe(2);
    expect(s.feature_count).toBeGreaterThan(0);
    expect(s.last_success_at).toBeTruthy();
    expect(s.last_error).toMatch(/503/);
    expect(isOverdue(new Date(Date.now() - 4 * 3600_000).toISOString(), 60)).toBe(true);
    expect(isOverdue(new Date().toISOString(), 60)).toBe(false);
    expect(isOverdue(null, 60)).toBe(false);
  });
});

describe("geocode CORS and cache", () => {
  const path = "/api/geocode?q=" + encodeURIComponent("1 Main St, Helena MT");

  function stubCensus() {
    resetGeocodeThrottle();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            result: { addressMatches: [{ matchedAddress: "1 MAIN ST, HELENA, MT, 59601", coordinates: { x: -112.03, y: 46.59 } }] },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );
  }

  it("allows the map origin, blocks other sites, and caches lookups for a day", async () => {
    stubCensus();
    const env: Env = { LAYER_CACHE: memoryKV() };
    const allowed = await get(env, path, { headers: { Origin: "https://app.predatorwatch.org" } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.predatorwatch.org");
    expect(allowed.headers.get("vary")).toMatch(/Origin/);
    expect(allowed.headers.get("cache-control")).toMatch(/s-maxage=86400/);
    expect(allowed.headers.get("cache-control")).not.toMatch(/s-maxage=604800/);

    resetGeocodeThrottle();
    const blocked = await get(env, path, { headers: { Origin: "https://evil.example" } });
    expect(blocked.status).toBe(200);
    expect(blocked.headers.get("access-control-allow-origin")).toBeNull();

    resetGeocodeThrottle();
    const localOnProd = await get(env, path, { headers: { Origin: "http://localhost:8787" } });
    expect(localOnProd.headers.get("access-control-allow-origin")).toBeNull();

    resetGeocodeThrottle();
    const local = await handleRequest(
      new Request(`http://127.0.0.1:8787${path}`, { headers: { Origin: "http://localhost:8787" } }),
      env,
      ctx,
    );
    expect(local.headers.get("access-control-allow-origin")).toBe("http://localhost:8787");
  });
});

describe("rate limiter outages", () => {
  it("fails closed on geocode and exports, and fails open on catalog reads", async () => {
    const broken = { async limit() { throw new Error("limiter down"); } };
    const env: Env = {
      LAYER_CACHE: memoryKV(),
      API_LIMITER: broken,
      EXPORT_LIMITER: broken,
      SEARCH_LIMITER: broken,
      UPSTREAM_LIMITER: broken,
    };
    const q = "/api/geocode?q=" + encodeURIComponent("1 Main St, Helena MT");
    expect((await get(env, q)).status).toBe(429);
    expect((await get(env, `/api/sources/${ID}.csv`)).status).toBe(429);
    expect((await get(env, `/api/sources/${ID}.kml`)).status).toBe(429);
    expect((await get(env, "/api/layers")).status).toBe(200);
  });
});
