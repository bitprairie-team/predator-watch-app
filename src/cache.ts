// KV-backed cache of normalized GeoJSON plus per-source status, and the
// refresh logic. Only the Cron Trigger calls agency servers; public requests
// read KV (see collection()) and never fan out to an agency.
import type { FetchContext, SourceAdapter } from "./adapters/types";
import { sanitizePublicFeature } from "./lib/normalize";
import { publicInfo, type Registry } from "./registry";
import type { NormalizedCollection, NormalizedFeature, SourceStatus } from "./schema";
import cdfwSample from "./fixtures/cdfw-wolf-bins.sample.json";
import { diffFeatures, pushChange, type ChangeEntry } from "./lib/changes";
import { fnv1a } from "./lib/hash";
import type { Limiters } from "./lib/ratelimit";

export interface Env extends Limiters {
  LAYER_CACHE: KVNamespace;
  ASSETS?: Fetcher;
  ARCGIS_API_KEY?: string;
  USER_AGENT?: string;
}

export interface StoredStatus extends SourceStatus {
  source_updated_ms: number | null;
  validator: string | null;
  /** Hash of the source config; a config change forces a full re-fetch. */
  config_hash?: string;
  /** Most recent changes first; see src/lib/changes.ts. */
  changes?: ChangeEntry[];
  /** Last time the agency answered with a usable result (ok or unchanged). */
  last_success_at?: string | null;
}

/** One cron run, kept in a short log for /status. */
export interface RunLogEntry {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  requests: number;
  sources: Record<string, { state: SourceStatus["state"] | "deferred"; feature_count?: number; ms?: number; error?: string }>;
}
export const RUN_LOG_KEY = "cron:runs";
export const RUN_LOG_SIZE = 20;

/** Whole-source time limit, on top of each request's own timeout. */
export const SOURCE_TIMEOUT_MS = 90_000;
/** Pause between sources so one run does not hit agency servers in a burst. */
export const STAGGER_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Thrown when a source answers but the answer should not replace good data. */
export class KeepLastGood extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeepLastGood";
  }
}

/** Reject after `ms`, so a hung source cannot stall the whole run. */
export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Checks a fresh result before it may replace the stored copy. A source may
 * return zero features only when that is a normal answer for it (allowEmpty,
 * e.g. no active warnings) or when it has never had any.
 */
export function validateResult(features: unknown, previousCount: number, allowEmpty: boolean): asserts features is NormalizedFeature[] {
  if (!Array.isArray(features)) throw new KeepLastGood("Source returned an invalid result; keeping the last good copy");
  if (features.length === 0) {
    if (!allowEmpty && previousCount > 0) throw new KeepLastGood("Source returned no features; keeping the last good copy");
    return;
  }
  const valid = features.filter((f) => {
    const g = (f as NormalizedFeature | null)?.geometry as { type?: unknown; coordinates?: unknown; geometries?: unknown } | null | undefined;
    return Boolean(g && typeof g.type === "string" && (Array.isArray(g.coordinates) || Array.isArray(g.geometries)));
  }).length;
  if (valid === 0) throw new KeepLastGood("Source returned features without usable geometry; keeping the last good copy");
}

/** Network trouble or a server error is worth one more try; bad data is not. */
function retryable(e: unknown): boolean {
  if (e instanceof KeepLastGood) return false;
  const status = (e as { status?: unknown } | null)?.status;
  if (status === null || status === undefined) return true;
  return typeof status === "number" && (status === 429 || status >= 500);
}

/** Hash of a source config; a change forces a full re-fetch. */
export function configHash(config: unknown): string {
  return fnv1a(JSON.stringify(config));
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

/**
 * Public reads pass `cacheTtl` so KV can serve them from the location's
 * cache; the refresh path reads without it to see the latest write.
 */
export async function readStatus(kv: KVNamespace, id: string, cacheTtl?: number): Promise<StoredStatus> {
  const v = cacheTtl
    ? await kv.get<StoredStatus>(statusKey(id), { type: "json", cacheTtl })
    : await kv.get<StoredStatus>(statusKey(id), "json");
  return v ?? emptyStatus(id);
}

export function publicStatus(s: StoredStatus): SourceStatus {
  const { source_updated_ms: _m, validator: _v, config_hash: _h, changes: _c, last_success_at: _l, ...rest } = s;
  return rest;
}

export async function readData(kv: KVNamespace, id: string, cacheTtl?: number): Promise<NormalizedFeature[] | null> {
  return cacheTtl
    ? kv.get<NormalizedFeature[]>(dataKey(id), { type: "json", cacheTtl })
    : kv.get<NormalizedFeature[]>(dataKey(id), "json");
}

/** Normalized bundled samples, built once per isolate. */
const fixtureMemo = new Map<string, NormalizedFeature[] | null>();

/** KV's minimum edge cache TTL for reads on the public path. */
export const PUBLIC_KV_TTL = 30;

function isDue(status: StoredStatus, refreshMinutes: number, now: Date): boolean {
  if (!status.checked_at || status.state === "never" || status.state === "fixture") return true;
  const last = Date.parse(status.checked_at);
  return !Number.isFinite(last) || now.getTime() - last >= refreshMinutes * 60_000 - 30_000;
}

export interface RefreshOptions {
  force?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Attempts per source (default 2: one retry after a backoff). */
  attempts?: number;
  /** Delay before the retry; doubles each attempt (default 2 s). */
  retryDelayMs?: number;
  /** Whole-source time limit (default SOURCE_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Return false to skip a retry, e.g. when the request budget is low. */
  canRetry?: () => boolean;
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
    const attempts = Math.max(1, opts.attempts ?? 2);
    const delay = opts.retryDelayMs ?? 2_000;
    let result!: Awaited<ReturnType<SourceAdapter["load"]>>;
    for (let i = 1; ; i++) {
      try {
        result = await withTimeout(adapter.load(ctx), opts.timeoutMs ?? SOURCE_TIMEOUT_MS, "Source");
        break;
      } catch (e) {
        if (i >= attempts || !retryable(e) || (opts.canRetry && !opts.canRetry())) throw e;
        await sleep(delay * 2 ** (i - 1));
      }
    }
    const updated = result.sourceUpdatedMs;
    if (result.changed) {
      const allowEmpty = adapter.config.allowEmpty ?? adapter.config.category === "context";
      validateResult(result.features, status.state === "fixture" ? 0 : status.feature_count, allowEmpty);
      const body = JSON.stringify(result.features);
      if (body.length > MAX_STORED_BYTES) {
        throw new KeepLastGood(`Source is too large to cache (${Math.round(body.length / 1048576)} MB); raise maxAllowableOffset or lower maxFeatures`);
      }
      // Only diff real agency copies, not the bundled sample.
      const prev = status.state === "fixture" || configChanged ? null : await readData(kv, id);
      await kv.put(dataKey(id), body);
      next = {
        ...status,
        changes: pushChange(status.changes, diffFeatures(prev, result.features, checkedAt)),
        state: "ok",
        checked_at: checkedAt,
        received_at: checkedAt,
        source_updated_ms: updated,
        source_updated_at: updated ? new Date(updated).toISOString() : null,
        feature_count: result.features.length,
        validator: result.validator,
        attempted_at: checkedAt,
        last_success_at: checkedAt,
        failures: 0,
      };
    } else {
      next = {
        ...status,
        state: "unchanged",
        checked_at: checkedAt,
        source_updated_ms: updated ?? status.source_updated_ms,
        source_updated_at: updated ? new Date(updated).toISOString() : status.source_updated_at,
        validator: result.validator ?? status.validator,
        attempted_at: checkedAt,
        last_success_at: checkedAt,
        failures: 0,
      };
    }
    delete next.error;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    next = {
      ...status,
      state: status.state === "fixture" ? "fixture" : "error",
      error: message,
      attempted_at: checkedAt,
      last_error_at: checkedAt,
      failures: (status.failures ?? 0) + 1,
    };
    // The stored data is left as it was: the last good copy keeps serving.
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

/**
 * Refresh every source that is due, most overdue first, one at a time with a
 * short pause between sources. Workers cap the number of outbound requests per
 * invocation (50 on the free plan), so stop starting new sources, and stop
 * retrying, once the request budget is nearly used; the rest are picked up by
 * the next run. Each run is added to a short log in KV for /status.
 */
export async function refreshDue(
  registry: Registry,
  env: Env,
  opts: RefreshOptions & { requestBudget?: number; staggerMs?: number } = {},
) {
  const budget = opts.requestBudget ?? 45;
  const base = opts.fetchImpl ?? fetch;
  const clock = opts.now ?? (() => new Date());
  const startedAt = clock();
  let used = 0;
  const counted = ((input: RequestInfo | URL, init?: RequestInit) => {
    used++;
    return base(input, init);
  }) as typeof fetch;

  const now = startedAt.getTime();
  const statuses = await Promise.all(
    registry.all().map(async (a) => ({ a, s: await readStatus(env.LAYER_CACHE, a.config.id) })),
  );
  const overdue = ({ a, s }: (typeof statuses)[number]) =>
    s.checked_at ? (now - Date.parse(s.checked_at)) / (a.config.refreshMinutes * 60_000) : Infinity;
  statuses.sort((x, y) => overdue(y) - overdue(x));

  const results: Record<string, SourceStatus["state"] | "deferred"> = {};
  const log: RunLogEntry["sources"] = {};
  const stagger = opts.staggerMs ?? STAGGER_MS;
  for (const { a, s } of statuses) {
    const id = a.config.id;
    // Leave headroom: one source can take several requests (metadata + pages + retries).
    if (used >= budget - 4) {
      results[id] = "deferred";
      log[id] = { state: "deferred" };
      continue;
    }
    const before = used;
    const t0 = Date.now();
    const next = await refreshSource(a, env, { ...opts, fetchImpl: counted, canRetry: () => used < budget - 8 });
    results[id] = next.state;
    // Sources that were not due make no requests and are not logged.
    if (used > before || next.attempted_at !== s.attempted_at) {
      log[id] = {
        state: next.state,
        feature_count: next.feature_count,
        ms: Date.now() - t0,
        ...(next.error && next.attempted_at === next.last_error_at ? { error: next.error } : {}),
      };
      if (stagger > 0) await sleep(stagger);
    }
  }
  const finished = clock();
  await appendRunLog(env.LAYER_CACHE, {
    started_at: startedAt.toISOString(),
    finished_at: finished.toISOString(),
    duration_ms: finished.getTime() - startedAt.getTime(),
    requests: used,
    sources: log,
  });
  return results;
}

/** Add a run to the front of the log, keeping the last RUN_LOG_SIZE runs. */
export async function appendRunLog(kv: KVNamespace, entry: RunLogEntry): Promise<RunLogEntry[]> {
  const prev = (await kv.get<RunLogEntry[]>(RUN_LOG_KEY, "json")) ?? [];
  const next = [entry, ...prev].slice(0, RUN_LOG_SIZE);
  await kv.put(RUN_LOG_KEY, JSON.stringify(next));
  return next;
}

export async function readRunLog(kv: KVNamespace, cacheTtl?: number): Promise<RunLogEntry[]> {
  const v = cacheTtl
    ? await kv.get<RunLogEntry[]>(RUN_LOG_KEY, { type: "json", cacheTtl })
    : await kv.get<RunLogEntry[]>(RUN_LOG_KEY, "json");
  return Array.isArray(v) ? v : [];
}

/**
 * A source's cached collection, read from KV only. Before the first cron run
 * a source has no data: it is served empty with state "never", or as the
 * bundled sample (state "fixture") when one exists. A config change is picked
 * up by the next cron run; until then the last good copy is served.
 */
export async function collection(registry: Registry, env: Env, id: string): Promise<NormalizedCollection | null> {
  const adapter = registry.get(id);
  if (!adapter) return null;
  let status = await readStatus(env.LAYER_CACHE, id, PUBLIC_KV_TTL);
  let features = await readData(env.LAYER_CACHE, id, PUBLIC_KV_TTL);
  if (!features) {
    let fx = fixtureMemo.get(id);
    if (fx === undefined) {
      fx = await loadFixture(adapter, () => new Date());
      fixtureMemo.set(id, fx);
    }
    features = fx ?? [];
    if (fx) status = { ...status, state: "fixture", feature_count: fx.length, received_at: null };
  }
  return {
    type: "FeatureCollection",
    features: features.map(sanitizePublicFeature),
    metadata: { ...publicStatus(status), source: publicInfo(adapter) },
  };
}
