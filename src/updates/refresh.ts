// Fetch official update sources into KV. Keep the last good copy when a
// source times out or fails. Public requests only read this cache.
import { UPDATE_SOURCES, type UpdateSource } from "../config/updates";
import { SOURCE_TIMEOUT_MS, withTimeout, type Env } from "../cache";
import { parseUpdateSource, type OfficialFact, type UpdateItem } from "./parse";

export const UPDATES_KEY = "updates:feed";

export interface UpdateSourceStatus {
  id: string;
  agency: string;
  state: "ok" | "unchanged" | "error" | "never";
  checked_at: string | null;
  item_count: number;
  error?: string;
}

export interface UpdatesFeed {
  generated_at: string;
  checked_at: string | null;
  received_at: string | null;
  state: "ok" | "error" | "never";
  sources: UpdateSourceStatus[];
  items: UpdateItem[];
  facts: OfficialFact[];
}

export function emptyUpdates(): UpdatesFeed {
  return {
    generated_at: new Date(0).toISOString(),
    checked_at: null,
    received_at: null,
    state: "never",
    sources: UPDATE_SOURCES.map((s) => ({ id: s.id, agency: s.agency, state: "never", checked_at: null, item_count: 0 })),
    items: [],
    facts: [],
  };
}

export function staticCountResults(): { facts: OfficialFact[]; items: UpdateItem[]; sources: UpdateSourceStatus[] } {
  const facts: OfficialFact[] = [];
  const items: UpdateItem[] = [];
  const sources: UpdateSourceStatus[] = [];
  for (const src of UPDATE_SOURCES) {
    if (src.type !== "static-count") continue;
    const parsed = parseUpdateSource(src, "");
    if (!parsed.facts.length) continue;
    facts.push(...parsed.facts);
    items.push(...parsed.items);
    sources.push({ id: src.id, agency: src.agency, state: "ok", checked_at: null, item_count: parsed.items.length });
  }
  return { facts, items, sources };
}

function sortItems(items: UpdateItem[]): UpdateItem[] {
  const sorted = [...items].sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  const seen = new Set<string>();
  return sorted.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}

/** Always attach recorded official counts, even when KV is empty or stale. */
export function withStaticCounts(feed: UpdatesFeed): UpdatesFeed {
  const recorded = staticCountResults();
  const ids = new Set(recorded.facts.map((f) => f.source_id));
  const facts = [...recorded.facts, ...feed.facts.filter((f) => !ids.has(f.source_id))];
  const items = sortItems([...feed.items.filter((i) => !ids.has(i.source_id)), ...recorded.items]);
  const sources = feed.sources.map((s) => {
    const rec = recorded.sources.find((x) => x.id === s.id);
    if (!rec) return s;
    return {
      ...s,
      state: s.state === "error" ? ("error" as const) : ("ok" as const),
      item_count: Math.max(s.item_count, rec.item_count),
    };
  });
  for (const rec of recorded.sources) {
    if (!sources.some((s) => s.id === rec.id)) sources.push({ ...rec, state: "ok" });
  }
  const order = new Map(UPDATE_SOURCES.map((s, i) => [s.id, i]));
  sources.sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
  const ok = sources.some((s) => s.state === "ok" || (s.state === "error" && s.item_count > 0)) || facts.length > 0;
  return { ...feed, facts, items, sources, state: ok ? (feed.state === "never" || feed.state === "ok" ? "ok" : feed.state) : feed.state };
}

/** True when live (fetched) sources have never been written to KV. */
export function updatesNeedRefresh(feed: { sources: UpdateSourceStatus[] }): boolean {
  return UPDATE_SOURCES.some((src) => {
    if (src.type === "static-count") return false;
    const s = feed.sources.find((x) => x.id === src.id);
    return !s || s.state === "never";
  });
}

export async function readUpdates(kv: KVNamespace, cacheTtl?: number): Promise<UpdatesFeed> {
  const stored = await kv.get<UpdatesFeed>(UPDATES_KEY, { type: "json", cacheTtl });
  return withStaticCounts(stored ?? emptyUpdates());
}

function previousFor(feed: UpdatesFeed, id: string): { items: UpdateItem[]; facts: OfficialFact[] } {
  return {
    items: feed.items.filter((i) => i.source_id === id),
    facts: feed.facts.filter((f) => f.source_id === id),
  };
}

function isDue(status: UpdateSourceStatus | undefined, src: UpdateSource, now: number): boolean {
  if (!status?.checked_at) return true;
  return now - Date.parse(status.checked_at) >= src.refreshMinutes * 60_000;
}

export async function fetchSourceBody(src: UpdateSource, fetchImpl: typeof fetch, userAgent?: string): Promise<string> {
  const headers: Record<string, string> = { "User-Agent": userAgent || "predator-watch-app" };
  if (src.type === "federal-register" || src.type === "csv-count") headers.Accept = "application/json, text/csv, text/plain, */*";
  else headers.Accept = "text/html, text/plain, */*;q=0.1";
  const res = await fetchImpl(src.url, { headers, signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function refreshUpdates(
  env: Env,
  opts: { fetch?: typeof fetch; now?: () => Date } = {},
): Promise<UpdatesFeed> {
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  const at = now();
  const atIso = at.toISOString();
  const previous = await readUpdates(env.LAYER_CACHE);
  const sources: UpdateSourceStatus[] = [];
  const items: UpdateItem[] = [];
  const facts: OfficialFact[] = [];

  for (const src of UPDATE_SOURCES) {
    const prevStatus = previous.sources.find((s) => s.id === src.id);
    const prev = previousFor(previous, src.id);
    if (!isDue(prevStatus, src, at.getTime()) && prevStatus && prevStatus.state !== "never") {
      sources.push(prevStatus);
      items.push(...prev.items);
      facts.push(...prev.facts);
      continue;
    }
    try {
      // Dated official figures are recorded from a published report, not parsed
      // from a live page, so there is nothing to fetch on the cron.
      if (src.type === "static-count") {
        const parsed = parseUpdateSource(src, "");
        if (!parsed.facts.length) throw new Error("official count is not recorded");
        sources.push({ id: src.id, agency: src.agency, state: "ok", checked_at: atIso, item_count: parsed.items.length });
        items.push(...parsed.items);
        facts.push(...parsed.facts);
        continue;
      }
      const body = await withTimeout(fetchSourceBody(src, fetchImpl, env.USER_AGENT), SOURCE_TIMEOUT_MS, src.id);
      const parsed = parseUpdateSource(src, body);
      if (src.type === "html-links" && parsed.items.length === 0) {
        throw new Error("no official links found");
      }
      sources.push({ id: src.id, agency: src.agency, state: "ok", checked_at: atIso, item_count: parsed.items.length });
      items.push(...parsed.items);
      facts.push(...parsed.facts);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (prev.items.length || prev.facts.length) {
        sources.push({
          id: src.id,
          agency: src.agency,
          state: "error",
          checked_at: prevStatus?.checked_at ?? null,
          item_count: prev.items.length,
          error: message,
        });
        items.push(...prev.items);
        facts.push(...prev.facts);
      } else {
        sources.push({ id: src.id, agency: src.agency, state: "error", checked_at: atIso, item_count: 0, error: message });
      }
    }
  }

  const unique = sortItems(items);
  const ok = sources.some((s) => s.state === "ok" || (s.state === "error" && s.item_count > 0));
  const received_at = unique.length !== previous.items.length || JSON.stringify(unique) !== JSON.stringify(previous.items) ? atIso : previous.received_at;
  const feed = withStaticCounts({
    generated_at: atIso,
    checked_at: atIso,
    received_at,
    state: ok ? "ok" : "error",
    sources,
    items: unique,
    facts,
  });
  await env.LAYER_CACHE.put(UPDATES_KEY, JSON.stringify(feed));
  return feed;
}
