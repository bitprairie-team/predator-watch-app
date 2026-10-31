// Audit log of every tool call: who, what, when, outcome, and the sources
// returned. Entries are stored per tenant and are readable only by that tenant.
import type { PrivateStore } from "./store";
import type { AuthContext, SourceRef } from "./types";

export interface AuditEntry {
  id: string;
  at: string;
  tenant_id: string;
  user_id: string;
  client: string;
  tool: string;
  input: unknown;
  outcome: "ok" | "denied" | "not_entitled" | "rate_limited" | "invalid_input" | "error";
  error?: string;
  duration_ms: number;
  sources: Pick<SourceRef, "id" | "kind" | "title" | "url" | "observed_at" | "received_at">[];
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
  /** Entries for the caller's own tenant only, newest first. */
  list(ctx: AuthContext, limit?: number): Promise<AuditEntry[]>;
}

/** Retain audit entries for 400 days by default. */
const RETENTION_SECONDS = 400 * 24 * 3600;

export class StoreAuditLog implements AuditLog {
  constructor(private readonly store: PrivateStore) {}
  async record(e: AuditEntry): Promise<void> {
    // Reverse timestamp so a prefix list returns newest first.
    const rev = (9_999_999_999_999 - Date.parse(e.at)).toString().padStart(13, "0");
    await this.store.put(`audit:${e.tenant_id}:${rev}:${e.id}`, e, { expirationTtl: RETENTION_SECONDS });
  }
  async list(ctx: AuthContext, limit = 50): Promise<AuditEntry[]> {
    const keys = await this.store.list(`audit:${ctx.tenantId}:`, limit);
    const out: AuditEntry[] = [];
    for (const k of keys) {
      const e = await this.store.get<AuditEntry>(k);
      if (e && e.tenant_id === ctx.tenantId) out.push(e);
    }
    return out;
  }
}
