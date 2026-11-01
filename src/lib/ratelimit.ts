// Per-client rate limits for the public API. In production these use the
// Workers Rate Limiting bindings declared in wrangler.jsonc (counts are per
// Cloudflare location and approximate). Without a binding (unit tests, or a
// fork that removes them) a small in-memory fixed window per isolate is used.

export type LimitClass = "api" | "export" | "search" | "upstream";

export interface Limiters {
  API_LIMITER?: RateLimit;
  EXPORT_LIMITER?: RateLimit;
  SEARCH_LIMITER?: RateLimit;
  /** Shared key across all clients: caps calls to the outside address geocoder. */
  UPSTREAM_LIMITER?: RateLimit;
}

/** Fallback limits, matching wrangler.jsonc. */
export const LIMITS: Record<LimitClass, { limit: number; periodMs: number }> = {
  api: { limit: 600, periodMs: 60_000 },
  export: { limit: 60, periodMs: 60_000 },
  search: { limit: 30, periodMs: 60_000 },
  upstream: { limit: 10, periodMs: 10_000 },
};

const BINDING: Record<LimitClass, keyof Limiters> = {
  api: "API_LIMITER",
  export: "EXPORT_LIMITER",
  search: "SEARCH_LIMITER",
  upstream: "UPSTREAM_LIMITER",
};

const windows = new Map<string, { start: number; count: number }>();

function memoryLimit(cls: LimitClass, key: string, now: number): boolean {
  const { limit, periodMs } = LIMITS[cls];
  const k = `${cls}:${key}`;
  const w = windows.get(k);
  if (!w || now - w.start >= periodMs) {
    if (windows.size > 50_000) windows.clear();
    windows.set(k, { start: now, count: 1 });
    return true;
  }
  w.count++;
  return w.count <= limit;
}

export async function allow(env: Limiters, cls: LimitClass, key: string, now = Date.now()): Promise<boolean> {
  const binding = env[BINDING[cls]];
  if (binding) {
    try {
      return (await binding.limit({ key: `${cls}:${key}` })).success;
    } catch {
      // A limiter outage should not take the map down.
      return true;
    }
  }
  return memoryLimit(cls, key, now);
}

/** Client key: the connecting IP, or one shared bucket when it is unknown. */
export function clientKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/** For tests. */
export function resetLimits() {
  windows.clear();
}
