// Wires the framework pieces together for one request: private store, tool
// registry, audit, entitlements, rate limits, data access, and model provider.
import { StoreAuditLog, type AuditLog } from "../agents/audit";
import { bearer, contextFromAccessKey } from "../agents/auth";
import { Entitlements, StubBilling, type BillingProvider } from "../agents/entitlements";
import { createProvider, isMockProvider, type ProviderEnv } from "../agents/providers";
import type { ModelProvider, VoiceProvider } from "../agents/providers/types";
import { DEFAULT_RATE_LIMITS, StoreRateLimiter, type RateLimiter, type RateLimitPolicy } from "../agents/rate-limit";
import type { ExecutorDeps, ToolRegistry } from "../agents/registry";
import { DEFAULT_TURN_LIMITS, type TurnLimits } from "../agents/runner";
import { KvStore, type PrivateStore } from "../agents/store";
import type { AuthContext } from "../agents/types";
import { Registry } from "../registry";
import { KvPublicLayers, RancherData, type PublicLayers } from "./data";
import { rancherRegistry, type RancherDeps } from "./tools";

export interface PrivateEnv extends ProviderEnv {
  LAYER_CACHE: KVNamespace;
  /** Private tenant data, audit log, access keys, rate-limit counters. */
  PRIVATE_KV?: KVNamespace;
  /** Token storage for the MCP OAuth provider. */
  OAUTH_KV?: KVNamespace;
  /** "1" adds the optional model classifier after the deterministic rules. */
  GUARD_MODEL_CLASSIFIER?: string;
}

/** Guardrail limits and switches. See docs/assistant-guardrails.md. */
export interface GuardConfig {
  turnLimits: TurnLimits;
  /** Chat questions per account per day. */
  chatTurnsPerDay: number;
  /** Voice guard checks per account per minute. */
  voiceGuardPerMinute: number;
  toolTimeoutMs: number;
  modelClassifier: boolean;
}

export const DEFAULT_GUARD: GuardConfig = {
  turnLimits: DEFAULT_TURN_LIMITS,
  chatTurnsPerDay: 300,
  voiceGuardPerMinute: 60,
  toolTimeoutMs: 10_000,
  modelClassifier: false,
};

export interface ServiceOverrides {
  store?: PrivateStore;
  publicLayers?: PublicLayers;
  provider?: (ModelProvider & VoiceProvider) | null;
  billing?: BillingProvider;
  rateLimiter?: RateLimiter;
  limits?: RateLimitPolicy;
  guard?: Partial<Omit<GuardConfig, "turnLimits">> & { turnLimits?: Partial<TurnLimits> };
  now?: () => Date;
}

export interface RancherService {
  store: PrivateStore;
  registry: ToolRegistry<RancherDeps>;
  deps: ExecutorDeps<RancherDeps>;
  audit: AuditLog;
  entitlements: Entitlements;
  rateLimiter: RateLimiter;
  limits: RateLimitPolicy;
  provider: (ModelProvider & VoiceProvider) | null;
  guard: GuardConfig;
  /** True when the provider is the offline xAI mock. */
  mock: boolean;
  now: () => Date;
  authenticate(request: Request, client: string): Promise<AuthContext | null>;
}

let registrySingleton: ToolRegistry<RancherDeps> | undefined;
let sourceRegistry: Registry | undefined;

/** Returns null when private features are not configured on this deployment. */
export function rancherService(env: PrivateEnv, o: ServiceOverrides = {}): RancherService | null {
  const store = o.store ?? (env.PRIVATE_KV ? new KvStore(env.PRIVATE_KV) : null);
  if (!store) return null;
  registrySingleton ??= rancherRegistry();
  sourceRegistry ??= new Registry();
  const now = o.now ?? (() => new Date());
  const publicLayers = o.publicLayers ?? new KvPublicLayers(sourceRegistry, env.LAYER_CACHE);
  const audit = new StoreAuditLog(store);
  const entitlements = new Entitlements(o.billing ?? new StubBilling(store));
  const rateLimiter = o.rateLimiter ?? new StoreRateLimiter(store);
  const limits = o.limits ?? DEFAULT_RATE_LIMITS;
  const guard: GuardConfig = {
    ...DEFAULT_GUARD,
    modelClassifier: env.GUARD_MODEL_CLASSIFIER === "1",
    ...o.guard,
    turnLimits: { ...DEFAULT_TURN_LIMITS, ...o.guard?.turnLimits },
  };
  const deps: ExecutorDeps<RancherDeps> = {
    audit,
    entitlements,
    rateLimiter,
    limits,
    now,
    toolTimeoutMs: guard.toolTimeoutMs,
    data: (ctx) => ({ data: new RancherData(store, publicLayers, ctx, now), audit }),
  };
  return {
    store,
    registry: registrySingleton,
    deps,
    audit,
    entitlements,
    rateLimiter,
    limits,
    provider: o.provider !== undefined ? o.provider : createProvider(env),
    guard,
    mock: o.provider !== undefined ? o.provider?.id === "mock" : isMockProvider(env),
    now,
    async authenticate(request, client) {
      const key = bearer(request);
      return key ? contextFromAccessKey(store, key, client) : null;
    },
  };
}
