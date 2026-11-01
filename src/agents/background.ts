// Background agents: small, deterministic jobs that read the rancher's data
// through the same tool registry as chat and produce a short cited write-up.
//
// Guardrails, all enforced here rather than trusted to each agent:
//   - Tool allowlist per agent. The run's AuthContext carries `tools`, so the
//     registry itself refuses anything else (and the agent gets read scopes only).
//   - Kill switches (see killswitch.ts) checked before every run.
//   - Caps: runs per day per tenant and agent, tool calls per run, and cost
//     units per run and per tenant per day.
//   - Output check: the same blockers, coordinate redaction, link removal,
//     and citation rules as chat answers.
//   - Nothing leaves the system without a person: anything addressed outside
//     goes to the outbox as pending_approval, and approval needs the
//     outbox:approve scope on a web session. Delivery itself is Planned; the
//     default sender records the approval and sends nothing.
//   - Audit: every run, every tool call, and every approval is logged.
import type { AuditLog } from "./audit";
import { enforceCitations, type Citation } from "./citations";
import { agentKilled, type KillEnv } from "./killswitch";
import type { RateLimiter } from "./rate-limit";
import type { ExecutorDeps, ToolRegistry } from "./registry";
import type { PrivateStore } from "./store";
import { AgentError, type AuthContext, type Scope, type ToolResult } from "./types";
import { checkOutput, numbersIn } from "../guardrails/output-check";

export type AgentTrigger = "schedule" | "manual";

export interface AgentLimits {
  runsPerDay: number;
  maxToolCalls: number;
  /** Cost units per run. A tool call costs 1; a model call (none today) would cost more. */
  maxCostUnits: number;
}

export interface Delivery {
  channel: "email" | "sms";
  /** Address or number. Shown to the rancher before approval. */
  to: string;
  /** Who it is, in plain words, for example "Pat Example, district office". */
  label: string;
}

export interface AgentOutput {
  /** Set when there is nothing to report this time. */
  skip?: string;
  title: string;
  /** Plain text with [S#] markers matching `citations`. */
  body: string;
  citations: Citation[];
  /** Set when the result is meant to leave the system. Always goes through the outbox. */
  delivery?: Delivery;
}

export interface AgentRunContext<P = unknown> {
  ctx: AuthContext;
  now: Date;
  trigger: AgentTrigger;
  /** The agent's settings from the tenant record, already validated by the agent. */
  config: Record<string, unknown>;
  /** Read-only facts the agent may need to plan its calls (names and ids, no data). */
  profile: P;
  /** Small per-tenant state for this agent (for example ids already alerted). */
  state: { get<T>(): Promise<T | null>; put(value: unknown): Promise<void> };
  /** Call an allowed tool. Counts toward the run's caps. */
  tool(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
}

export interface AgentDefinition<P = unknown> {
  id: string;
  title: string;
  description: string;
  /** Tools this agent may call. Nothing else. */
  tools: string[];
  /** Scopes the run gets. Read scopes only. */
  scopes: Scope[];
  limits: AgentLimits;
  /** When a scheduled run is due, given the last scheduled run (if any). */
  due?(now: Date, last: string | null, config: Record<string, unknown>): boolean;
  run(r: AgentRunContext<P>): Promise<AgentOutput>;
}

export type RunStatus = "ok" | "skipped" | "blocked" | "error" | "killed" | "capped" | "disabled";

export interface AgentRunRecord {
  id: string;
  agent: string;
  tenant_id: string;
  at: string;
  trigger: AgentTrigger;
  status: RunStatus;
  reason?: string;
  tool_calls: number;
  cost_units: number;
  title?: string;
  body?: string;
  citations?: Citation[];
  issues?: string[];
  outbox_id?: string;
}

export type OutboxStatus = "pending_approval" | "approved" | "rejected" | "expired";

export interface OutboxItem {
  id: string;
  tenant_id: string;
  agent: string;
  run_id: string;
  created_at: string;
  expires_at: string;
  status: OutboxStatus;
  delivery: Delivery;
  title: string;
  body: string;
  citations: Citation[];
  decided_at?: string;
  decided_by?: string;
  /** What happened at delivery. Sending is Planned, so this says nothing was sent. */
  delivery_result?: { sent: boolean; note: string };
}

/** Sends an approved outbox item. Real email/SMS delivery is Planned. */
export interface Sender {
  send(item: OutboxItem): Promise<{ sent: boolean; note: string }>;
}

export class NullSender implements Sender {
  async send(): Promise<{ sent: boolean; note: string }> {
    return { sent: false, note: "Planned: sending is not built yet. Nothing was sent. Copy the text to send it yourself." };
  }
}

export interface BackgroundDeps<D, P> {
  store: PrivateStore;
  registry: ToolRegistry<D>;
  exec: ExecutorDeps<D>;
  audit: AuditLog;
  rateLimiter: RateLimiter;
  env: KillEnv;
  now: () => Date;
  /** Is this tenant entitled to the assistant? */
  entitled(ctx: AuthContext): Promise<boolean>;
  /** Agent settings from the tenant record, or null if not set. */
  settings(ctx: AuthContext, agentId: string): Promise<{ enabled: boolean; config: Record<string, unknown> } | null>;
  profile(ctx: AuthContext): Promise<P>;
  /** Coordinates the tenant may see in agent output (their own records). */
  allowedCoords?(ctx: AuthContext): Promise<[number, number][]>;
  /** Tenant-wide cost units per day across agents. */
  costUnitsPerDay: number;
}

const RUN_TTL = 90 * 86400;
const OUTBOX_TTL_DAYS = 7;
const rev = (iso: string) => (9_999_999_999_999 - Date.parse(iso)).toString().padStart(13, "0");
export const runKey = (tenant: string, at: string, id: string) => `agentrun:${tenant}:${rev(at)}:${id}`;
export const outboxKey = (tenant: string, id: string) => `outbox:${tenant}:${id}`;
export const lastRunKey = (tenant: string, agent: string) => `agentlast:${tenant}:${agent}`;

/** Run one agent for one tenant, with every guardrail above. Never throws for policy stops; returns the record. */
export async function runAgent<D, P>(def: AgentDefinition<P>, base: AuthContext, deps: BackgroundDeps<D, P>, trigger: AgentTrigger): Promise<AgentRunRecord> {
  const now = deps.now();
  const at = now.toISOString();
  const rec: AgentRunRecord = { id: crypto.randomUUID(), agent: def.id, tenant_id: base.tenantId, at, trigger, status: "ok", tool_calls: 0, cost_units: 0 };
  // A key limited to some tools limits its agent runs too.
  const tools = base.tools ? def.tools.filter((t) => base.tools!.includes(t)) : def.tools;
  const ctx: AuthContext = { ...base, client: `agent:${def.id}`, scopes: def.scopes, tools };
  delete ctx.callsPerDay;

  const finish = async (status: RunStatus, extra: Partial<AgentRunRecord> = {}) => {
    Object.assign(rec, { status, ...extra });
    await deps.store.put(runKey(base.tenantId, at, rec.id), rec, { expirationTtl: RUN_TTL });
    await deps.audit.record({
      id: crypto.randomUUID(),
      at,
      tenant_id: base.tenantId,
      user_id: base.userId,
      client: ctx.client,
      tool: `agent.${def.id}`,
      input: { trigger },
      outcome: status === "ok" || status === "skipped" ? "ok" : status === "blocked" ? "blocked" : status === "error" ? "error" : status === "capped" ? "rate_limited" : "denied",
      flags: [`status:${status}`, ...(rec.issues ?? []).map((i) => `issue:${i}`), ...(rec.outbox_id ? [`outbox:${rec.outbox_id}`] : [])],
      ...(rec.reason ? { error: rec.reason } : {}),
      duration_ms: Date.now() - now.getTime(),
      sources: (rec.citations ?? []).map(({ id, kind, title, url, observed_at, received_at }) => ({ id, kind, title, url, observed_at, received_at })),
    });
    return rec;
  };

  const killed = await agentKilled(deps.store, deps.env, base.tenantId, def.id);
  if (killed) return finish("killed", { reason: killed });
  if (!(await deps.entitled(base))) return finish("disabled", { reason: "This needs the private rancher plan." });
  const settings = await deps.settings(base, def.id);
  if (trigger === "schedule" && !settings?.enabled) return finish("disabled", { reason: "This agent is not turned on for your account." });
  if (!(await deps.rateLimiter.hit(`agentrun:${base.tenantId}:${def.id}`, def.limits.runsPerDay, 86_400, now.getTime())))
    return finish("capped", { reason: `This agent has reached its limit of ${def.limits.runsPerDay} runs today.` });

  let costLeftToday = true;
  // Numbers the write-up may state: only those in tool data and arguments (and list lengths).
  const known: number[] = [];
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    if (!tools.includes(name)) throw new AgentError("forbidden", `${def.id} may not use ${name}.`, 403);
    if (rec.tool_calls >= def.limits.maxToolCalls) throw new AgentError("rate_limited", `Run stopped at ${def.limits.maxToolCalls} tool calls.`, 429);
    if (rec.cost_units + 1 > def.limits.maxCostUnits) throw new AgentError("rate_limited", `Run stopped at its cost cap.`, 429);
    costLeftToday = await deps.rateLimiter.hit(`agentcost:${base.tenantId}`, deps.costUnitsPerDay, 86_400, now.getTime());
    if (!costLeftToday) throw new AgentError("rate_limited", "Your agents have used today's budget.", 429);
    rec.tool_calls++;
    rec.cost_units++;
    const r = await deps.registry.execute(name, args, ctx, deps.exec);
    numbersIn([args, r.data], known);
    return r;
  };
  const stateKey = `agentstate:${base.tenantId}:${def.id}`;
  let out: AgentOutput;
  try {
    out = await def.run({
      ctx,
      now,
      trigger,
      config: settings?.config ?? {},
      profile: await deps.profile(base),
      state: { get: <T>() => deps.store.get<T>(stateKey), put: (v) => deps.store.put(stateKey, v, { expirationTtl: 60 * 86400 }) },
      tool,
    });
  } catch (e) {
    const err = e instanceof AgentError ? e : null;
    if (err?.code === "rate_limited") return finish("capped", { reason: err.message });
    return finish("error", { reason: err ? err.message : "The agent failed." });
  }
  if (trigger === "schedule") await deps.store.put(lastRunKey(base.tenantId, def.id), at, { expirationTtl: 60 * 86400 });
  if (out.skip) return finish("skipped", { reason: out.skip });

  // Same output checks as a chat answer.
  const allowedCoords = (await deps.allowedCoords?.(base)) ?? [];
  const checked = checkOutput({ text: out.body, catalog: out.citations, allowedCoords, knownNumbers: numbersIn([settings?.config ?? {}], known) });
  if (checked.blocked) return finish("blocked", { reason: "The write-up was stopped by a safety check.", issues: checked.issues });
  const cited = enforceCitations(checked.text, out.citations);
  const body = cited.text;
  const extra: Partial<AgentRunRecord> = { title: out.title, body, citations: cited.citations, issues: checked.issues.length ? checked.issues : undefined };

  if (out.delivery) {
    const item: OutboxItem = {
      id: crypto.randomUUID(),
      tenant_id: base.tenantId,
      agent: def.id,
      run_id: rec.id,
      created_at: at,
      expires_at: new Date(now.getTime() + OUTBOX_TTL_DAYS * 86400_000).toISOString(),
      status: "pending_approval",
      delivery: out.delivery,
      title: out.title,
      body,
      citations: cited.citations,
    };
    await deps.store.put(outboxKey(base.tenantId, item.id), item, { expirationTtl: 30 * 86400 });
    extra.outbox_id = item.id;
  }
  return finish("ok", extra);
}

/** The caller's runs, newest first. */
export async function listRuns(store: PrivateStore, ctx: AuthContext, limit = 20): Promise<AgentRunRecord[]> {
  const keys = await store.list(`agentrun:${ctx.tenantId}:`, limit);
  const rows = await Promise.all(keys.map((k) => store.get<AgentRunRecord>(k)));
  return rows.filter((r): r is AgentRunRecord => !!r && r.tenant_id === ctx.tenantId);
}

export async function listOutbox(store: PrivateStore, ctx: AuthContext, now: Date): Promise<OutboxItem[]> {
  const keys = await store.list(`outbox:${ctx.tenantId}:`, 200);
  const rows = (await Promise.all(keys.map((k) => store.get<OutboxItem>(k)))).filter((r): r is OutboxItem => !!r && r.tenant_id === ctx.tenantId);
  return rows.map((r) => (r.status === "pending_approval" && Date.parse(r.expires_at) <= now.getTime() ? { ...r, status: "expired" as const } : r)).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * Approve or reject an outbox item. Only a person on a web session with the
 * outbox:approve scope can do this; background agents and MCP clients can't.
 */
export async function decideOutbox(
  store: PrivateStore,
  audit: AuditLog,
  ctx: AuthContext,
  id: string,
  decision: "approve" | "reject",
  now: Date,
  sender: Sender = new NullSender(),
): Promise<OutboxItem> {
  if (!ctx.scopes.includes("outbox:approve")) throw new AgentError("forbidden", "Approving needs the outbox:approve permission on your access key.", 403);
  if (!ctx.client.startsWith("web")) throw new AgentError("forbidden", "Approvals can only be made by a person in the web app.", 403);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new AgentError("invalid_input", "Unknown outbox item.", 404);
  const key = outboxKey(ctx.tenantId, id);
  const item = await store.get<OutboxItem>(key);
  if (!item || item.tenant_id !== ctx.tenantId) throw new AgentError("invalid_input", "Unknown outbox item.", 404);
  if (item.status !== "pending_approval") throw new AgentError("invalid_input", `This item is already ${item.status.replace("_", " ")}.`, 409);
  if (Date.parse(item.expires_at) <= now.getTime()) {
    await store.put(key, { ...item, status: "expired" });
    throw new AgentError("invalid_input", "This item expired before it was approved.", 409);
  }
  const decided: OutboxItem = { ...item, status: decision === "approve" ? "approved" : "rejected", decided_at: now.toISOString(), decided_by: ctx.userId };
  if (decision === "approve") decided.delivery_result = await sender.send(decided);
  await store.put(key, decided, { expirationTtl: 30 * 86400 });
  await audit.record({
    id: crypto.randomUUID(),
    at: now.toISOString(),
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    client: ctx.client,
    ...(ctx.keyId ? { key_id: ctx.keyId } : {}),
    tool: `outbox.${decision}`,
    input: { id, agent: item.agent, channel: item.delivery.channel },
    outcome: "ok",
    flags: [`sent:${decided.delivery_result?.sent ?? false}`],
    duration_ms: 0,
    sources: [],
  });
  return decided;
}
