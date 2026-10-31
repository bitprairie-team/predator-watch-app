// KV-backed cache of normalized GeoJSON plus per-source status, and the
// refresh logic used by both the Cron Trigger and on-demand requests.
import type { FetchContext, SourceAdapter } from "./adapters/types";
import { publicInfo, type Registry } from "./registry";
import type { NormalizedCollection, NormalizedFeature, SourceStatus } from "./schema";
import cdfwSample from "./fixtures/cdfw-wolf-bins.sample.json";

export interface Env {
  LAYER_CACHE: KVNamespace;
  ASSETS?: Fetcher;
  ARCGIS_API_KEY?: string;
  USER_AGENT?: string;
}

interface StoredStatus extends SourceStatus {
  source_updated_ms: number | null;
  validator: string | null;
  /** Hash of the source config; a config change forces a full re-fetch. */
  config_hash?: string;
}

/** Small, stable string hash (FNV-1a) of a source config. */
export function configHash(config: unknown): string {
  const str = JSON.stringify(config);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Bundled samples used only when a source has never loaded and the network fails. */
const FIXTURES: Record<string, { url: string; body: unknown; lastModified: string }> = {
  "cdfw-collared-wolf-cells": {
    url: "https://storage.googleapis.com/cdfw-wolf-tracker/wolf_bins.geojson",
    body: cdfwSample,
    lastModified: "Sat, 31 Oct 2026 19:00:43 GMT",
  },
};

/** KV values are limited to 25 MiB; stay well under it. */
export const MAX_STORED_BYTES = 20 * 1024 * 1024;

const dataKey = (id: string) => `data:${id}`;
const statusKey = (id: string) => `status:${id}`;

export function emptyStatus(id: string): StoredStatus {
  return {
    source_id: id,
    state: "never",
    checked_at: null,
    received_at: null,
    source_updated_at: null,
    source_updated_ms: null,
    feature_count: 0,
    validator: null,
  };
}

export async function readStatus(kv: KVNamespace, id: string): Promise<StoredStatus> {
  return (await kv.get<StoredStatus>(statusKey(id), "json")) ?? emptyStatus(id);
}

export function publicStatus(s: StoredStatus): SourceStatus {
  const { source_updated_ms: _m, validator: _v, config_hash: _h, ...rest } = s;
  return rest;
}

export async function readData(kv: KVNamespace, id: string): Promise<NormalizedFeature[] | null> {
  return kv.get<NormalizedFeature[]>(dataKey(id), "json");
}

function isDue(status: StoredStatus, refreshMinutes: number, now: Date): boolean {
  if (!status.checked_at || status.state === "never" || status.state === "fixture") return true;
  const last = Date.parse(status.checked_at);
  return !Number.isFinite(last) || now.getTime() - last >= refreshMinutes * 60_000 - 30_000;
}

export interface RefreshOptions {
  force?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export async function refreshSource(
  adapter: SourceAdapter,
  env: Env,
  opts: RefreshOptions = {},
): Promise<StoredStatus> {
  const kv = env.LAYER_CACHE;
  const now = opts.now ?? (() => new Date());
  const id = adapter.config.id;
  const status = await readStatus(kv, id);
  const hash = configHash(adapter.config);
  const configChanged = status.config_hash !== undefined && status.config_hash !== hash;
  if (!opts.force && !configChanged && !isDue(status, adapter.config.refreshMinutes, now())) return status;

  const ctx: FetchContext = {
    fetch: opts.fetchImpl ?? fetch,
    now,
    env: { ARCGIS_API_KEY: env.ARCGIS_API_KEY, USER_AGENT: env.USER_AGENT },
    previous: {
      sourceUpdatedMs: status.source_updated_ms,
      validator: status.validator,
      hasData: status.feature_count > 0 && status.state !== "fixture" && !configChanged,
    },
  };
  const checkedAt = now().toISOString();
  let next: StoredStatus;
  try {
    const result = await adapter.load(ctx);
    const updated = result.sourceUpdatedMs;
    if (result.changed) {
      const allowEmpty = adapter.config.allowEmpty ?? adapter.config.category === "context";
      if (result.features.length === 0 && !allowEmpty && status.feature_count > 0) {
        throw new Error("Source returned no features; keeping the last good copy");
      }
      const body = JSON.stringify(result.features);
      if (body.length > MAX_STORED_BYTES) {
        throw new Error(`Source is too large to cache (${Math.round(body.length / 1048576)} MB); raise maxAllowableOffset or lower maxFeatures`);
      }
      await kv.put(dataKey(id), body);
      next = {
        ...status,
        state: "ok",
        checked_at: checkedAt,
        received_at: checkedAt,
        source_updated_ms: updated,
        source_updated_at: updated ? new Date(updated).toISOString() : null,
        feature_count: result.features.length,
        validator: result.validator,
      };
    } else {
      next = {
        ...status,
        state: "unchanged",
        checked_at: checkedAt,
        source_updated_ms: updated ?? status.source_updated_ms,
        source_updated_at: updated ? new Date(updated).toISOString() : status.source_updated_at,
        validator: result.validator ?? status.validator,
      };
    }
    delete next.error;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    next = { ...status, state: status.state === "fixture" ? "fixture" : "error", error: message };
    if (status.feature_count === 0 || status.state === "fixture") {
      const fx = await loadFixture(adapter, now);
      if (fx) {
        await kv.put(dataKey(id), JSON.stringify(fx));
        next = { ...next, state: "fixture", feature_count: fx.length, received_at: null };
      }
    }
  }
  if (next.state === "ok" || next.state === "unchanged") next.config_hash = hash;
  await kv.put(statusKey(id), JSON.stringify(next));
  return next;
}

/** Run the adapter against bundled sample data, through the same normalization path. */
async function loadFixture(adapter: SourceAdapter, now: () => Date): Promise<NormalizedFeature[] | null> {
  const fx = FIXTURES[adapter.config.id];
  if (!fx) return null;
  const fakeFetch = (async () =>
    new Response(JSON.stringify(fx.body), {
      headers: { "content-type": "application/json", "last-modified": fx.lastModified },
    })) as unknown as typeof fetch;
  const r = await adapter.load({ fetch: fakeFetch, now, env: {} });
  return r.changed ? r.features : null;
}

export async function refreshDue(registry: Registry, env: Env, opts: RefreshOptions = {}) {
  const results: Record<string, SourceStatus["state"]> = {};
  for (const a of registry.all()) {
    results[a.config.id] = (await refreshSource(a, env, opts)).state;
  }
  return results;
}

export async function collection(registry: Registry, env: Env, id: string): Promise<NormalizedCollection | null> {
  const adapter = registry.get(id);
  if (!adapter) return null;
  let status = await readStatus(env.LAYER_CACHE, id);
  let features = await readData(env.LAYER_CACHE, id);
  if (!features || (status.config_hash && status.config_hash !== configHash(adapter.config))) {
    status = await refreshSource(adapter, env, { force: true });
    features = (await readData(env.LAYER_CACHE, id)) ?? [];
  }
  return {
    type: "FeatureCollection",
    features,
    metadata: { ...publicStatus(status), source: publicInfo(adapter) },
  };
}
