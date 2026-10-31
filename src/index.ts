// Worker entry: JSON API for layers and sources, static assets for the map,
// and a Cron Trigger that refreshes sources into KV.
import { collection, publicStatus, readStatus, refreshDue, type Env } from "./cache";
import { RASTER_LAYERS } from "./config/sources";
import { publicInfo, Registry } from "./registry";
import { contextFromAccessKey, bearer } from "./agents/auth";
import { isOAuthPath, oauthProvider } from "./mcp/oauth";
import { handleMcp, MCP_ROUTE } from "./mcp/server";
import { handleAssistant } from "./rancher/routes";
import { rancherService, type PrivateEnv, type ServiceOverrides } from "./rancher/service";
import { demoOverrides, type DemoEnv } from "./rancher/demo";

/** Public map bindings plus the optional private rancher plan bindings. */
export type WorkerEnv = Env & PrivateEnv & DemoEnv;

const registry = new Registry();

/** One background warm-up per isolate at a time, however many requests arrive. */
let warming: Promise<void> | null = null;

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

export async function handleRequest(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
  overrides: ServiceOverrides = {},
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/assistant/") || url.pathname === MCP_ROUTE) {
    // Local demo account for `npm run dev:mock` (localhost only, mock model only, no PRIVATE_KV).
    const demo = Object.keys(overrides).length === 0 ? await demoOverrides(env, request) : null;
    if (demo) overrides = demo;
  }

  // Private rancher plan. Off unless PRIVATE_KV is bound (or a test injects a store).
  if (url.pathname.startsWith("/api/assistant/")) {
    return handleAssistant(request, url, rancherService(env, overrides));
  }
  if (url.pathname === MCP_ROUTE) {
    // Reached directly only when OAuth is not configured: accept rancher access keys.
    const svc = rancherService(env, overrides);
    if (!svc) return json({ error: "not configured", message: "The private rancher plan is not set up on this server." }, 503, 0);
    const key = bearer(request);
    const auth = key ? await contextFromAccessKey(svc.store, key, "mcp:access-key") : null;
    if (!auth) return json({ error: "unauthenticated", message: "Send a rancher access key as a Bearer token." }, 401, 0);
    return handleMcp(request, svc, auth);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: "method not allowed" }, 405, 0);
  }

  if (url.pathname === "/api/layers") {
    const body = await layersIndex(env);
    if (body.layers.some((l) => l.type === "geojson" && l.status.state === "never")) {
      // First run (for example a fresh `wrangler dev`): warm the cache in the background.
      warming ??= refreshDue(registry, env).then(
        () => undefined,
        () => undefined,
      ).finally(() => {
        warming = null;
      });
      ctx.waitUntil(warming);
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
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
    const url = new URL(request.url);
    // MCP OAuth is enabled only when both private namespaces are bound.
    if (env.OAUTH_KV && env.PRIVATE_KV && isOAuthPath(url.pathname)) {
      return oauthProvider(url.origin, (r, e, c) => handleRequest(r, e as WorkerEnv, c)).fetch(request, env, ctx);
    }
    return handleRequest(request, env, ctx);
  },
  async scheduled(_event: ScheduledController, env: WorkerEnv, ctx: ExecutionContext) {
    ctx.waitUntil(
      refreshDue(registry, env).then((r) => {
        console.log(JSON.stringify({ msg: "refresh complete", results: r }));
      }),
    );
  },
} satisfies ExportedHandler<WorkerEnv>;
