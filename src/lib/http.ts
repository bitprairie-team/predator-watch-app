// Polite HTTP helper: per-host spacing between requests, timeouts, and a small
// number of retries on 429 / 5xx with backoff. Never logs query strings, so an
// optional API key passed as a parameter is not written to logs.

export interface PoliteOptions {
  timeoutMs?: number;
  retries?: number;
  /** Minimum milliseconds between requests to the same host. */
  minIntervalMs?: number;
  headers?: Record<string, string>;
  userAgent?: string;
}

const DEFAULTS = { timeoutMs: 20_000, retries: 2, minIntervalMs: 250 };

const lastRequestAt = new Map<string, number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Strip the query string so URLs are safe to put in logs and errors. */
export function redact(url: string): string {
  const i = url.indexOf("?");
  return i === -1 ? url : url.slice(0, i);
}

async function waitForHost(url: string, minIntervalMs: number) {
  if (minIntervalMs <= 0) return;
  const host = new URL(url).host;
  const last = lastRequestAt.get(host) ?? 0;
  const wait = last + minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt.set(host, Date.now());
}

export async function politeFetch(
  fetchImpl: typeof fetch,
  url: string,
  opts: PoliteOptions = {},
): Promise<Response> {
  const { timeoutMs, retries, minIntervalMs } = { ...DEFAULTS, ...opts };
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  if (opts.userAgent) headers["User-Agent"] = opts.userAgent;

  let attempt = 0;
  for (;;) {
    await waitForHost(url, minIntervalMs);
    let res: Response | undefined;
    let err: unknown;
    try {
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      err = e;
    }
    const retryable = !res || res.status === 429 || res.status >= 500;
    if (res && !retryable) {
      if (!res.ok && res.status !== 304) {
        throw new HttpError(`HTTP ${res.status} from ${redact(url)}`, res.status);
      }
      return res;
    }
    if (attempt >= retries) {
      if (res) throw new HttpError(`HTTP ${res.status} from ${redact(url)}`, res.status);
      const name = err instanceof Error ? err.name : "Error";
      const msg = name === "TimeoutError" || name === "AbortError" ? "timed out" : "network error";
      throw new HttpError(`Request ${msg}: ${redact(url)}`, null);
    }
    attempt++;
    const retryAfter = Number(res?.headers.get("Retry-After"));
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
    await sleep(Math.min(backoff, 10_000));
  }
}

export async function fetchJson<T = unknown>(
  fetchImpl: typeof fetch,
  url: string,
  opts?: PoliteOptions,
): Promise<T> {
  const res = await politeFetch(fetchImpl, url, opts);
  return (await res.json()) as T;
}

/** For tests: forget per-host timing. */
export function resetRateLimiter() {
  lastRequestAt.clear();
}
