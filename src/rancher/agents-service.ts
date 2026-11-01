// Wires the background agents into the rancher service: on/off and settings
// from the rancher's preferences (prefs.ts, off by default), the cron
// scheduler, and the HTTP routes. Each route also answers under /api/ranch/
// (the same paths with /api/ranch in place of /api/assistant).
//
//   GET  /api/assistant/agents                  agents, on/off, settings, and pause state
//   GET  /api/assistant/agents/runs             recent runs (newest first)
//   POST /api/assistant/agents/:id/run          run now (agents:run scope)
//   POST /api/assistant/agents/:id/pause        pause your own agent (agents:run scope)
//   POST /api/assistant/agents/:id/resume
//   GET  /api/assistant/outbox                  items waiting for approval
//   POST /api/assistant/outbox/:id/approve      body {"confirm": true}; outbox:approve scope, web only
//   POST /api/assistant/outbox/:id/reject
import { sourcesFooter } from "../agents/citations";
import { recordActivity } from "../agents/activity";
import { decideOutbox, editOutbox, lastRunKey, listOutbox, listRuns, runAgent, type AgentDefinition, type AgentRunRecord, type BackgroundDeps, type Sender } from "../agents/background";
import { AgentError, type AuthContext } from "../agents/types";
import { RANCHER_AGENTS, type AgentProfile } from "./background-agents";
import { agentPref, effectiveSettings, getPrefs } from "./prefs";
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
    // On only when the rancher turned it on. The tenant record supplies default thresholds only.
    async settings(ctx, id) {
      const prefs = await getPrefs(svc.store, ctx.tenantId);
      return { enabled: agentPref(prefs, id).on, config: effectiveSettings(await tenant(ctx), prefs, id) };
    },
    async names(ctx) {
      const t = await tenant(ctx);
      return Object.fromEntries((t?.ranches ?? []).flatMap((r) => [[r.id, r.name], ...r.allotments.map((a) => [a.id, a.name])]));
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

/**
 * Cron entry: run every due agent the rancher turned on and has not snoozed.
 * Only accounts with saved preferences are looked at; everything is off
 * without them. Returns what ran.
 */
export async function runScheduledAgents(svc: RancherService, agents: AgentDefinition<AgentProfile>[] = RANCHER_AGENTS, maxTenants = 500): Promise<AgentRunRecord[]> {
  const deps = agentDeps(svc);
  const now = svc.now();
  const out: AgentRunRecord[] = [];
  for (const pkey of await svc.store.list("prefs:", maxTenants)) {
    const id = pkey.slice("prefs:".length);
    const t = await svc.store.get<TenantRecord>(tenantKey(id));
    if (!t || t.id !== id) continue;
    const prefs = await getPrefs(svc.store, id);
    const ctx: AuthContext = { tenantId: t.id, userId: "scheduler", plan: t.plan, scopes: [], client: "agent" };
    for (const def of agents) {
      const p = agentPref(prefs, def.id);
      if (!p.on) continue;
      if (p.snooze_until && Date.parse(p.snooze_until) > now.getTime()) continue;
      const config = effectiveSettings(t, prefs, def.id);
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
  path = path.replace(/^\/api\/ranch\//, "/api/assistant/");
  if (!path.startsWith("/api/assistant/agents") && !path.startsWith("/api/assistant/outbox")) return null;
  const now = svc.now();

  if (request.method === "GET" && path === "/api/assistant/agents") {
    const t = await svc.deps.data(ctx).data.tenant();
    const prefs = await getPrefs(svc.store, ctx.tenantId);
    const agents = await Promise.all(
      RANCHER_AGENTS.map(async (a) => ({
        id: a.id,
        title: a.title,
        description: a.description,
        tools: a.tools,
        limits: a.limits,
        enabled: agentPref(prefs, a.id).on,
        snooze_until: agentPref(prefs, a.id).snooze_until,
        settings: effectiveSettings(t, prefs, a.id),
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
  const e = path.match(/^\/api\/assistant\/outbox\/([0-9a-f-]{36})$/);
  if ((request.method === "PATCH" || request.method === "POST") && e) {
    const item = await editOutbox(svc.store, svc.audit, ctx, e[1]!, await body(), now, await ownCoords(svc, ctx));
    await recordActivity(svc.store, {
      tenant_id: ctx.tenantId,
      at: now.toISOString(),
      kind: "outbox",
      actor: "you",
      title: `You edited "${item.title}"`,
      outcome: `Changed ${item.edits!.at(-1)!.fields.join(", ")}. It still waits for your approval.`,
      read: [],
      sources: [],
      rules: ["Checked your text for blocked content and exact coordinates not from your own records.", "The agent's original text is kept with the item."],
      skipped: [],
      ref: { agent: item.agent, outbox_id: item.id },
    });
    return json({ item });
  }
  const o = path.match(/^\/api\/assistant\/outbox\/([0-9a-f-]{36})\/(approve|reject)$/);
  if (request.method === "POST" && o) {
    need(ctx, "outbox:approve");
    const b = await body();
    if (o[2] === "approve" && b.confirm !== true) throw new AgentError("invalid_input", 'Send {"confirm": true} after reading the item to approve it.', 400);
    const item = await decideOutbox(svc.store, svc.audit, ctx, o[1]!, o[2] as "approve" | "reject", now, sender);
    await recordActivity(svc.store, {
      tenant_id: ctx.tenantId,
      at: now.toISOString(),
      kind: "outbox",
      actor: "you",
      title: `You ${o[2] === "approve" ? "approved" : "rejected"} "${item.title}"`,
      outcome: item.delivery_result ? item.delivery_result.note : "Rejected. Nothing will be sent.",
      read: [],
      sources: [],
      rules: ["Only a person in the web app can approve or reject."],
      skipped: [],
      ref: { agent: item.agent, outbox_id: item.id },
    });
    return json({ item });
  }
  return json({ error: "not_found" }, 404);
}

/** Coordinates of the rancher's own records, which they may see in text they edit. */
export async function ownCoords(svc: RancherService, ctx: AuthContext): Promise<[number, number][]> {
  const keys = await svc.store.list(`obs:${ctx.tenantId}:`, 500);
  const rows = await Promise.all(keys.map((k) => svc.store.get<{ lat?: number; lon?: number }>(k)));
  return rows.filter((r): r is { lat: number; lon: number } => typeof r?.lat === "number" && typeof r?.lon === "number").map((r) => [r.lat, r.lon]);
}
