// Wires the background agents into the rancher service: settings from the
// tenant record, the cron scheduler, and the HTTP routes.
//
//   GET  /api/assistant/agents                  agents, their settings, and pause state
//   GET  /api/assistant/agents/runs             recent runs (newest first)
//   POST /api/assistant/agents/:id/run          run now (agents:run scope)
//   POST /api/assistant/agents/:id/pause        pause your own agent (agents:run scope)
//   POST /api/assistant/agents/:id/resume
//   GET  /api/assistant/outbox                  items waiting for approval
//   POST /api/assistant/outbox/:id/approve      body {"confirm": true}; outbox:approve scope, web only
//   POST /api/assistant/outbox/:id/reject
import { sourcesFooter } from "../agents/citations";
import { decideOutbox, lastRunKey, listOutbox, listRuns, runAgent, type AgentDefinition, type AgentRunRecord, type BackgroundDeps, type Sender } from "../agents/background";
import { AgentError, type AuthContext } from "../agents/types";
import { RANCHER_AGENTS, type AgentProfile } from "./background-agents";
import { tenantKey } from "./data";
import type { TenantRecord } from "./model";
import type { RancherDeps } from "./tools";
import type { RancherService } from "./service";

/** Tenant-wide cost units per day across all agents. */
export const AGENT_COST_UNITS_PER_DAY = 400;

export function agentDeps(svc: RancherService): BackgroundDeps<RancherDeps, AgentProfile> {
  const tenant = (ctx: AuthContext) => svc.deps.data(ctx).data.tenant();
  return {
    store: svc.store,
    registry: svc.registry,
    exec: svc.deps,
    audit: svc.audit,
    rateLimiter: svc.rateLimiter,
    env: svc.env,
    now: svc.now,
    costUnitsPerDay: AGENT_COST_UNITS_PER_DAY,
    entitled: (ctx) => svc.entitlements.has(ctx, "rancher_assistant"),
    async settings(ctx, id) {
      const s = (await tenant(ctx))?.agents?.[id];
      if (!s) return null;
      const { enabled, ...config } = s;
      return { enabled: enabled === true, config };
    },
    async profile(ctx) {
      const t = await tenant(ctx);
      return {
        tenantName: t?.name ?? ctx.tenantId,
        ranches: (t?.ranches ?? []).map((r) => ({ id: r.id, name: r.name, allotments: r.allotments.map((a) => ({ id: a.id, name: a.name })) })),
      };
    },
  };
}

const find = (id: string) => RANCHER_AGENTS.find((a) => a.id === id);

/** Cron entry: run every enabled, due agent for every tenant. Returns what ran. */
export async function runScheduledAgents(svc: RancherService, agents: AgentDefinition<AgentProfile>[] = RANCHER_AGENTS, maxTenants = 500): Promise<AgentRunRecord[]> {
  const deps = agentDeps(svc);
  const now = svc.now();
  const out: AgentRunRecord[] = [];
  for (const key of await svc.store.list("tenant:", maxTenants)) {
    const t = await svc.store.get<TenantRecord>(key);
    if (!t || tenantKey(t.id) !== key || !t.agents) continue;
    const ctx: AuthContext = { tenantId: t.id, userId: "scheduler", plan: t.plan, scopes: [], client: "agent" };
    for (const def of agents) {
      const s = t.agents[def.id];
      if (!s?.enabled) continue;
      const { enabled: _e, ...config } = s;
      const last = await svc.store.get<string>(lastRunKey(t.id, def.id));
      if (def.due && !def.due(now, last, config)) continue;
      try {
        out.push(await runAgent(def, ctx, deps, "schedule"));
      } catch (e) {
        console.error("agent run failed", def.id, e);
      }
    }
  }
  return out;
}

function need(ctx: AuthContext, scope: "agents:run" | "outbox:approve") {
  if (!ctx.scopes.includes(scope)) throw new AgentError("forbidden", `This needs the ${scope} permission on your access key.`, 403);
}

const view = (r: AgentRunRecord) => ({ ...r, footer: r.citations ? sourcesFooter(r.citations) : null });

/** Handles /api/assistant/agents* and /api/assistant/outbox*. Returns null for other paths. */
export async function handleAgentRoutes(
  request: Request,
  path: string,
  svc: RancherService,
  ctx: AuthContext,
  body: () => Promise<Record<string, unknown>>,
  json: (b: unknown, status?: number) => Response,
  sender?: Sender,
): Promise<Response | null> {
  if (!path.startsWith("/api/assistant/agents") && !path.startsWith("/api/assistant/outbox")) return null;
  const now = svc.now();

  if (request.method === "GET" && path === "/api/assistant/agents") {
    const t = await svc.deps.data(ctx).data.tenant();
    const agents = await Promise.all(
      RANCHER_AGENTS.map(async (a) => ({
        id: a.id,
        title: a.title,
        description: a.description,
        tools: a.tools,
        limits: a.limits,
        enabled: t?.agents?.[a.id]?.enabled === true,
        paused: !!(await svc.store.get(`agentpause:${ctx.tenantId}:${a.id}`)),
        last_scheduled_run: await svc.store.get<string>(lastRunKey(ctx.tenantId, a.id)),
      })),
    );
    return json({ agents, sending: "Planned: approved items are recorded but not sent yet." });
  }
  if (request.method === "GET" && path === "/api/assistant/agents/runs") return json({ runs: (await listRuns(svc.store, ctx)).map(view) });

  const m = path.match(/^\/api\/assistant\/agents\/([a-z_]{3,40})\/(run|pause|resume)$/);
  if (request.method === "POST" && m) {
    need(ctx, "agents:run");
    const def = find(m[1]!);
    if (!def) throw new AgentError("invalid_input", "Unknown agent.", 404);
    const pauseKey = `agentpause:${ctx.tenantId}:${def.id}`;
    if (m[2] === "pause") {
      await svc.store.put(pauseKey, { at: now.toISOString(), by: ctx.userId });
      return json({ id: def.id, paused: true });
    }
    if (m[2] === "resume") {
      await svc.store.put(pauseKey, null);
      return json({ id: def.id, paused: false });
    }
    if (!(await svc.rateLimiter.hit(`agentmanual:${ctx.tenantId}`, 20, 3600, now.getTime())))
      throw new AgentError("rate_limited", "Too many manual runs this hour.", 429);
    return json({ run: view(await runAgent(def, ctx, agentDeps(svc), "manual")) });
  }

  if (request.method === "GET" && path === "/api/assistant/outbox") return json({ items: await listOutbox(svc.store, ctx, now), sending: "Planned" });
  const o = path.match(/^\/api\/assistant\/outbox\/([0-9a-f-]{36})\/(approve|reject)$/);
  if (request.method === "POST" && o) {
    need(ctx, "outbox:approve");
    const b = await body();
    if (o[2] === "approve" && b.confirm !== true) throw new AgentError("invalid_input", 'Send {"confirm": true} after reading the item to approve it.', 400);
    return json({ item: await decideOutbox(svc.store, svc.audit, ctx, o[1]!, o[2] as "approve" | "reject", now, sender) });
  }
  return json({ error: "not_found" }, 404);
}
