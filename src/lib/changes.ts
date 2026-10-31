// "What changed since the last refresh": a compact diff between the previous
// and the new copy of a source, kept in the source's status record so it costs
// no extra KV writes.
import type { NormalizedFeature } from "../schema";
import { fnv1a } from "./hash";

export interface ChangeItem {
  id: string;
  label: string;
}

export interface ChangeEntry {
  /** When this map received the new copy. */
  at: string;
  added: number;
  removed: number;
  modified: number;
  /** Up to MAX_LISTED examples of each kind. */
  added_items: ChangeItem[];
  removed_items: ChangeItem[];
  modified_items: ChangeItem[];
}

export const MAX_LISTED = 20;
export const MAX_ENTRIES = 10;

/** Content fingerprint that ignores our own receive time. */
function fingerprint(f: NormalizedFeature): string {
  const { received_at: _r, ...rest } = f.properties;
  return fnv1a(JSON.stringify([f.geometry, rest]));
}

const item = (f: NormalizedFeature): ChangeItem => ({ id: f.id, label: f.properties.label });

export function diffFeatures(prev: NormalizedFeature[] | null, next: NormalizedFeature[], at: string): ChangeEntry | null {
  if (!prev) return null; // first load: nothing to compare against
  const before = new Map(prev.map((f) => [f.id, f]));
  const added: NormalizedFeature[] = [];
  const modified: NormalizedFeature[] = [];
  for (const f of next) {
    const old = before.get(f.id);
    if (!old) added.push(f);
    else if (fingerprint(old) !== fingerprint(f)) modified.push(f);
    before.delete(f.id);
  }
  const removed = [...before.values()];
  if (!added.length && !removed.length && !modified.length) return null;
  return {
    at,
    added: added.length,
    removed: removed.length,
    modified: modified.length,
    added_items: added.slice(0, MAX_LISTED).map(item),
    removed_items: removed.slice(0, MAX_LISTED).map(item),
    modified_items: modified.slice(0, MAX_LISTED).map(item),
  };
}

export function pushChange(log: ChangeEntry[] | undefined, entry: ChangeEntry | null): ChangeEntry[] {
  const out = [...(log ?? [])];
  if (entry) out.unshift(entry);
  return out.slice(0, MAX_ENTRIES);
}
