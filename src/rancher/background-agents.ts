// The rancher's background agents. Each one is deterministic: it calls a few
// allowed tools and writes a short cited summary from their data. No model
// writes the text, so tool data can't steer it and numbers can't be invented.
//
//   morning_digest     activity on each allotment since yesterday, plus fire and weather
//   new_report_alert   new agency or shared reports near the rancher's pastures
//   meeting_prep       a packet for a meeting with the agency contact on file
//
// Anything addressed outside (email or text) goes to the outbox for the
// rancher to approve; sending itself is Planned.
import type { AgentDefinition, AgentOutput, AgentRunContext, Delivery } from "../agents/background";
import type { Citation } from "../agents/citations";
import type { SourceRef, ToolResult } from "../agents/types";
import { sanitizeText } from "../guardrails/sanitize";

export interface AgentProfile {
  tenantName: string;
  ranches: { id: string; name: string; allotments: { id: string; name: string }[] }[];
}

/** Agent settings stored on the tenant record under `agents.<id>`. */
export interface AgentSettings {
  enabled: boolean;
  /** UTC hour for the morning digest (default 14, about 6 or 7 in the morning Pacific). */
  hour_utc?: number;
  /** Minutes between new-report checks (default 60, at least 15). */
  interval_minutes?: number;
  radius_miles?: number;
  days?: number;
  deliver_to?: { channel: "email" | "sms"; to: string };
  contact_index?: number;
  meeting_at?: string;
  topics?: string[];
}

// ------------------------------------------------------------------ helpers

/** Collects sources across tool calls and numbers them S1, S2, ... once each. */
class Sources {
  readonly list: Citation[] = [];
  private readonly byKey = new Map<string, Citation>();
  add(sources: SourceRef[]): string {
    const marks: string[] = [];
    for (const s of sources) {
      const key = `${s.kind}|${s.id}|${s.title}`;
      let c = this.byKey.get(key);
      if (!c) {
        c = { ...s, cite: `S${this.list.length + 1}` };
        this.byKey.set(key, c);
        this.list.push(c);
      }
      if (!marks.includes(`[${c.cite}]`)) marks.push(`[${c.cite}]`);
    }
    return marks.join(" ");
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "an unknown date");
const stamp = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "an unknown time");
const num = (v: unknown, lo: number, hi: number, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt);

function delivery(config: Record<string, unknown>, label: string): Delivery | undefined {
  const d = config.deliver_to as { channel?: unknown; to?: unknown } | undefined;
  if (!d || (d.channel !== "email" && d.channel !== "sms") || typeof d.to !== "string" || !d.to.trim() || d.to.length > 200) return undefined;
  return { channel: d.channel, to: d.to.trim(), label };
}

interface Row {
  label?: string;
  source_id?: string;
  observed_at?: string | null;
  distance_miles?: number;
}
interface Cell {
  cell_id: string;
  report_count: number;
  latest_observed_on: string;
  distance_miles?: number;
}
interface Activity {
  public_layers: Row[];
  your_records: { id: string; kind: string; species: string; observed_at: string; notes?: string }[];
  shared_cells: Cell[];
  gaps: string[];
}

const NOT_PROOF = "This covers only the layers and records listed here; it is not proof that nothing else happened.";

// ------------------------------------------------------------------ morning digest

export const morningDigest: AgentDefinition<AgentProfile> = {
  id: "morning_digest",
  title: "Morning activity digest",
  description: "Each morning: wolf activity on each of your allotments since yesterday, and fire and weather alerts near your ranches, with sources.",
  tools: ["allotment_wolf_activity", "fire_weather_alerts", "data_freshness"],
  scopes: ["activity:read", "alerts:read", "docs:read"],
  limits: { runsPerDay: 3, maxToolCalls: 12, maxCostUnits: 12 },
  due(now, last, config) {
    const hour = num(config.hour_utc, 0, 23, 14);
    if (now.getUTCHours() < hour) return false;
    return !last || last.slice(0, 10) !== now.toISOString().slice(0, 10);
  },
  async run(r) {
    const days = num(r.config.days, 1, 7, 1);
    const allotments = r.profile.ranches.flatMap((x) => x.allotments).slice(0, 5);
    if (!allotments.length && !r.profile.ranches.length) return { skip: "No ranches or allotments are on file.", title: "", body: "", citations: [] };
    const src = new Sources();
    // Dates go in the title: a sentence with a number and no source is dropped by the output check.
    const lines: string[] = [];
    for (const al of allotments) {
      const res = await r.tool("allotment_wolf_activity", { allotment_id: al.id, days });
      const d = res.data as Activity;
      const marks = src.add(res.sources);
      if (res.unknown) lines.push(`${al.name}: no wolf activity in the data I can read for the last ${plural(days, "day")} ${marks}.`);
      else
        lines.push(
          `${al.name}, last ${plural(days, "day")}: ${plural(d.public_layers.length, "agency layer item")}, ${plural(d.your_records.length, "of your records", "of your records")}, ${plural(d.shared_cells.length, "shared report cell")} ${marks}.`,
        );
      for (const row of d.public_layers.slice(0, 3)) lines.push(`- ${row.label ?? "Agency item"}, observed ${day(row.observed_at)} ${marks}.`);
      for (const g of d.gaps) lines.push(`- Data note: ${g}`);
    }
    for (const ranch of r.profile.ranches.slice(0, 3)) {
      const res = await r.tool("fire_weather_alerts", { ranch_id: ranch.id, radius_miles: 50 });
      const d = res.data as { alerts: Row[]; gaps: string[] };
      const marks = src.add(res.sources);
      if (res.unknown) lines.push(`Fire and weather near ${ranch.name}: ${res.unknown}`);
      else if (!d.alerts.length) lines.push(`Fire and weather within 50 miles of ${ranch.name}: no active alerts in the layers ${marks}.`);
      else lines.push(`Fire and weather within 50 miles of ${ranch.name}: ${d.alerts.slice(0, 3).map((a) => a.label).join("; ")} ${marks}.`);
    }
    const fresh = await r.tool("data_freshness", {});
    const layers = (fresh.data as { layers: { name: string; publisher: string; state: string; received_at: string | null }[] }).layers;
    const stale = layers.filter((l) => l.state !== "ok" || !l.received_at || r.now.getTime() - Date.parse(l.received_at) > 2 * 86400_000);
    if (stale.length) {
      const marks = src.add(fresh.sources.filter((s) => stale.some((l) => l.name === s.title)));
      for (const l of stale) lines.push(`Data note: ${l.name} (${l.publisher}) was last received ${stamp(l.received_at)} ${marks}.`);
    }
    lines.push(NOT_PROOF);
    return { title: `Morning digest, ${day(r.now.toISOString())}`, body: lines.join("\n"), citations: src.list, delivery: delivery(r.config, "You") };
  },
};

// ------------------------------------------------------------------ new report alert

interface AlertState {
  seen: string[];
}

export const newReportAlert: AgentDefinition<AgentProfile> = {
  id: "new_report_alert",
  title: "New wolf report alert",
  description: "Checks for new agency layer items and shared rancher report cells near your ranches and inside your allotments, and tells you only about ones you haven't been told about.",
  tools: ["recent_predator_activity", "allotment_wolf_activity"],
  scopes: ["activity:read"],
  limits: { runsPerDay: 100, maxToolCalls: 10, maxCostUnits: 10 },
  due(now, last, config) {
    const every = num(config.interval_minutes, 15, 1440, 60);
    return !last || now.getTime() - Date.parse(last) >= every * 60_000 - 30_000;
  },
  async run(r) {
    const radius = num(r.config.radius_miles, 1, 50, 10);
    const state = (await r.state.get<AlertState>()) ?? { seen: [] };
    const seen = new Set(state.seen);
    const src = new Sources();
    const fresh: string[] = [];
    const add = (key: string, line: (marks: string) => string, sources: SourceRef[]) => {
      if (seen.has(key)) return;
      seen.add(key);
      fresh.push(line(src.add(sources)));
    };
    const pick = (res: ToolResult, kind: string) => res.sources.filter((s) => s.kind === kind);
    for (const ranch of r.profile.ranches.slice(0, 3)) {
      const res = await r.tool("recent_predator_activity", { ranch_id: ranch.id, radius_miles: radius, days: 3, include_shared: true });
      const d = res.data as Activity;
      for (const row of d.public_layers)
        add(`pub|${row.source_id}|${row.label}|${row.observed_at}`, (m) => `- ${row.label ?? "Agency item"}, observed ${day(row.observed_at)}, about ${row.distance_miles} miles from ${ranch.name} ${m}.`, pick(res, "public-layer"));
      for (const c of d.shared_cells)
        add(`cell|${c.cell_id}|${c.latest_observed_on}|${c.report_count}`, (m) => `- A shared rancher report cell about ${c.distance_miles} miles from ${ranch.name}, latest report ${c.latest_observed_on} (generalized and delayed) ${m}.`, pick(res, "shared-data"));
    }
    for (const al of r.profile.ranches.flatMap((x) => x.allotments).slice(0, 5)) {
      const res = await r.tool("allotment_wolf_activity", { allotment_id: al.id, days: 3 });
      const d = res.data as Activity;
      for (const row of d.public_layers)
        add(`pub|${row.source_id}|${row.label}|${row.observed_at}`, (m) => `- ${row.label ?? "Agency item"} in or touching the ${al.name} allotment, observed ${day(row.observed_at)} ${m}.`, pick(res, "public-layer"));
    }
    await r.state.put({ seen: [...seen].slice(-1000) } satisfies AlertState);
    if (!fresh.length) return { skip: "No new reports since the last check.", title: "", body: "", citations: [] };
    const body = [`New wolf activity near your pastures (${plural(fresh.length, "new item")}):`, ...fresh, NOT_PROOF].join("\n");
    return { title: `New wolf report near your pastures, ${day(r.now.toISOString())}`, body, citations: src.list, delivery: delivery(r.config, "You") };
  },
};

// ------------------------------------------------------------------ meeting prep

export const meetingPrep: AgentDefinition<AgentProfile> = {
  id: "meeting_prep",
  title: "Meeting prep packet",
  description: "A packet for a meeting with your agency contact: your own records, agency layer activity on your allotments, shared reports (generalized), data limits, and the topics you want to raise. Sent only if you approve it.",
  tools: ["agency_contacts_and_reporting", "recent_predator_activity", "allotment_wolf_activity", "data_freshness"],
  scopes: ["directory:read", "activity:read", "docs:read"],
  limits: { runsPerDay: 5, maxToolCalls: 12, maxCostUnits: 12 },
  due(now, last, config) {
    if (typeof config.meeting_at !== "string") return false;
    const meeting = Date.parse(config.meeting_at);
    if (!Number.isFinite(meeting) || meeting < now.getTime() || meeting - now.getTime() > 86400_000) return false;
    return !last || Date.parse(last) < meeting - 86400_000;
  },
  async run(r) {
    const days = num(r.config.days, 7, 90, 30);
    const src = new Sources();
    const contacts = await r.tool("agency_contacts_and_reporting", { topic: "depredation" });
    const list = (contacts.data as { contacts: { role: string; name: string; organization: string; email?: string }[] }).contacts;
    const contact = list[num(r.config.contact_index, 0, 20, 0)];
    const lines: string[] = [];
    if (contact) lines.push(`Meeting prep packet for ${contact.name} (${contact.role}, ${contact.organization}) ${src.add(contacts.sources.slice(0, 1))}.`);
    else lines.push("Meeting prep packet. No agency contact is on file, so this packet is for your own use.");
    lines.push(`Prepared for ${r.profile.tenantName}. Covers the last ${plural(days, "day")}.`);

    lines.push("", "Your records:");
    let ownCount = 0;
    for (const ranch of r.profile.ranches.slice(0, 3)) {
      const res = await r.tool("recent_predator_activity", { ranch_id: ranch.id, radius_miles: 25, days, include_shared: true });
      const d = res.data as Activity;
      const ownMarks = src.add(res.sources.filter((s) => s.kind === "tenant-data"));
      for (const o of d.your_records.slice(0, 20)) {
        ownCount++;
        const note = o.notes ? `: "${sanitizeText(o.notes).text.slice(0, 160)}"` : "";
        lines.push(`- ${day(o.observed_at)}, ${o.species} ${o.kind} near ${ranch.name}${note} ${ownMarks}.`);
      }
      if (d.shared_cells.length)
        lines.push(`Shared rancher reports within 25 miles of ${ranch.name}: ${plural(d.shared_cells.length, "generalized cell")}, no names or exact places ${src.add(res.sources.filter((s) => s.kind === "shared-data"))}.`);
      for (const g of d.gaps) lines.push(`- Data note: ${g}`);
    }
    if (!ownCount) lines.push("- None of your records fall in this window.");

    lines.push("", "Agency layer activity on your allotments:");
    for (const al of r.profile.ranches.flatMap((x) => x.allotments).slice(0, 5)) {
      const res = await r.tool("allotment_wolf_activity", { allotment_id: al.id, days });
      const d = res.data as Activity;
      const marks = src.add(res.sources.filter((s) => s.kind === "public-layer"));
      lines.push(d.public_layers.length ? `- ${al.name}: ${plural(d.public_layers.length, "agency layer item")} ${marks}.` : `- ${al.name}: none in the layers I can read.`);
    }

    const fresh = await r.tool("data_freshness", {});
    const layers = (fresh.data as { layers: { name: string; publisher: string; received_at: string | null; precision: string }[] }).layers;
    lines.push("", "Data sources and limits:");
    for (const l of layers.slice(0, 8)) {
      const m = src.add(fresh.sources.filter((s) => s.title === l.name));
      lines.push(`- ${l.name} (${l.publisher}): last received ${stamp(l.received_at)} ${m}. Precision: ${l.precision} ${m}.`);
    }
    lines.push(`- ${NOT_PROOF}`);

    const out: AgentOutput = { title: `${contact ? `Meeting packet for ${contact.name}` : "Meeting packet"}, ${day(r.now.toISOString())}`, body: lines.join("\n"), citations: src.list };
    const topics = Array.isArray(r.config.topics) ? r.config.topics.filter((t): t is string => typeof t === "string").slice(0, 5) : [];
    if (topics.length) out.body += `\n\nTopics you want to raise (your words):\n${topics.map((t) => `- ${sanitizeText(t.slice(0, 200)).text}`).join("\n")}`;
    if (contact?.email) out.delivery = { channel: "email", to: contact.email, label: `${contact.name}, ${contact.organization}` };
    return out;
  },
};

export const RANCHER_AGENTS: AgentDefinition<AgentProfile>[] = [morningDigest, newReportAlert, meetingPrep];

export type { AgentRunContext };
