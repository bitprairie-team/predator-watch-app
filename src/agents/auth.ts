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

/** Resolve an access key into an AuthContext. Returns null for unknown or revoked keys. */
export async function contextFromAccessKey(store: PrivateStore, key: string, client: string): Promise<AuthContext | null> {
  if (!/^pwk_[A-Za-z0-9_-]{16,}$/.test(key)) return null;
  const rec = await store.get<AccessKeyRecord>(`accesskey:${await sha256Hex(key)}`);
  if (!rec || rec.revoked) return null;
  const tenant = await store.get<{ plan?: Plan }>(`tenant:${rec.tenant_id}`);
  if (!tenant) return null;
  return { tenantId: rec.tenant_id, userId: rec.user_id, plan: tenant.plan ?? "public", scopes: rec.scopes, client };
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
