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
//   - "What I did": every run also writes a plain activity record (data read,
//     sources and times, rules applied, what was skipped and why).
//   - Overrides: items the rancher dismissed, marked wrong, or snoozed are left
//     out of later runs; corrections are shown in the rancher's words.
//   - Off by default: a scheduled or Run now run needs the agent turned on in
//     the rancher's settings. A job built by hand ("by_hand") is the rancher's
//     own action, so it does not need the agent on and does not touch the
//     agent's state, caps, or schedule.
import { describeArgs, issueRules, recordActivity, sourcesOf, type ActivityRecord } from "./activity";
import type { AuditLog } from "./audit";
import { enforceCitations, type Citation } from "./citations";
import { agentKilled, type KillEnv } from "./killswitch";
import type { RateLimiter } from "./rate-limit";
import type { ExecutorDeps, ToolRegistry } from "./registry";
import type { PrivateStore } from "./store";
import { AgentError, type AuthContext, type Scope, type ToolResult } from "./types";
import { checkOutput, numbersIn } from "../guardrails/output-check";
import { applyOverrides, listOverrides, OVERRIDE_WHY, type AgentItem } from "./overrides";

export type AgentTrigger = "schedule" | "manual" | "by_hand";

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
  /** Plain text with [S#] markers matching `citations`. Used when `lines` is not set. */
  body?: string;
  /** The write-up line by line. Lines with a key are items the rancher can dismiss, correct, mark wrong, or snooze. */
  lines?: (string | AgentItem)[];
  /** Skip reason to use when every item was hidden by the rancher's overrides. */
  allHiddenSkip?: string;
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

export interface RunItem {
  id: string;
  text: string;
  /** shown, corrected, or the override that hid it (dismiss, wrong, snooze). */
  status: "shown" | "corrected" | "dismiss" | "wrong" | "snooze";
  note?: string;
}

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
  items?: RunItem[];
  /** The "what I did" record for this run. */
  activity_id?: string;
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
  /** The text as the agent wrote it, kept when the rancher edits the item. */
  original?: { title: string; body: string; to: string };
  edits?: { at: string; by: string; fields: string[] }[];
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
  /** Plain names for ids (ranches, allotments) used in "what I did" records. */
  names?(ctx: AuthContext): Promise<Record<string, string>>;
}

export interface RunOptions {
  /** Settings for this run on top of the saved ones (used by jobs built by hand). */
  config?: Record<string, unknown>;
}

const RUN_TTL = 90 * 86400;
const OUTBOX_TTL_DAYS = 7;
const rev = (iso: string) => (9_999_999_999_999 - Date.parse(iso)).toString().padStart(13, "0");
export const runKey = (tenant: string, at: string, id: string) => `agentrun:${tenant}:${rev(at)}:${id}`;
export const outboxKey = (tenant: string, id: string) => `outbox:${tenant}:${id}`;
export const lastRunKey = (tenant: string, agent: string) => `agentlast:${tenant}:${agent}`;

const strip = (t: string) => t.replace(/\s*\[S\d{1,3}\]/g, "").trim();
const SETTING_KEYS = ["radius_miles", "days", "interval_minutes", "hour_utc", "areas", "contact_index"];

function plainOutcome(_def: { title: string }, rec: AgentRunRecord, byHand: boolean): string {
  switch (rec.status) {
    case "ok": {
      const items = rec.items ?? [];
      const shown = items.filter((i) => i.status === "shown" || i.status === "corrected").length;
      const hidden = items.length - shown;
      const src = rec.citations?.length ?? 0;
      const what =
        `${byHand ? "You built it" : "Wrote it"} from ${src} ${src === 1 ? "source" : "sources"}` +
        (items.length ? `, with ${shown} ${shown === 1 ? "item" : "items"}${hidden ? ` and ${hidden} left out because of your choices` : ""}` : "") +
        ".";
      return rec.outbox_id ? `${what} It is waiting in your outbox for your approval.` : what;
    }
    case "skipped":
      return rec.reason ?? "Nothing to report.";
    case "blocked":
      return "A safety check stopped the write-up, so nothing was shown.";
    default:
      return rec.reason ?? "Did not run.";
  }
}

/** Run one agent for one tenant, with every guardrail above. Never throws for policy stops; returns the record. */
export async function runAgent<D, P>(def: AgentDefinition<P>, base: AuthContext, deps: BackgroundDeps<D, P>, trigger: AgentTrigger, opts: RunOptions = {}): Promise<AgentRunRecord> {
  const now = deps.now();
  const at = now.toISOString();
  const byHand = trigger === "by_hand";
  const rec: AgentRunRecord = { id: crypto.randomUUID(), agent: def.id, tenant_id: base.tenantId, at, trigger, status: "ok", tool_calls: 0, cost_units: 0 };
  // A key limited to some tools limits its agent runs too.
  const tools = base.tools ? def.tools.filter((t) => base.tools!.includes(t)) : def.tools;
  const ctx: AuthContext = { ...base, client: byHand ? "web-manual" : `agent:${def.id}`, scopes: def.scopes, tools };
  delete ctx.callsPerDay;
  const reads: { tool: string; args: Record<string, unknown> }[] = [];
  const skipped: { what: string; why: string }[] = [];
  let checkedOutput = false;
  let config: Record<string, unknown> = {};

  const finish = async (status: RunStatus, extra: Partial<AgentRunRecord> = {}) => {
    Object.assign(rec, { status, ...extra });
    const names = (await deps.names?.(base)) ?? {};
    const titleOf = (t: string) => deps.registry.get(t)?.title ?? t.replace(/_/g, " ");
    const used = Object.fromEntries(SETTING_KEYS.filter((k) => config[k] !== undefined).map((k) => [k, config[k]]));
    const rules = [
      byHand
        ? "You started this by hand. It used the same data and checks as the agent, and did not change the agent's schedule or memory."
        : trigger === "schedule"
          ? "Ran because it was due on the schedule you set."
          : "Ran because you pressed Run now.",
      `Read only the data this job is allowed to read: ${tools.map(titleOf).join(", ")}.`,
      `Limits: up to ${def.limits.maxToolCalls} lookups per run${byHand ? "" : ` and ${def.limits.runsPerDay} runs a day`}.`,
      ...(Object.keys(used).length ? [`Used your settings: ${describeArgs(used, names)}.`] : []),
      ...(checkedOutput ? ["Checked the write-up the same way as a chat answer: facts need a source, exact coordinates not from your own records are held back, and links are removed."] : []),
      ...issueRules(rec.issues),
      ...(rec.outbox_id ? ["Anything addressed to someone else waits in your outbox. Nothing goes out without your approval, and sending is Planned."] : []),
    ];
    if (status !== "ok" && status !== "skipped" && rec.reason) skipped.push({ what: "This run", why: rec.reason });
    const act: Omit<ActivityRecord, "id"> = {
      tenant_id: base.tenantId,
      at,
      kind: byHand ? "manual" : "agent_run",
      actor: byHand ? "you" : `agent:${def.id}`,
      title: rec.title ?? def.title,
      outcome: plainOutcome(def, rec, byHand),
      read: reads.map((r) => ({ tool: r.tool, title: titleOf(r.tool), detail: describeArgs(r.args, names) })),
      sources: sourcesOf(rec.citations),
      rules,
      skipped,
      ...(rec.items?.length ? { items: rec.items.map(({ id, text, status, note }) => ({ id, text: strip(text), status, ...(note ? { note } : {}) })) } : {}),
      ref: { agent: def.id, run_id: rec.id, ...(rec.outbox_id ? { outbox_id: rec.outbox_id } : {}) },
    };
    rec.activity_id = (await recordActivity(deps.store, act)).id;
    if (!byHand) await deps.store.put(runKey(base.tenantId, at, rec.id), rec, { expirationTtl: RUN_TTL });
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

  if (!byHand) {
    const killed = await agentKilled(deps.store, deps.env, base.tenantId, def.id);
    if (killed) return finish("killed", { reason: killed });
  }
  if (!(await deps.entitled(base))) return finish("disabled", { reason: "This needs the private rancher plan." });
  const settings = await deps.settings(base, def.id);
  config = { ...(settings?.config ?? {}), ...(opts.config ?? {}) };
  if (!byHand && !settings?.enabled) return finish("disabled", { reason: "This agent is off. Turn it on in Settings, or build it by hand." });
  if (!byHand && !(await deps.rateLimiter.hit(`agentrun:${base.tenantId}:${def.id}`, def.limits.runsPerDay, 86_400, now.getTime())))
    return finish("capped", { reason: `This agent has reached its limit of ${def.limits.runsPerDay} runs today.` });

  // Numbers the write-up may state: only those in tool data and arguments (and list lengths).
  const known: number[] = [];
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    if (!tools.includes(name)) throw new AgentError("forbidden", `${def.id} may not use ${name}.`, 403);
    if (rec.tool_calls >= def.limits.maxToolCalls) throw new AgentError("rate_limited", `Run stopped at ${def.limits.maxToolCalls} tool calls.`, 429);
    if (rec.cost_units + 1 > def.limits.maxCostUnits) throw new AgentError("rate_limited", `Run stopped at its cost cap.`, 429);
    if (!byHand && !(await deps.rateLimiter.hit(`agentcost:${base.tenantId}`, deps.costUnitsPerDay, 86_400, now.getTime())))
      throw new AgentError("rate_limited", "Your agents have used today's budget.", 429);
    rec.tool_calls++;
    rec.cost_units++;
    reads.push({ tool: name, args });
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
      config,
      profile: await deps.profile(base),
      // A job built by hand starts fresh and leaves the agent's memory alone.
      state: byHand
        ? { get: async () => null, put: async () => {} }
        : { get: <T>() => deps.store.get<T>(stateKey), put: (v) => deps.store.put(stateKey, v, { expirationTtl: 60 * 86400 }) },
      tool,
    });
  } catch (e) {
    const err = e instanceof AgentError ? e : null;
    if (err?.code === "rate_limited") return finish("capped", { reason: err.message });
    return finish("error", { reason: err ? err.message : "The agent failed." });
  }
  if (trigger === "schedule") await deps.store.put(lastRunKey(base.tenantId, def.id), at, { expirationTtl: 60 * 86400 });
  if (out.skip) return finish("skipped", { reason: out.skip });

  // The rancher's overrides: dismissed, wrong, and snoozed items are left out.
  let text = out.body ?? "";
  const corrections: { note: string; text: string }[] = [];
  if (out.lines) {
    const items = out.lines.filter((l): l is AgentItem => typeof l !== "string");
    const { shown, hidden } = await applyOverrides(items, await listOverrides(deps.store, base.tenantId, def.id), now);
    const shownKeys = new Set(shown.map((i) => i.key));
    rec.items = [
      ...shown.map((i): RunItem => ({ id: i.id, text: i.text, status: i.note ? "corrected" : "shown", ...(i.note ? { note: i.note } : {}) })),
      ...hidden.map((i): RunItem => ({ id: i.id, text: i.text, status: i.override.action as RunItem["status"], ...(i.override.note ? { note: i.override.note } : {}) })),
    ];
    for (const h of hidden) skipped.push({ what: strip(h.text), why: OVERRIDE_WHY[h.override.action] + (h.override.until ? ` Snoozed until ${h.override.until.slice(0, 10)}.` : "") });
    for (const i of shown) if (i.note) corrections.push({ note: i.note, text: strip(i.text) });
    if (items.length && !shown.length && out.allHiddenSkip) return finish("skipped", { reason: out.allHiddenSkip });
    text = out.lines.filter((l) => typeof l === "string" || shownKeys.has(l.key)).map((l) => (typeof l === "string" ? l : l.text)).join("\n");
  }

  // Same output checks as a chat answer.
  const allowedCoords = (await deps.allowedCoords?.(base)) ?? [];
  checkedOutput = true;
  const checked = checkOutput({ text, catalog: out.citations, allowedCoords, knownNumbers: numbersIn([config], known) });
  if (checked.blocked) return finish("blocked", { reason: "The write-up was stopped by a safety check.", issues: checked.issues });
  const cited = enforceCitations(checked.text, out.citations);
  let body = cited.text;
  // Corrections are the rancher's own words, shown after the checked write-up.
  const notes = corrections
    .map((c) => ({ ...c, check: checkOutput({ text: c.note, catalog: [], allowedCoords, grounding: false }) }))
    .filter((c) => !c.check.blocked)
    .map((c) => `- ${c.check.text} (about: ${c.text.slice(0, 80)}${c.text.length > 80 ? "..." : ""})`);
  if (notes.length) body += `\n\nYour corrections:\n${notes.join("\n")}`;
  const extra: Partial<AgentRunRecord> = { title: out.title, body, citations: cited.citations, issues: checked.issues.length ? checked.issues : undefined };

  if (out.delivery && !byHand) extra.outbox_id = (await createOutboxItem(deps.store, base.tenantId, def.id, rec.id, out.delivery, out.title, body, cited.citations, now)).id;
  return finish("ok", extra);
}

export async function createOutboxItem(
  store: PrivateStore,
  tenant: string,
  agent: string,
  runId: string,
  delivery: Delivery,
  title: string,
  body: string,
  citations: Citation[],
  now: Date,
): Promise<OutboxItem> {
  const item: OutboxItem = {
    id: crypto.randomUUID(),
    tenant_id: tenant,
    agent,
    run_id: runId,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + OUTBOX_TTL_DAYS * 86400_000).toISOString(),
    status: "pending_approval",
    delivery,
    title,
    body,
    citations,
  };
  await store.put(outboxKey(tenant, item.id), item, { expirationTtl: 30 * 86400 });
  return item;
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

const EMAIL = /^[^\s@<>"]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/i;
const PHONE = /^\+?[0-9 ().-]{7,20}$/;

/**
 * Edit a pending outbox item before approving it. The same person who can
 * approve can edit: outbox:approve scope on a web session. The new text goes
 * through the safety blockers and coordinate check (not the citation check:
 * these are the rancher's own words). The agent's original text is kept.
 */
export async function editOutbox(
  store: PrivateStore,
  audit: AuditLog,
  ctx: AuthContext,
  id: string,
  patch: Record<string, unknown>,
  now: Date,
  allowedCoords: [number, number][] = [],
): Promise<OutboxItem> {
  if (!ctx.scopes.includes("outbox:approve")) throw new AgentError("forbidden", "Editing needs the outbox:approve permission on your access key.", 403);
  if (!ctx.client.startsWith("web")) throw new AgentError("forbidden", "Outbox items can only be edited by a person in the web app.", 403);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new AgentError("invalid_input", "Unknown outbox item.", 404);
  const key = outboxKey(ctx.tenantId, id);
  const item = await store.get<OutboxItem>(key);
  if (!item || item.tenant_id !== ctx.tenantId) throw new AgentError("invalid_input", "Unknown outbox item.", 404);
  if (item.status !== "pending_approval" || Date.parse(item.expires_at) <= now.getTime())
    throw new AgentError("invalid_input", "Only items waiting for approval can be edited.", 409);
  const fields: string[] = [];
  const next: OutboxItem = { ...item, delivery: { ...item.delivery } };
  if (patch.title !== undefined) {
    if (typeof patch.title !== "string" || !patch.title.trim() || patch.title.length > 200) throw new AgentError("invalid_input", "title must be 1 to 200 characters.", 400);
    next.title = patch.title.replace(/[\r\n]+/g, " ").trim();
    fields.push("title");
  }
  if (patch.body !== undefined) {
    if (typeof patch.body !== "string" || !patch.body.trim() || patch.body.length > 8000) throw new AgentError("invalid_input", "body must be 1 to 8000 characters.", 400);
    next.body = patch.body.replace(/\r\n/g, "\n").trim();
    fields.push("body");
  }
  if (patch.to !== undefined) {
    const to = typeof patch.to === "string" ? patch.to.trim() : "";
    if (!(item.delivery.channel === "email" ? EMAIL.test(to) : PHONE.test(to)))
      throw new AgentError("invalid_input", item.delivery.channel === "email" ? "to must be an email address." : "to must be a phone number.", 400);
    next.delivery.to = to;
    fields.push("to");
  }
  if (!fields.length) throw new AgentError("invalid_input", "Send title, body, or to.", 400);
  for (const f of ["title", "body"] as const) {
    if (!fields.includes(f)) continue;
    const c = checkOutput({ text: next[f], catalog: next.citations, allowedCoords, grounding: false });
    if (c.blocked) throw new AgentError("policy_declined", "That text was stopped by a safety check. Nothing was saved.", 422);
    if (c.issues.includes("coordinates")) throw new AgentError("policy_declined", "Exact coordinates that are not from your own records can't go in an outbox item. Nothing was saved.", 422);
  }
  next.original ??= { title: item.title, body: item.body, to: item.delivery.to };
  next.edits = [...(item.edits ?? []), { at: now.toISOString(), by: ctx.userId, fields }].slice(-20);
  await store.put(key, next, { expirationTtl: 30 * 86400 });
  await audit.record({
    id: crypto.randomUUID(),
    at: now.toISOString(),
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    client: ctx.client,
    ...(ctx.keyId ? { key_id: ctx.keyId } : {}),
    tool: "outbox.edit",
    input: { id, agent: item.agent, fields },
    outcome: "ok",
    flags: fields.map((f) => `field:${f}`),
    duration_ms: 0,
    sources: [],
  });
  return next;
}
