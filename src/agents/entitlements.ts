// Paid-plan entitlement check. Billing is behind an interface; the stub reads
// the plan from the tenant record. A real billing provider is Planned.
import type { PrivateStore } from "./store";
import type { AuthContext, Entitlement, Plan } from "./types";

export interface BillingProvider {
  /** Current plan for a tenant, and whether it is in good standing. */
  planFor(tenantId: string): Promise<{ plan: Plan; active: boolean }>;
}

const PLAN_ENTITLEMENTS: Record<Plan, Entitlement[]> = {
  public: [],
  rancher: ["rancher_assistant"],
};

/** Stub billing: plan and status live on the tenant record in the private store. */
export class StubBilling implements BillingProvider {
  constructor(private readonly store: PrivateStore) {}
  async planFor(tenantId: string) {
    const t = await this.store.get<{ plan?: Plan; billing_active?: boolean }>(`tenant:${tenantId}`);
    if (!t) return { plan: "public" as Plan, active: false };
    return { plan: t.plan ?? "public", active: t.billing_active !== false };
  }
}

export class Entitlements {
  constructor(private readonly billing: BillingProvider) {}
  async has(ctx: AuthContext, e: Entitlement): Promise<boolean> {
    if (ctx.plan === "public") return false;
    const { plan, active } = await this.billing.planFor(ctx.tenantId);
    return active && PLAN_ENTITLEMENTS[plan].includes(e);
  }
}
