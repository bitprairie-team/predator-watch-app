// Worker entry: JSON API, exports and OGC API Features for the public sources,
// static assets for the map, and a Cron Trigger that refreshes sources into KV.
// Public requests read KV through the edge cache and never call an agency;
// the cron is the only code path that contacts agency servers.
// Visitors are served from KV and from recorded official counts in the Worker.
import { EXPORT_TYPES, toCsv, toKml, type ExportFormat } from "./api/export";
import { GEOCODER_ATTRIBUTION, geocode, looksLikeAddress, normalizeQuery, withGeocodeCors } from "./api/geocode";
import { BadRequest, collectionInfo, CONFORMANCE, items, landing } from "./api/ogc";
import { json, problem, respond } from "./api/respond";
import { collection, PUBLIC_KV_TTL, publicStatus, readRunLog, readStatus, refreshDue, type Env } from "./cache";
import { readUpdates, refreshUpdates } from "./updates/refresh";
import { cached } from "./lib/edge";
import { assetLinks } from "./config/app";
import { allow, clientKey, type LimitClass } from "./lib/ratelimit";
import { BASEMAP_CREDITS, RASTER_LAYERS } from "./config/sources";
import { PLANNED, PLANNED_SOURCES } from "./config/planned";
import { LAYER_MARKS, LINE_DASH, SIMPLE_GROUPS, SIMPLE_LAYERS } from "./config/views";
import { publicInfo, Registry } from "./registry";

const registry = new Registry();

const ID = "[a-z0-9][a-z0-9-]{2,63}";
const SOURCE_RE = new RegExp(`^/api/sources/(${ID})(?:\\.(geojson|kml|csv))?$`);
const CHANGES_RE = new RegExp(`^/api/sources/(${ID})/changes$`);
const OGC_COLLECTION_RE = new RegExp(`^/ogc/collections/(${ID})(/items(?:/([^/]{1,200}))?)?$`);
const CRON_KEY = "cron:last";

/** A source is overdue when its last good check is older than three refresh intervals. */
export function isOverdue(checkedAt: string | null, refreshMinutes: number, now = Date.now()): boolean {
  if (!checkedAt) return false;
  return now - Date.parse(checkedAt) > 3 * refreshMinutes * 60_000 + 15 * 60_000;
}

export async function layersIndex(env: Env) {
  const vector = await Promise.all(
    registry.all().map(async (a) => {
      const status = publicStatus(await readStatus(env.LAYER_CACHE, a.config.id, PUBLIC_KV_TTL));
      return {
        ...publicInfo(a),
        type: "geojson" as const,
        data_url: `/api/sources/${a.config.id}`,
        status: { ...status, overdue: isOverdue(status.checked_at, a.config.refreshMinutes) },
      };
    }),
  );
  const raster = RASTER_LAYERS.map((r) => ({ ...r, type: "raster" as const, status: { state: "live-service" } }));
  // Same ids, colors and defaults in both views; Simple view adds plain names.
  const withViews = [...vector, ...raster].map((l) => {
    const id = l.id as keyof typeof LAYER_MARKS;
    const mark = LAYER_MARKS[id];
    return { ...l, mark: mark ? { ...mark, dash: LINE_DASH[mark.line] } : undefined, simple: SIMPLE_LAYERS[id] };
  });
  return {
    layers: withViews, simple_groups: SIMPLE_GROUPS,
    basemap: BASEMAP_CREDITS, planned: PLANNED, planned_sources: PLANNED_SOURCES,
  };
}

export async function statusReport(env: Env) {
  const now = Date.now();
  const sources = await Promise.all(
    registry.all().map(async (a) => {
      const s = await readStatus(env.LAYER_CACHE, a.config.id, PUBLIC_KV_TTL);
      return {
        id: a.config.id,
        name: a.config.name,
        agency: a.config.agency,
        state: s.state,
        last_success_at: s.last_success_at ?? s.checked_at,
        last_change_at: s.received_at,
        last_attempt_at: s.attempted_at ?? s.checked_at,
        failures_in_a_row: s.failures ?? 0,
        last_error_at: s.last_error_at ?? null,
        last_error: s.error ?? null,
        feature_count: s.feature_count,
        refresh_minutes: a.config.refreshMinutes,
        overdue: isOverdue(s.checked_at, a.config.refreshMinutes, now),
      };
    }),
  );
  const [cron, runs] = await Promise.all([
    env.LAYER_CACHE.get<{ at: string; results: Record<string, string> }>(CRON_KEY, { type: "json", cacheTtl: PUBLIC_KV_TTL }),
    readRunLog(env.LAYER_CACHE, PUBLIC_KV_TTL),
  ]);
  const healthy = sources.filter((s) => (s.state === "ok" || s.state === "unchanged") && !s.overdue).length;
  const updates = await readUpdates(env.LAYER_CACHE, PUBLIC_KV_TTL);
  return {
    generated_at: new Date(now).toISOString(),
    last_cron_run: runs[0]?.finished_at ?? cron?.at ?? null,
    healthy,
    total: sources.length,
    sources,
    runs,
    updates: {
      state: updates.state,
      checked_at: updates.checked_at,
      item_count: updates.items.length,
      fact_count: updates.facts.length,
      sources: updates.sources,
    },
  };
}

async function changesFor(env: Env, id: string) {
  const s = await readStatus(env.LAYER_CACHE, id, PUBLIC_KV_TTL);
  return { source_id: id, checked_at: s.checked_at, received_at: s.received_at, changes: s.changes ?? [] };
}

/** Which rate limit applies to a request. */
function limitClass(path: string, url: URL): LimitClass {
  if (path === "/api/geocode") return "search";
  if (/\.(geojson|kml|csv)$/.test(path)) return "export";
  if (path.startsWith("/ogc/") && url.searchParams.has("limit") && Number(url.searchParams.get("limit")) > 100) return "export";
  return "api";
}

/** Normalized edge cache key: path plus sorted query, never client headers. */
/** Bump when response shapes change, so the edge cache cannot serve old ones. */
const CACHE_VERSION = "6";

function cacheKey(url: URL, path: string): string {
  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const qs = new URLSearchParams(params).toString();
  // The version segment drops entries written by older builds after a deploy.
  return `${url.origin}/_edge/${CACHE_VERSION}${path}${qs ? `?${qs}` : ""}`;
}

/** Build the full response for a plain GET. Reads KV only. */
async function route(request: Request, env: Env, ctx: ExecutionContext, url: URL, path: string): Promise<Response> {
  const base = url.origin;
  if (path === "/api/layers") return json(request, await layersIndex(env), { maxAge: 30, sMaxAge: 60 });
  if (path === "/api/status") return json(request, await statusReport(env), { maxAge: 30, sMaxAge: 30 });
  if (path === "/api/updates") return json(request, await readUpdates(env.LAYER_CACHE, PUBLIC_KV_TTL), { maxAge: 30, sMaxAge: 60 });
  if (path === "/api/changes") {
    const all = await Promise.all(registry.ids().map((id) => changesFor(env, id)));
    return json(request, { sources: all }, { maxAge: 60, sMaxAge: 120 });
  }

  const ch = path.match(CHANGES_RE);
  if (ch) {
    if (!registry.get(ch[1]!)) return problem(request, 404, `unknown source: ${ch[1]}`);
    return json(request, await changesFor(env, ch[1]!), { maxAge: 60, sMaxAge: 120 });
  }

  const m = path.match(SOURCE_RE);
  if (m) {
    const id = m[1]!;
    const fmt = m[2] as ExportFormat | undefined;
    if (!registry.get(id)) return problem(request, 404, `unknown source: ${id}`);
    const fc = (await collection(registry, env, id))!;
    if (!fmt) return json(request, fc, { maxAge: 60, sMaxAge: 120 });
    const stamp = (fc.metadata.received_at ?? "").slice(0, 10) || "sample";
    const filename = `${id}-${stamp}.${fmt}`;
    const body = fmt === "geojson" ? JSON.stringify(fc) : fmt === "kml" ? toKml(fc) : toCsv(fc.features);
    return respond(request, body, { maxAge: 300, contentType: EXPORT_TYPES[fmt], filename });
  }

  if (path === "/api/geocode") {
    const q = normalizeQuery(url.searchParams.get("q"));
    if (!q) return problem(request, 400, "q must be 2 to 120 characters");
    if (!looksLikeAddress(q)) {
      return problem(request, 400, "only street addresses are looked up here; places, counties and ZIP codes are searched in the browser");
    }
    if (!(await allow(env, "upstream", "census-geocoder"))) {
      return problem(request, 429, "address search is busy; try again in a moment", { "retry-after": "2" });
    }
    let results: Awaited<ReturnType<typeof geocode>>;
    try {
      results = await geocode(q, { userAgent: env.USER_AGENT, referer: base });
    } catch (e) {
      console.error(JSON.stringify({ msg: "geocoder failed", error: e instanceof Error ? e.message : String(e) }));
      return problem(request, 502, "address search is not available right now");
    }
    if (results === "busy") return problem(request, 429, "address search is busy; try again in a moment", { "retry-after": "1" });
    return json(request, { query: q, results, attribution: GEOCODER_ATTRIBUTION }, { maxAge: 86400, sMaxAge: 86400 });
  }

  if (path === "/ogc") return json(request, landing(base), { maxAge: 3600 });
  if (path === "/ogc/conformance") return json(request, { conformsTo: CONFORMANCE }, { maxAge: 3600 });
  if (path === "/ogc/collections") {
    const collections = await Promise.all(
      registry.all().map(async (a) =>
        collectionInfo(base, {
          metadata: { ...publicStatus(await readStatus(env.LAYER_CACHE, a.config.id, PUBLIC_KV_TTL)), source: publicInfo(a) },
        }),
      ),
    );
    return json(request, { collections, links: [{ href: `${base}/ogc/collections`, rel: "self", type: "application/json" }] }, { maxAge: 300 });
  }
  const oc = path.match(OGC_COLLECTION_RE);
  if (oc) {
    const id = oc[1]!;
    if (!registry.get(id)) return problem(request, 404, `unknown collection: ${id}`);
    const fc = (await collection(registry, env, id))!;
    if (!oc[2]) return json(request, collectionInfo(base, fc), { maxAge: 300 });
    if (oc[3]) {
      const fid = decodeURIComponent(oc[3]);
      const f = fc.features.find((x) => x.id === fid);
      if (!f) return problem(request, 404, "feature not found");
      return json(request, f, { maxAge: 60, sMaxAge: 120, contentType: "application/geo+json" });
    }
    return json(request, items(base, fc, url.searchParams), { maxAge: 60, sMaxAge: 120, contentType: "application/geo+json" });
  }
  return problem(request, 404, "not found");
}

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  const res = await dispatch(request, env, ctx, url, path);
  return path === "/api/geocode" ? withGeocodeCors(request, res) : res;
}

async function dispatch(request: Request, env: Env, ctx: ExecutionContext, url: URL, path: string): Promise<Response> {
  const isApi = path.startsWith("/api/") || path === "/ogc" || path.startsWith("/ogc/");

  // Android app links for the Play Store app (Trusted Web Activity). Served
  // from code so the package id and fingerprint live in src/config/app.ts.
  if (path === "/.well-known/assetlinks.json" && (request.method === "GET" || request.method === "HEAD")) {
    return new Response(request.method === "HEAD" ? null : JSON.stringify(assetLinks(), null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=3600",
        "access-control-allow-origin": "*",
        "x-content-type-options": "nosniff",
      },
    });
  }

  if (!isApi) {
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-allow-headers": "If-None-Match",
        "access-control-max-age": "86400",
      },
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return problem(request, 405, "method not allowed", { allow: "GET, HEAD, OPTIONS" });
  }
  if (url.search.length > 512) return problem(request, 414, "query string too long");
  if (path === "/api/health") return json(request, { ok: true, sources: registry.ids().length }, { maxAge: 0 });

  const cls = limitClass(path, url);
  if (!(await allow(env, cls, clientKey(request)))) {
    return problem(request, 429, "too many requests; please slow down", { "retry-after": "60" });
  }

  let key = cacheKey(url, path);
  if (path === "/api/geocode") {
    const q = normalizeQuery(url.searchParams.get("q"));
    key = `${url.origin}/_edge/${CACHE_VERSION}/api/geocode?q=${encodeURIComponent((q ?? "").toLowerCase())}`;
  }
  try {
    return await cached(request, ctx, key, (plain) => route(plain, env, ctx, url, path));
  } catch (e) {
    if (e instanceof BadRequest) return problem(request, 400, e.message);
    if (e instanceof URIError) return problem(request, 400, "malformed URL");
    console.error(JSON.stringify({ msg: "request failed", path, error: e instanceof Error ? e.message : String(e) }));
    return problem(request, 500, "internal error");
  }
}

export default {
  fetch: handleRequest,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Run the updates feed beside the layer refresh so a slow or failed layer
    // pass cannot skip official counts and reports.
    ctx.waitUntil(
      (async () => {
        const [layers, feed] = await Promise.allSettled([refreshDue(registry, env), refreshUpdates(env)]);
        const results = layers.status === "fulfilled" ? layers.value : { error: layers.reason instanceof Error ? layers.reason.message : "error" };
        const updates =
          feed.status === "fulfilled"
            ? `${feed.value.state}:${feed.value.items.length}`
            : feed.reason instanceof Error
              ? feed.reason.message
              : "error";
        console.log(JSON.stringify({ msg: "refresh complete", results, updates }));
        await env.LAYER_CACHE.put(CRON_KEY, JSON.stringify({ at: new Date().toISOString(), results, updates }));
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
