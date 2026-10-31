// Fixed-window rate limits per tenant. The KV-backed limiter is approximate
// (KV is eventually consistent); a Durable Object limiter is Planned for strict
// limits. The interface lets either be swapped in.
import type { PrivateStore } from "./store";

export interface RateLimiter {
  /** Returns true if the call is allowed, and counts it. */
  hit(key: string, limit: number, windowSeconds: number, now?: number): Promise<boolean>;
}

export class StoreRateLimiter implements RateLimiter {
  constructor(private readonly store: PrivateStore) {}
  async hit(key: string, limit: number, windowSeconds: number, now = Date.now()): Promise<boolean> {
    const win = Math.floor(now / 1000 / windowSeconds);
    const k = `rl:${key}:${win}`;
    const n = (await this.store.get<number>(k)) ?? 0;
    if (n >= limit) return false;
    await this.store.put(k, n + 1, { expirationTtl: Math.max(60, windowSeconds * 2) });
    return true;
  }
}

export interface RateLimitPolicy {
  /** Tool calls per tenant per minute. */
  toolCallsPerMinute: number;
  /** Assistant chat turns per tenant per minute. */
  chatTurnsPerMinute: number;
  /** Voice sessions per tenant per hour. */
  voiceSessionsPerHour: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitPolicy = {
  toolCallsPerMinute: 60,
  chatTurnsPerMinute: 10,
  voiceSessionsPerHour: 20,
};
