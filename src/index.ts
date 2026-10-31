// Worker entry: JSON API for layers and sources, static assets for the map,
// and a Cron Trigger that refreshes sources into KV.
import { collection, publicStatus, readStatus, refreshDue, type Env } from "./cache";
import { RASTER_LAYERS } from "./config/sources";
import { publicInfo, Registry } from "./registry";

const registry = new Registry();

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "x-content-type-options": "nosniff",
};

function json(body: unknown, status = 200, maxAge = 60): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, "cache-control": `public, max-age=${maxAge}` },
  });
}

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
  return {
    generated_at: new Date().toISOString(),
    layers: [...vector, ...raster],
    planned: [
      {
        id: "private-collaboration",
        name: "Private collaboration space",
        status: "Planned",
        description:
          "A paid, private space for ranchers, community members, and local, state, and federal agencies: data-sharing agreements, points of contact, schedules, and an audit log.",
      },
    ],
  };
}

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "method not allowed" }, 405, 0);
  }

  if (url.pathname === "/api/layers") {
    const body = await layersIndex(env);
    if (body.layers.some((l) => l.type === "geojson" && l.status.state === "never")) {
      // First run (for example a fresh `wrangler dev`): warm the cache in the background.
      ctx.waitUntil(refreshDue(registry, env).then(() => undefined, () => undefined));
    }
    return json(body, 200, 30);
  }

  const m = url.pathname.match(/^\/api\/sources\/([a-z0-9-]+)$/);
  if (m) {
    const id = m[1]!;
    if (!registry.get(id)) return json({ error: `unknown source: ${id}` }, 404, 0);
    const body = await collection(registry, env, id);
    return json(body, 200, 60);
  }

  if (url.pathname === "/api/health") return json({ ok: true, sources: registry.ids().length }, 200, 0);
  if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404, 0);

  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response("Not found", { status: 404 });
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
