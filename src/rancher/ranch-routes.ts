// Ranch tools: the rancher's own settings, the activity log, overrides, and
// every job the agents do, by hand. These routes are not the assistant: they
// work with the assistant and every agent turned off, and they are not
// behind the assistant's on/off switch or kill switch.
//
//   GET  /api/ranch/me                          account, ranches, contacts, what is on
//   GET  /api/ranch/settings                    assistant and agents: on/off, settings, limits, by-hand paths
//   PUT  /api/ranch/settings/assistant          {"on": true|false}
//   PUT  /api/ranch/settings/agents/:id         {"on"?: bool, "settings"?: {...}}  null clears a setting
//   POST /api/ranch/settings/agents/:id/snooze  {"days": 1-30} or {"days": 0} to end the snooze
//   GET  /api/ranch/activity                    "what I did" records, newest first (?kind=&limit=)
//   GET  /api/ranch/activity/:id                one record
//   POST /api/ranch/items/:agent/:item          {"activity_id", "action": dismiss|wrong|correct|snooze|restore, "note"?, "days"?}
//   GET  /api/ranch/overrides                   your dismissals, corrections, and snoozes
//   POST /api/ranch/data/:tool                  {"arguments": {...}} any read-only lookup, by hand
//   POST /api/ranch/manual/:agent               {"settings": {...}} build an agent's write-up by hand (?format=txt to download)
//   GET  /api/ranch/export/activity.csv | records.csv | allotment-activity.csv | nearby-activity.csv | outbox/:id.txt
//   /api/ranch/agents*, /api/ranch/outbox*      same as /api/assistant/agents*, /outbox* (edit with PATCH /outbox/:id)
//
// Changing anything needs the settings:write scope on a web session.
import { getActivity, listActivity, recordActivity, updateActivity, type ActivityKind } from "../agents/activity";
import { createOutboxItem, listOutbox, runAgent } from "../agents/background";
import { sourcesFooter } from "../agents/citations";
import { agentKilled, assistantKilled } from "../agents/killswitch";
import { listOverrides, setOverride, validateOverride } from "../agents/overrides";
import { AgentError, type AuthContext, type ToolResult } from "../agents/types";
import { agentDeps, handleAgentRoutes } from "./agents-service";
import { RANCHER_AGENTS } from "./background-agents";
import { MANUAL_PATHS, MANUAL_TOOL_VIEWS } from "./manual";
import type { TenantRecord } from "./model";
import { agentPref, effectiveSettings, getPrefs, needSettingsWrite, savePrefs, SETTING_RULES, validateSettings } from "./prefs";
import type { RancherService } from "./service";

type Json = (b: unknown, status?: number, extra?: Record<string, string>) => Response;

const find = (id: string) => RANCHER_AGENTS.find((a) => a.id === id);
const KINDS: ActivityKind[] = ["answer", "decline", "agent_run", "manual", "setting", "override", "outbox"];

/** CSV cell: quoted, and text that a spreadsheet would run as a formula is prefixed with a quote mark. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : Array.isArray(v) ? v.join("; ") : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
export const csv = (header: string[], rows: unknown[][]) => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

function file(body: string, name: string, type: string): Response {
  return new Response(body, { headers: { "content-type": `${type}; charset=utf-8`, "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
}

async function logSetting(svc: RancherService, ctx: AuthContext, title: string, outcome: string, rules: string[] = []) {
  await recordActivity(svc.store, { tenant_id: ctx.tenantId, at: svc.now().toISOString(), kind: "setting", actor: "you", title, outcome, read: [], sources: [], rules, skipped: [] });
  await svc.audit.record({
    id: crypto.randomUUID(),
    at: svc.now().toISOString(),
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    client: ctx.client,
    ...(ctx.keyId ? { key_id: ctx.keyId } : {}),
    tool: "settings.change",
    input: { title },
    outcome: "ok",
    duration_ms: 0,
    sources: [],
  });
}

/** Plain words for what changed in an agent's settings, for the activity log. */
export function settingWords(agent: string, before: Record<string, unknown>, after: Record<string, unknown>, profile: { ranches: { id: string; name: string; allotments: { id: string; name: string }[] }[] }): string[] {
  const names = new Map(profile.ranches.flatMap((r) => [[r.id, r.name] as const, ...r.allotments.map((a) => [a.id, a.name] as const)]));
  const out: string[] = [];
  for (const [k, rule] of Object.entries(SETTING_RULES[agent] ?? {})) {
    const a = before[k];
    const b = after[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const label = rule.label.replace(/ \(.*\)$/, "");
    let words: string;
    if (b === undefined) words = rule.default !== undefined ? `back to the default (${rule.default}${rule.unit ? ` ${rule.unit}` : ""})` : "cleared";
    else if (k === "areas") words = (b as string[]).length ? (b as string[]).map((id) => names.get(id) ?? id).join(", ") : "all areas";
    else if (k === "deliver_to") words = (b as { to: string }).to;
    else if (k === "topics") words = `${(b as string[]).length} ${(b as string[]).length === 1 ? "topic" : "topics"}`;
    else if (k === "meeting_at") words = String(b).slice(0, 16).replace("T", " ") + " UTC";
    else if (k === "contact_index") words = `contact ${Number(b) + 1} on file`;
    else words = `${b}${rule.unit ? ` ${rule.unit}` : ""}`;
    out.push(`${label}: ${words}`);
  }
  return out;
}

function int(v: string | null, lo: number, hi: number, dflt: number): number {
  const n = v === null ? NaN : Number(v);
  return Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

interface ActivityData {
  public_layers: { label?: string; source_id?: string; observed_at?: string | null; distance_miles?: number; precision?: string }[];
  your_records: { id: string; kind: string; species: string; observed_at: string; distance_miles?: number }[];
  shared_cells: { cell_id: string; report_count: number; latest_observed_on: string; distance_miles?: number; precision?: string }[];
}

function activityRows(r: ToolResult): unknown[][] {
  const d = r.data as ActivityData;
  const layer = (id?: string) => r.sources.find((s) => s.id === id || s.title === id);
  return [
    ...d.public_layers.map((x) => ["agency layer", x.label ?? "", x.observed_at ?? "", x.distance_miles ?? "", x.precision ?? "", layer(x.source_id)?.publisher ?? "", layer(x.source_id)?.received_at ?? ""]),
    ...d.your_records.map((x) => ["your record", `${x.species} ${x.kind}`, x.observed_at, x.distance_miles ?? "", "exact (your own record)", "You", ""]),
    ...d.shared_cells.map((x) => ["shared report cell", `${x.report_count} report(s)`, x.latest_observed_on, x.distance_miles ?? "", x.precision ?? "generalized", "Sharing group", ""]),
  ];
}
const ACTIVITY_HEADER = ["type", "what", "observed", "distance_miles", "precision", "publisher", "received"];

export async function handleRanch(request: Request, url: URL, svc: RancherService | null, json: Json, readJson: () => Promise<Record<string, unknown>>): Promise<Response> {
  if (!svc) return json({ error: "not_configured", message: "The private rancher plan is not set up on this server." }, 503);
  const path = url.pathname.replace(/\/+$/, "");
  const ctx = await svc.authenticate(request, "web");
  if (!ctx) throw new AgentError("unauthenticated", "Sign in with your rancher access key.", 401);
  const now = svc.now();
  const entitled = await svc.entitlements.has(ctx, "rancher_assistant");
  const data = svc.deps.data(ctx).data;
  const tenant = async (): Promise<TenantRecord | null> => (entitled ? data.tenant() : null);

  if (request.method === "GET" && path === "/api/ranch/me") {
    const t = await tenant();
    const prefs = await getPrefs(svc.store, ctx.tenantId);
    return json({
      tenant: t ? { id: t.id, name: t.name } : { id: ctx.tenantId },
      plan: ctx.plan,
      entitled,
      scopes: ctx.scopes,
      can_change_settings: ctx.scopes.includes("settings:write"),
      ranches: t?.ranches.map((r) => ({ id: r.id, name: r.name, allotments: r.allotments.map((a) => ({ id: a.id, name: a.name })) })) ?? [],
      contacts: (t?.contacts ?? []).map((c, i) => ({ index: i, name: c.name, role: c.role, organization: c.organization })),
      assistant_on: prefs.assistant.on,
      agents_on: RANCHER_AGENTS.filter((a) => agentPref(prefs, a.id).on).map((a) => a.id),
      mock: svc.mock,
    });
  }

  if (!entitled) throw new AgentError("not_entitled", "This needs the private rancher plan.", 402);

  if (path.startsWith("/api/ranch/agents") || path.startsWith("/api/ranch/outbox")) return (await handleAgentRoutes(request, path, svc, ctx, readJson, json))!;

  // ------------------------------------------------------------ settings
  if (request.method === "GET" && path === "/api/ranch/settings") {
    const t = await tenant();
    const prefs = await getPrefs(svc.store, ctx.tenantId);
    const agents = await Promise.all(
      RANCHER_AGENTS.map(async (a) => {
        const p = agentPref(prefs, a.id);
        return {
          id: a.id,
          title: a.title,
          description: a.description,
          on: p.on,
          changed_at: p.at,
          snooze_until: p.snooze_until && Date.parse(p.snooze_until) > now.getTime() ? p.snooze_until : null,
          settings: effectiveSettings(t, prefs, a.id),
          setting_rules: SETTING_RULES[a.id],
          reads: a.tools.map((n) => svc.registry.get(n)?.title ?? n),
          limits: a.limits,
          stopped: await agentKilled(svc.store, svc.env, ctx.tenantId, a.id),
          by_hand: MANUAL_PATHS[a.id],
        };
      }),
    );
    return json({
      assistant: { on: prefs.assistant.on, changed_at: prefs.assistant.at, stopped: await assistantKilled(svc.store, svc.env, ctx.tenantId) },
      agents,
      can_change: ctx.scopes.includes("settings:write"),
      off_by_default: "Everything here is off until you turn it on. Every job also works by hand.",
    });
  }

  if (request.method === "PUT" && path === "/api/ranch/settings/assistant") {
    needSettingsWrite(ctx);
    const b = await readJson();
    if (typeof b.on !== "boolean") throw new AgentError("invalid_input", 'Send {"on": true} or {"on": false}.', 400);
    const prefs = await getPrefs(svc.store, ctx.tenantId);
    prefs.assistant = { on: b.on, at: now.toISOString(), by: ctx.userId };
    await savePrefs(svc.store, ctx.tenantId, prefs);
    await logSetting(svc, ctx, b.on ? "You turned on the assistant" : "You turned off the assistant", b.on ? "Chat and voice questions are now answered." : "Chat and voice are off. Ranch tools still work by hand.");
    return json({ assistant: prefs.assistant });
  }

  const sm = path.match(/^\/api\/ranch\/settings\/agents\/([a-z_]{3,40})(\/snooze)?$/);
  if (sm && ((request.method === "PUT" && !sm[2]) || (request.method === "POST" && sm[2]))) {
    needSettingsWrite(ctx);
    const def = find(sm[1]!);
    if (!def) throw new AgentError("invalid_input", "Unknown agent.", 404);
    const b = await readJson();
    const prefs = await getPrefs(svc.store, ctx.tenantId);
    const p = agentPref(prefs, def.id);
    const changes: string[] = [];
    if (sm[2]) {
      const days = b.days;
      if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > 30) throw new AgentError("invalid_input", "days must be a whole number from 0 to 30 (0 ends the snooze).", 400);
      p.snooze_until = days ? new Date(now.getTime() + days * 86400_000).toISOString() : null;
      changes.push(days ? `snoozed until ${p.snooze_until!.slice(0, 10)}` : "snooze ended");
    } else {
      if (b.on !== undefined) {
        if (typeof b.on !== "boolean") throw new AgentError("invalid_input", "on must be true or false.", 400);
        if (b.on !== p.on) changes.push(b.on ? "turned on" : "turned off");
        p.on = b.on;
      }
      if (b.settings !== undefined) {
        const profile = await agentDeps(svc).profile(ctx);
        const clean = validateSettings(def.id, b.settings, profile, now);
        const before = (p.settings ?? {}) as Record<string, unknown>;
        const next = { ...before, ...clean } as Record<string, unknown>;
        for (const [k, v] of Object.entries(b.settings as Record<string, unknown>)) if (v === null) delete next[k];
        p.settings = next;
        const changed = settingWords(def.id, before, next, profile);
        if (changed.length) changes.push(changed.join("; "));
        else if (b.on === undefined) changes.push("settings saved, nothing changed");
      }
      if (!changes.length && b.on === undefined && b.settings === undefined) throw new AgentError("invalid_input", "Send on, settings, or both.", 400);
    }
    p.at = now.toISOString();
    p.by = ctx.userId;
    prefs.agents[def.id] = p;
    await savePrefs(svc.store, ctx.tenantId, prefs);
    if (changes.length) await logSetting(svc, ctx, `${def.title}: ${changes.join(", ")}`, p.on ? "It runs on your schedule and respects your settings." : "It is off and will not run. You can still do the same job by hand.");
    return json({ agent: { id: def.id, on: p.on, snooze_until: p.snooze_until, settings: effectiveSettings(await tenant(), prefs, def.id) } });
  }

  // ------------------------------------------------------------ activity log
  if (request.method === "GET" && path === "/api/ranch/activity") {
    const kind = url.searchParams.get("kind");
    if (kind && !KINDS.includes(kind as ActivityKind)) throw new AgentError("invalid_input", `kind must be one of ${KINDS.join(", ")}.`, 400);
    return json({ records: await listActivity(svc.store, ctx, { kind: (kind as ActivityKind) || undefined, limit: int(url.searchParams.get("limit"), 1, 200, 50) }) });
  }
  const am = path.match(/^\/api\/ranch\/activity\/([0-9a-f-]{36})$/);
  if (request.method === "GET" && am) {
    const r = await getActivity(svc.store, ctx, am[1]!);
    if (!r) throw new AgentError("invalid_input", "Unknown activity record.", 404);
    return json({ record: r });
  }

  // ------------------------------------------------------------ overrides
  if (request.method === "GET" && path === "/api/ranch/overrides") return json({ overrides: await listOverrides(svc.store, ctx.tenantId) });
  const im = path.match(/^\/api\/ranch\/items\/([a-z_]{3,40})\/([0-9a-f]{16})$/);
  if (request.method === "POST" && im) {
    needSettingsWrite(ctx);
    const def = find(im[1]!);
    if (!def) throw new AgentError("invalid_input", "Unknown agent.", 404);
    const b = await readJson();
    const rec = typeof b.activity_id === "string" ? await getActivity(svc.store, ctx, b.activity_id) : null;
    const item = rec?.ref?.agent === def.id ? rec.items?.find((i) => i.id === im[2]) : undefined;
    if (!rec || !item) throw new AgentError("invalid_input", "Unknown item. Send the activity_id of the record it came from.", 404);
    const v = validateOverride(b, now);
    const o = await setOverride(svc.store, ctx, def.id, item.id, item.text, v, now);
    const words = { dismiss: "dismissed", wrong: "marked wrong", correct: "corrected", snooze: "snoozed", restore: "restored" }[v.action];
    await recordActivity(svc.store, {
      tenant_id: ctx.tenantId,
      at: now.toISOString(),
      kind: "override",
      actor: "you",
      title: `You ${words} an item from ${def.title}`,
      outcome: v.action === "restore" ? "It will show again on later runs." : v.action === "correct" ? "Later runs show your correction with this item." : "Later runs leave it out and list it under skipped.",
      read: [],
      sources: [],
      rules: [`Item: ${item.text}`, ...(v.note ? [`Your note: ${v.note}`] : []), ...(v.until ? [`Until ${v.until.slice(0, 10)}.`] : [])],
      skipped: [],
      ref: { agent: def.id, run_id: rec.ref?.run_id },
    });
    // Show the new state on the record it came from.
    rec.items = rec.items!.map((i) => (i.id === item.id ? { ...i, status: v.action === "restore" ? "shown" : v.action === "correct" ? "corrected" : v.action, ...(v.note ? { note: v.note } : {}) } : i));
    await updateActivity(svc.store, rec);
    return json({ override: o, item: rec.items.find((i) => i.id === item.id) });
  }

  // ------------------------------------------------------------ by hand: lookups
  const dm = path.match(/^\/api\/ranch\/data\/([a-z][a-z0-9_]{2,63})$/);
  if (request.method === "POST" && dm) {
    if (!MANUAL_TOOL_VIEWS[dm[1]!]) throw new AgentError("unknown_tool", "Unknown lookup.", 404);
    if (!(await svc.rateLimiter.hit(`manualdata:${ctx.tenantId}`, 120, 60, now.getTime()))) throw new AgentError("rate_limited", "Too many lookups in a minute.", 429);
    const b = await readJson();
    const result = await svc.registry.execute(dm[1]!, b.arguments ?? {}, { ...ctx, client: "web-manual" }, svc.deps);
    return json({ ...result, citations: result.sources.map((s, i) => ({ ...s, cite: `S${i + 1}` })) });
  }

  // ------------------------------------------------------------ by hand: agent jobs
  const mm = path.match(/^\/api\/ranch\/manual\/([a-z_]{3,40})$/);
  if (request.method === "POST" && mm) {
    const def = find(mm[1]!);
    if (!def) throw new AgentError("invalid_input", "Unknown job.", 404);
    if (!(await svc.rateLimiter.hit(`manualjob:${ctx.tenantId}`, 60, 3600, now.getTime()))) throw new AgentError("rate_limited", "Too many jobs this hour.", 429);
    const b = await readJson();
    const profile = await agentDeps(svc).profile(ctx);
    // Settings for this one job; meeting_at may be in the past when building by hand.
    const raw = (b.settings ?? {}) as Record<string, unknown>;
    const { meeting_at: _m, deliver_to: _d, ...rest } = typeof raw === "object" && raw && !Array.isArray(raw) ? raw : {};
    const config = validateSettings(def.id, rest, profile, now);
    const run = await runAgent(def, ctx, agentDeps(svc), "by_hand", { config });
    if (url.searchParams.get("format") === "txt") {
      if (run.status !== "ok") throw new AgentError("invalid_input", run.reason ?? "Nothing to download.", 409);
      return file(`${run.title}\n\n${run.body}\n\n${sourcesFooter(run.citations ?? [])}\n`, `${def.id}-${now.toISOString().slice(0, 10)}.txt`, "text/plain");
    }
    let outbox_id: string | undefined;
    if (b.save_to_outbox === true && run.status === "ok" && def.id === "meeting_prep") {
      const t = await tenant();
      const c = t?.contacts?.[typeof config.contact_index === "number" ? config.contact_index : 0] as { name: string; organization: string; email?: string } | undefined;
      if (!c?.email) throw new AgentError("invalid_input", "No email is on file for that contact. Download the packet instead.", 409);
      outbox_id = (await createOutboxItem(svc.store, ctx.tenantId, def.id, run.id, { channel: "email", to: c.email, label: `${c.name}, ${c.organization}` }, run.title!, run.body!, run.citations ?? [], now)).id;
    }
    return json({ run: { ...run, footer: run.citations ? sourcesFooter(run.citations) : null }, ...(outbox_id ? { outbox_id } : {}) });
  }

  // ------------------------------------------------------------ exports
  if (request.method === "GET" && path.startsWith("/api/ranch/export/")) {
    if (!(await svc.rateLimiter.hit(`export:${ctx.tenantId}`, 60, 3600, now.getTime()))) throw new AgentError("rate_limited", "Too many exports this hour.", 429);
    const what = path.slice("/api/ranch/export/".length);
    const day = now.toISOString().slice(0, 10);
    if (what === "activity.csv") {
      const rows = await listActivity(svc.store, ctx, { limit: 200 });
      return file(
        csv(
          ["at", "kind", "who", "title", "outcome", "data read", "sources", "rules", "skipped"],
          rows.map((r) => [
            r.at,
            r.kind,
            r.actor,
            r.title,
            r.outcome,
            r.read.map((x) => `${x.title} (${x.detail})`),
            r.sources.map((s) => `${s.title}, ${s.publisher}, received ${s.received_at ?? "unknown"}`),
            r.rules,
            r.skipped.map((s) => `${s.what}: ${s.why}`),
          ]),
        ),
        `activity-${day}.csv`,
        "text/csv",
      );
    }
    if (what === "records.csv") {
      const keys = await svc.store.list(`obs:${ctx.tenantId}:`, 1000);
      const rows = (await Promise.all(keys.map((k) => svc.store.get<Record<string, unknown>>(k)))).filter((r): r is Record<string, unknown> => !!r);
      return file(
        csv(["id", "ranch_id", "species", "kind", "observed_at", "received_at", "lat", "lon", "notes", "shared"], rows.map((r) => [r.id, r.ranch_id, r.species, r.kind, r.observed_at, r.received_at, r.lat, r.lon, r.notes, r.share ? "yes" : "no"])),
        `your-records-${day}.csv`,
        "text/csv",
      );
    }
    if (what === "allotment-activity.csv") {
      const r = await svc.registry.execute(
        "allotment_wolf_activity",
        { ...(url.searchParams.get("allotment_id") ? { allotment_id: url.searchParams.get("allotment_id") } : {}), days: int(url.searchParams.get("days"), 1, 90, 30) },
        { ...ctx, client: "web-manual" },
        svc.deps,
      );
      return file(csv(ACTIVITY_HEADER, activityRows(r)), `allotment-activity-${day}.csv`, "text/csv");
    }
    if (what === "nearby-activity.csv") {
      const r = await svc.registry.execute(
        "recent_predator_activity",
        {
          ...(url.searchParams.get("ranch_id") ? { ranch_id: url.searchParams.get("ranch_id") } : {}),
          radius_miles: int(url.searchParams.get("radius_miles"), 1, 100, 25),
          days: int(url.searchParams.get("days"), 1, 90, 14),
          include_shared: true,
        },
        { ...ctx, client: "web-manual" },
        svc.deps,
      );
      return file(csv(ACTIVITY_HEADER, activityRows(r)), `nearby-activity-${day}.csv`, "text/csv");
    }
    const om = what.match(/^outbox\/([0-9a-f-]{36})\.txt$/);
    if (om) {
      const item = (await listOutbox(svc.store, ctx, now)).find((i) => i.id === om[1]);
      if (!item) throw new AgentError("invalid_input", "Unknown outbox item.", 404);
      return file(`To: ${item.delivery.label} <${item.delivery.to}>\nSubject: ${item.title}\n\n${item.body}\n\n${sourcesFooter(item.citations)}\n`, `outbox-${item.id.slice(0, 8)}.txt`, "text/plain");
    }
    throw new AgentError("invalid_input", "Unknown export.", 404);
  }

  return json({ error: "not_found" }, 404);
}
