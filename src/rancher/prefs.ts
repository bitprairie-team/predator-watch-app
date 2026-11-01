// Per-account preferences. The assistant and every background agent are off
// until the rancher turns them on. Nothing here is set by an agent or by the
// assistant; only the rancher, in Settings, with the settings:write scope.
//
//   prefs:<tenant>  { assistant: {on, at, by}, agents: {<id>: {on, at, by, settings, snooze_until}} }
//
// The tenant record's `agents.<id>` block (set by the owner) only supplies
// default thresholds. Its `enabled` flag is ignored.
import type { PrivateStore } from "../agents/store";
import { AgentError, type AuthContext } from "../agents/types";
import type { AgentProfile, AgentSettings } from "./background-agents";
import type { TenantRecord } from "./model";

export interface Toggle {
  on: boolean;
  at: string | null;
  by: string | null;
}

export interface AgentPref extends Toggle {
  settings: Partial<AgentSettings>;
  snooze_until: string | null;
}

export interface RancherPrefs {
  assistant: Toggle;
  agents: Record<string, AgentPref>;
}

export const prefsKey = (tenant: string) => `prefs:${tenant}`;

const OFF: Toggle = { on: false, at: null, by: null };

export async function getPrefs(store: PrivateStore, tenant: string): Promise<RancherPrefs> {
  const p = await store.get<Partial<RancherPrefs>>(prefsKey(tenant));
  return { assistant: { ...OFF, ...(p?.assistant ?? {}) }, agents: { ...(p?.agents ?? {}) } };
}

export function agentPref(p: RancherPrefs, id: string): AgentPref {
  return { ...OFF, settings: {}, snooze_until: null, ...(p.agents[id] ?? {}) };
}

/** Saved settings for an agent: owner defaults, then the rancher's own. Never includes `enabled`. */
export function effectiveSettings(t: TenantRecord | null, p: RancherPrefs, id: string): Record<string, unknown> {
  const { enabled: _ignored, ...defaults } = (t?.agents?.[id] ?? {}) as AgentSettings;
  return { ...defaults, ...agentPref(p, id).settings };
}

export async function assistantOn(store: PrivateStore, tenant: string): Promise<boolean> {
  return (await getPrefs(store, tenant)).assistant.on === true;
}

export function needSettingsWrite(ctx: AuthContext) {
  if (!ctx.scopes.includes("settings:write")) throw new AgentError("forbidden", "Changing settings needs the settings:write permission on your access key.", 403);
  if (!ctx.client.startsWith("web")) throw new AgentError("forbidden", "Settings can only be changed by a person in the web app.", 403);
}

const EMAIL = /^[^\s@<>"]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/i;
const PHONE = /^\+?[0-9 ().-]{7,20}$/;

function int(v: unknown, name: string, lo: number, hi: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw new AgentError("invalid_input", `${name} must be a whole number from ${lo} to ${hi}.`, 400);
  return v;
}

/** Which settings each agent accepts, with their ranges. Shared with the UI through GET /api/ranch/settings. */
export const SETTING_RULES: Record<string, Record<string, { label: string; min?: number; max?: number; default?: unknown; unit?: string }>> = {
  morning_digest: {
    hour_utc: { label: "Hour to write it (UTC)", min: 0, max: 23, default: 14 },
    days: { label: "Days to cover", min: 1, max: 7, default: 1, unit: "days" },
    areas: { label: "Areas to cover" },
    deliver_to: { label: "Also send it to (waits for your approval; sending is Planned)" },
  },
  new_report_alert: {
    radius_miles: { label: "Alert distance from each ranch", min: 1, max: 50, default: 10, unit: "miles" },
    interval_minutes: { label: "Check every", min: 15, max: 1440, default: 60, unit: "minutes" },
    days: { label: "Look back", min: 1, max: 14, default: 3, unit: "days" },
    areas: { label: "Alert areas" },
    deliver_to: { label: "Also send it to (waits for your approval; sending is Planned)" },
  },
  meeting_prep: {
    meeting_at: { label: "Meeting date and time" },
    contact_index: { label: "Agency contact", min: 0, max: 20, default: 0 },
    days: { label: "Days to cover", min: 7, max: 90, default: 30, unit: "days" },
    topics: { label: "Topics you want to raise" },
    areas: { label: "Areas to cover" },
  },
};

/** Validate the settings a rancher sends for one agent. Unknown keys are refused, not ignored. */
export function validateSettings(agent: string, input: unknown, profile: AgentProfile, now: Date): Partial<AgentSettings> {
  const rules = SETTING_RULES[agent];
  if (!rules) throw new AgentError("invalid_input", "Unknown agent.", 404);
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new AgentError("invalid_input", "settings must be an object.", 400);
  const out: Partial<AgentSettings> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const rule = rules[k];
    if (!rule) throw new AgentError("invalid_input", `${k} is not a setting for this agent.`, 400);
    if (v === null) continue; // null clears the setting back to the default
    switch (k) {
      case "hour_utc":
      case "radius_miles":
      case "interval_minutes":
      case "days":
      case "contact_index":
        out[k] = int(v, k, rule.min!, rule.max!);
        break;
      case "areas": {
        const known = new Set(profile.ranches.flatMap((r) => [r.id, ...r.allotments.map((a) => a.id)]));
        if (!Array.isArray(v) || v.length > 50 || !v.every((x) => typeof x === "string" && known.has(x)))
          throw new AgentError("invalid_input", "areas must be a list of your ranch or allotment ids.", 400);
        out.areas = [...new Set(v as string[])];
        break;
      }
      case "deliver_to": {
        const d = v as { channel?: unknown; to?: unknown };
        const to = typeof d?.to === "string" ? d.to.trim() : "";
        if (d?.channel === "email" && EMAIL.test(to)) out.deliver_to = { channel: "email", to };
        else if (d?.channel === "sms" && PHONE.test(to)) out.deliver_to = { channel: "sms", to };
        else throw new AgentError("invalid_input", "deliver_to needs channel email with an email address, or sms with a phone number.", 400);
        break;
      }
      case "meeting_at": {
        const t = typeof v === "string" ? Date.parse(v) : NaN;
        if (!Number.isFinite(t) || t < now.getTime() - 86400_000 || t > now.getTime() + 366 * 86400_000)
          throw new AgentError("invalid_input", "meeting_at must be a date and time within the next year.", 400);
        out.meeting_at = new Date(t).toISOString();
        break;
      }
      case "topics": {
        if (!Array.isArray(v) || v.length > 5 || !v.every((x) => typeof x === "string" && x.length <= 200))
          throw new AgentError("invalid_input", "topics must be up to 5 items of up to 200 characters each.", 400);
        out.topics = (v as string[]).map((x) => x.replace(/[\r\n\t]+/g, " ").trim()).filter(Boolean);
        break;
      }
    }
  }
  return out;
}

export async function savePrefs(store: PrivateStore, tenant: string, p: RancherPrefs): Promise<void> {
  await store.put(prefsKey(tenant), p);
}
