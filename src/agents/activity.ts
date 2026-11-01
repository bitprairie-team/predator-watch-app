// "What I did" records. Every assistant answer or decline, every agent run,
// every job the rancher builds by hand, and every setting or override change
// gets one plain record: what data was read, which sources and when they were
// received, which rules were applied, and what was skipped or declined and why.
// The rancher browses these in the activity log.
import type { Citation } from "./citations";
import type { PrivateStore } from "./store";
import type { AuthContext } from "./types";

export type ActivityKind = "answer" | "decline" | "agent_run" | "manual" | "setting" | "override" | "outbox";

export interface ActivityRead {
  tool: string;
  /** Plain name of the data, for example "Allotment wolf activity". */
  title: string;
  /** Plain description of what was asked for, with ids replaced by names when known. */
  detail: string;
}

export interface ActivitySource {
  cite?: string;
  title: string;
  publisher: string;
  url: string | null;
  observed_at: string | null;
  received_at: string | null;
}

export interface ActivityRecord {
  id: string;
  tenant_id: string;
  at: string;
  kind: ActivityKind;
  /** Who did it: "you", "assistant", or "agent:<id>". */
  actor: string;
  title: string;
  /** One or two plain sentences: the result. */
  outcome: string;
  read: ActivityRead[];
  sources: ActivitySource[];
  rules: string[];
  skipped: { what: string; why: string }[];
  /** Items the rancher can dismiss, correct, mark wrong, or snooze. */
  items?: { id: string; text: string; status: string; note?: string }[];
  ref?: { agent?: string; run_id?: string; outbox_id?: string };
}

const TTL = 400 * 86400;
const rev = (iso: string) => (9_999_999_999_999 - Date.parse(iso)).toString().padStart(13, "0");
export const activityKey = (tenant: string, at: string, id: string) => `activity:${tenant}:${rev(at)}:${id}`;
const activityIndexKey = (tenant: string, id: string) => `activityid:${tenant}:${id}`;

export async function recordActivity(store: PrivateStore, rec: Omit<ActivityRecord, "id"> & { id?: string }): Promise<ActivityRecord> {
  const full: ActivityRecord = { ...rec, id: rec.id ?? crypto.randomUUID() };
  const key = activityKey(full.tenant_id, full.at, full.id);
  await store.put(key, full, { expirationTtl: TTL });
  await store.put(activityIndexKey(full.tenant_id, full.id), key, { expirationTtl: TTL });
  return full;
}

export async function listActivity(store: PrivateStore, ctx: AuthContext, o: { kind?: ActivityKind; limit?: number } = {}): Promise<ActivityRecord[]> {
  const limit = Math.min(200, Math.max(1, o.limit ?? 50));
  const keys = await store.list(`activity:${ctx.tenantId}:`, o.kind ? 1000 : limit);
  const out: ActivityRecord[] = [];
  for (const k of keys) {
    const r = await store.get<ActivityRecord>(k);
    if (!r || r.tenant_id !== ctx.tenantId) continue;
    if (o.kind && r.kind !== o.kind) continue;
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

export async function getActivity(store: PrivateStore, ctx: AuthContext, id: string): Promise<ActivityRecord | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const key = await store.get<string>(activityIndexKey(ctx.tenantId, id));
  if (!key) return null;
  const r = await store.get<ActivityRecord>(key);
  return r && r.tenant_id === ctx.tenantId ? r : null;
}

export async function updateActivity(store: PrivateStore, rec: ActivityRecord): Promise<void> {
  await store.put(activityKey(rec.tenant_id, rec.at, rec.id), rec, { expirationTtl: TTL });
}

/** Plain words for an argument list, for example "ranch Home place, within 10 miles, last 3 days". */
export function describeArgs(args: Record<string, unknown>, names: Record<string, string> = {}): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
    const name = typeof v === "string" ? (names[v] ?? v) : v;
    switch (k) {
      case "ranch_id":
        parts.push(`ranch ${name}`);
        break;
      case "allotment_id":
        parts.push(`allotment ${name}`);
        break;
      case "radius_miles":
        parts.push(`within ${v} miles`);
        break;
      case "days":
        parts.push(`last ${v} ${v === 1 ? "day" : "days"}`);
        break;
      case "include_shared":
        parts.push(v ? "sharing group reports included" : "your own records only");
        break;
      case "topic":
        parts.push(`topic ${String(v).replace(/[_-]/g, " ")}`);
        break;
      case "hour_utc":
        parts.push(`written at ${String(v).padStart(2, "0")}:00 UTC`);
        break;
      case "interval_minutes":
        parts.push(`checks every ${v} minutes`);
        break;
      case "areas":
        parts.push(`only ${(v as string[]).map((x) => names[x] ?? x).join(", ")}`);
        break;
      case "topics":
        parts.push(`${(v as string[]).length} ${(v as string[]).length === 1 ? "topic" : "topics"} of yours`);
        break;
      case "contact_index":
        parts.push(`contact ${Number(v) + 1} on file`);
        break;
      case "deliver_to":
        parts.push(`a copy to ${(v as { to?: string }).to ?? "your contact"} after you approve`);
        break;
      default:
        parts.push(`${k.replace(/_/g, " ")} ${Array.isArray(v) ? v.join(", ") : String(name)}`);
    }
  }
  return parts.length ? parts.join(", ") : "no filters";
}

export const sourcesOf = (citations: Citation[] | undefined): ActivitySource[] =>
  (citations ?? []).map((c) => ({ cite: c.cite, title: c.title, publisher: c.publisher, url: c.url, observed_at: c.observed_at, received_at: c.received_at }));

/** Plain rule text for each output check that changed something. */
export const ISSUE_RULES: Record<string, string> = {
  coordinates: "Held back exact coordinates that were not from your own records.",
  ungrounded: "Left out sentences that had no source behind them.",
  invented_number: "Left out sentences with numbers that were not in the data.",
  link: "Removed links that did not come from a source.",
  opinion: "Stopped wording that took a side on a contested topic.",
  legal_determination: "Stopped wording that read as a legal ruling.",
  dosage: "Stopped wording that gave a drug dose.",
  lethal_instructions: "Stopped instructions for killing animals.",
  prompt_leak: "Stopped text that repeated internal instructions.",
};

export const issueRules = (issues: readonly string[] | undefined): string[] => (issues ?? []).map((i) => ISSUE_RULES[i] ?? `Output check: ${i.replace(/_/g, " ")}.`);
