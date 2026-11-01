// Rancher overrides on agent items. Each agent line that can be acted on has a
// stable key (for example the source record id); its item id is a short hash
// of that key. The rancher can dismiss an item, mark it wrong, add a
// correction, or snooze it. Later runs respect these: dismissed, wrong, and
// snoozed items are left out (and listed under "skipped"), and corrections are
// shown under the write-up in the rancher's own words.
import { sha256Hex } from "./auth";
import type { PrivateStore } from "./store";
import { AgentError, type AuthContext } from "./types";

export type OverrideAction = "dismiss" | "wrong" | "correct" | "snooze";
export const OVERRIDE_ACTIONS: OverrideAction[] = ["dismiss", "wrong", "correct", "snooze"];

export interface ItemOverride {
  item_id: string;
  agent: string;
  action: OverrideAction;
  /** The item text when the override was made, so the rancher can see what it was about. */
  text: string;
  note?: string;
  until?: string;
  at: string;
  by: string;
}

export interface AgentItem {
  /** Stable key, for example "pub|source|label|observed_at". Never shown. */
  key: string;
  /** The line as written, with [S#] markers. */
  text: string;
}

export const itemId = async (key: string) => (await sha256Hex(`item:${key}`)).slice(0, 16);
export const overrideKey = (tenant: string, agent: string, id: string) => `override:${tenant}:${agent}:${id}`;

export async function listOverrides(store: PrivateStore, tenant: string, agent?: string): Promise<ItemOverride[]> {
  const keys = await store.list(`override:${tenant}:${agent ? `${agent}:` : ""}`, 1000);
  const rows = await Promise.all(keys.map((k) => store.get<ItemOverride>(k)));
  return rows.filter((r): r is ItemOverride => !!r && !!r.action);
}

const NOTE_MAX = 300;

export function validateOverride(body: Record<string, unknown>, now: Date): { action: OverrideAction | "restore"; note?: string; until?: string } {
  const action = body.action;
  if (action === "restore") return { action };
  if (typeof action !== "string" || !OVERRIDE_ACTIONS.includes(action as OverrideAction))
    throw new AgentError("invalid_input", "action must be dismiss, wrong, correct, snooze, or restore.", 400);
  const out: { action: OverrideAction; note?: string; until?: string } = { action: action as OverrideAction };
  if (body.note !== undefined) {
    if (typeof body.note !== "string" || body.note.length > NOTE_MAX) throw new AgentError("invalid_input", `note must be text up to ${NOTE_MAX} characters.`, 400);
    const note = body.note.replace(/[\r\n\t]+/g, " ").trim();
    if (note) out.note = note;
  }
  if (action === "correct" && !out.note) throw new AgentError("invalid_input", "A correction needs a note saying what is right.", 400);
  if (action === "snooze") {
    const days = body.days === undefined ? 7 : body.days;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 90) throw new AgentError("invalid_input", "days must be a whole number from 1 to 90.", 400);
    out.until = new Date(now.getTime() + days * 86400_000).toISOString();
  }
  return out;
}

export async function setOverride(
  store: PrivateStore,
  ctx: AuthContext,
  agent: string,
  id: string,
  text: string,
  v: { action: OverrideAction | "restore"; note?: string; until?: string },
  now: Date,
): Promise<ItemOverride | null> {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new AgentError("invalid_input", "Unknown item.", 404);
  const key = overrideKey(ctx.tenantId, agent, id);
  if (v.action === "restore") {
    await store.put(key, null);
    return null;
  }
  const o: ItemOverride = { item_id: id, agent, action: v.action, text: text.slice(0, 500), at: now.toISOString(), by: ctx.userId, ...(v.note ? { note: v.note } : {}), ...(v.until ? { until: v.until } : {}) };
  await store.put(key, o, { expirationTtl: 400 * 86400 });
  return o;
}

export const OVERRIDE_WHY: Record<OverrideAction, string> = {
  dismiss: "You dismissed this item.",
  wrong: "You marked this item wrong.",
  correct: "You corrected this item.",
  snooze: "You snoozed this item.",
};

/** Split items into shown and hidden by the rancher's overrides. Corrections stay shown with the note. */
export async function applyOverrides(items: AgentItem[], overrides: ItemOverride[], now: Date) {
  const byId = new Map(overrides.map((o) => [o.item_id, o]));
  const shown: (AgentItem & { id: string; note?: string })[] = [];
  const hidden: (AgentItem & { id: string; override: ItemOverride })[] = [];
  for (const it of items) {
    const id = await itemId(it.key);
    const o = byId.get(id);
    if (!o || (o.action === "snooze" && o.until && Date.parse(o.until) <= now.getTime())) shown.push({ ...it, id });
    else if (o.action === "correct") shown.push({ ...it, id, note: o.note });
    else hidden.push({ ...it, id, override: o });
  }
  return { shown, hidden };
}
