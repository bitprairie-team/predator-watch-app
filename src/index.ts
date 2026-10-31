// Worker entry: JSON API, exports and OGC API Features for the public sources,
// static assets for the map, and a Cron Trigger that refreshes sources into KV.
import { EXPORT_TYPES, toCsv, toKml, type ExportFormat } from "./api/export";
import { geocode, normalizeQuery } from "./api/geocode";
import { BadRequest, collectionInfo, CONFORMANCE, items, landing } from "./api/ogc";
import { json, problem, respond } from "./api/respond";
import { collection, publicStatus, readStatus, refreshDue, type Env } from "./cache";
import { RASTER_LAYERS } from "./config/sources";
import { PLANNED } from "./config/planned";
import { publicInfo, Registry } from "./registry";

const registry = new Registry();

/** One background warm-up per isolate at a time, however many requests arrive. */
let warming: Promise<void> | null = null;

const ID = "[a-z0-9][a-z0-9-]{2,63}";
const SOURCE_RE = new RegExp(`^/api/sources/(${ID})(?:\\.(geojson|kml|csv))?$`);
const CHANGES_RE = new RegExp(`^/api/sources/(${ID})/changes$`);
const OGC_COLLECTION_RE = new RegExp(`^/ogc/collections/(${ID})(/items(?:/([^/]{1,200}))?)?$`);

export async function layersIndex(env: Env) {
  const vector = await Promise.all(
    registry.all().map(async (a) => {
      const status = publicStatus(await readStatus(env.LAYER_CACHE, a.config.id));
      return {
        ...publicInfo(a),
        type: "geojson" as const,
        data_url: `/api/sources/${a.config.id}`,
        status,
      };
    }),
  );
  const raster = RASTER_LAYERS.map((r) => ({ ...r, type: "raster" as const, status: { state: "live-service" } }));
  return { layers: [...vector, ...raster], planned: PLANNED };
}

function warm(env: Env, ctx: ExecutionContext) {
  warming ??= refreshDue(registry, env)
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      warming = null;
    });
  ctx.waitUntil(warming);
}

async function changesFor(env: Env, id: string) {
  const s = await readStatus(env.LAYER_CACHE, id);
  return { source_id: id, checked_at: s.checked_at, received_at: s.received_at, changes: s.changes ?? [] };
}

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  const isApi = path.startsWith("/api/") || path === "/ogc" || path.startsWith("/ogc/");

  if (isApi && request.method === "OPTIONS") {
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
  const base = url.origin;

  try {
    if (path === "/api/layers") {
      const body = await layersIndex(env);
      if (body.layers.some((l) => l.type === "geojson" && l.status.state === "never")) warm(env, ctx);
      return json(request, body, { maxAge: 30 });
    }

    if (path === "/api/changes") {
      const all = await Promise.all(registry.ids().map((id) => changesFor(env, id)));
      return json(request, { sources: all }, { maxAge: 60 });
    }

    const ch = path.match(CHANGES_RE);
    if (ch) {
      if (!registry.get(ch[1]!)) return problem(request, 404, `unknown source: ${ch[1]}`);
      return json(request, await changesFor(env, ch[1]!), { maxAge: 60 });
    }

    const m = path.match(SOURCE_RE);
    if (m) {
      const id = m[1]!;
      const fmt = m[2] as ExportFormat | undefined;
      if (!registry.get(id)) return problem(request, 404, `unknown source: ${id}`);
      const fc = (await collection(registry, env, id))!;
      if (!fmt) return json(request, fc, { maxAge: 60 });
      const stamp = (fc.metadata.received_at ?? "").slice(0, 10) || "sample";
      const filename = `${id}-${stamp}.${fmt}`;
      const body = fmt === "geojson" ? JSON.stringify(fc) : fmt === "kml" ? toKml(fc) : toCsv(fc.features);
      return respond(request, body, { maxAge: 300, contentType: EXPORT_TYPES[fmt], filename });
    }

    if (path === "/api/geocode") {
      const q = normalizeQuery(url.searchParams.get("q"));
      if (!q) return problem(request, 400, "q must be 2 to 120 characters");
      const cacheKey = new Request(`${base}/api/geocode?q=${encodeURIComponent(q.toLowerCase())}`);
      const cache = typeof caches !== "undefined" ? (caches as unknown as { default?: Cache }).default : undefined;
      const hit = await cache?.match(cacheKey);
      if (hit) return hit;
      const results = await geocode(q, { userAgent: env.USER_AGENT });
      if (results === "busy") return problem(request, 429, "search is busy; try again in a moment", { "retry-after": "1" });
      const res = json(request, { query: q, results, attribution: "Search © OpenStreetMap contributors (Nominatim)" }, { maxAge: 86400 });
      if (cache && request.method === "GET") ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }

    if (path === "/api/health") return json(request, { ok: true, sources: registry.ids().length }, { maxAge: 0 });

    if (path === "/ogc") return json(request, landing(base), { maxAge: 3600 });
    if (path === "/ogc/conformance") return json(request, { conformsTo: CONFORMANCE }, { maxAge: 3600 });
    if (path === "/ogc/collections") {
      const collections = registry.all().map((a) =>
        collectionInfo(base, { metadata: { ...publicStatus({ ...emptyish(a.config.id) }), source: publicInfo(a) } }),
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
        return json(request, f, { maxAge: 60, contentType: "application/geo+json" });
      }
      return json(request, items(base, fc, url.searchParams), { maxAge: 60, contentType: "application/geo+json" });
    }

    if (isApi) return problem(request, 404, "not found");
  } catch (e) {
    if (e instanceof BadRequest) return problem(request, 400, e.message);
    if (e instanceof URIError) return problem(request, 400, "malformed URL");
    console.error(JSON.stringify({ msg: "request failed", path, error: e instanceof Error ? e.message : String(e) }));
    return problem(request, 500, "internal error");
  }

  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response("Not found", { status: 404 });
}

function emptyish(id: string) {
  return {
    source_id: id,
    state: "never" as const,
    checked_at: null,
    received_at: null,
    source_updated_at: null,
    source_updated_ms: null,
    feature_count: 0,
    validator: null,
  };
}

export default {
  fetch: handleRequest,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      refreshDue(registry, env).then((r) => {
        console.log(JSON.stringify({ msg: "refresh complete", results: r }));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
