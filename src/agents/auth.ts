// Per-tenant auth context. Rancher access keys are random tokens stored only
// as SHA-256 hashes. OAuth (for MCP) maps onto the same AuthContext.
import type { PrivateStore } from "./store";
import { READ_SCOPES, type AuthContext, type Plan, type Scope } from "./types";

export interface AccessKeyRecord {
  tenant_id: string;
  user_id: string;
  scopes: Scope[];
  label?: string;
  created_at: string;
  revoked?: boolean;
  /** Key stops working at this time. */
  expires_at?: string;
  /** Only these tools; all tools the scopes allow if unset. */
  tools?: string[];
  /** Tool calls per day for this key (on top of the per-tenant limits). */
  calls_per_day?: number;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newAccessKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return "pwk_" + btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const PUBLIC_CONTEXT: AuthContext = { tenantId: "public", userId: "anonymous", plan: "public", scopes: [], client: "public" };

/** Resolve an access key into an AuthContext. Returns null for unknown, revoked, or expired keys. */
export async function contextFromAccessKey(store: PrivateStore, key: string, client: string, now: Date = new Date()): Promise<AuthContext | null> {
  if (!/^pwk_[A-Za-z0-9_-]{16,}$/.test(key)) return null;
  return contextFromKeyHash(store, await sha256Hex(key), client, now);
}

/**
 * Resolve a stored key hash. OAuth grants keep the hash of the key that
 * approved them and re-check it on every request, so revoking or expiring
 * the key also ends its MCP connections.
 */
export async function contextFromKeyHash(store: PrivateStore, hash: string, client: string, now: Date = new Date()): Promise<AuthContext | null> {
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const rec = await store.get<AccessKeyRecord>(`accesskey:${hash}`);
  if (!rec || rec.revoked) return null;
  if (rec.expires_at && !(Date.parse(rec.expires_at) > now.getTime())) return null;
  // Tenant and user ids become parts of storage keys; refuse any with separators.
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(rec.tenant_id) || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(rec.user_id)) return null;
  const tenant = await store.get<{ plan?: Plan }>(`tenant:${rec.tenant_id}`);
  if (!tenant) return null;
  const ctx: AuthContext = { tenantId: rec.tenant_id, userId: rec.user_id, plan: tenant.plan ?? "public", scopes: rec.scopes, client, keyId: hash.slice(0, 12) };
  if (Array.isArray(rec.tools)) ctx.tools = rec.tools.filter((t) => typeof t === "string");
  if (typeof rec.calls_per_day === "number" && rec.calls_per_day >= 0) ctx.callsPerDay = rec.calls_per_day;
  return ctx;
}

export function bearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  const m = h?.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1]! : null;
}

export function hasScope(ctx: AuthContext, scope: Scope): boolean {
  if (ctx.scopes.includes(scope)) return true;
  return ctx.scopes.includes("rancher:read") && READ_SCOPES.includes(scope);
}
