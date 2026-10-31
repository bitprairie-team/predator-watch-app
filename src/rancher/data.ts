// Tenant-scoped data access layer. Every key is built from the AuthContext the
// layer was created with, never from tool input, so a tool cannot read another
// tenant's records. The public tier gets nothing private.
import { readData, readStatus, publicStatus } from "../cache";
import { publicInfo, type Registry } from "../registry";
import type { Category, NormalizedFeature, PublicSourceInfo, SourceStatus } from "../schema";
import { sha256Hex } from "../agents/auth";
import type { PrivateStore } from "../agents/store";
import { AgentError, type AuthContext } from "../agents/types";
import type { Observation, ReferenceDocument, SharedObservation, SharingGroupPolicy, TenantRecord } from "./model";
import { sharedCells, type SharedCell } from "./tiers";

export interface PublicLayer {
  info: PublicSourceInfo;
  status: SourceStatus;
  features: NormalizedFeature[];
}

/** Read access to the public agency layers the map already caches. */
export interface PublicLayers {
  byCategory(categories: Category[], sourceIds?: string[]): Promise<PublicLayer[]>;
}

export class KvPublicLayers implements PublicLayers {
  constructor(private readonly registry: Registry, private readonly kv: KVNamespace) {}
  async byCategory(categories: Category[], sourceIds?: string[]): Promise<PublicLayer[]> {
    const adapters = this.registry
      .all()
      .filter((a) => categories.includes(a.config.category) && (!sourceIds || sourceIds.includes(a.config.id)));
    return Promise.all(
      adapters.map(async (a) => ({
        info: publicInfo(a),
        status: publicStatus(await readStatus(this.kv, a.config.id)),
        features: (await readData(this.kv, a.config.id)) ?? [],
      })),
    );
  }
}

export const tenantKey = (id: string) => `tenant:${id}`;
export const obsPrefix = (tenantId: string) => `obs:${tenantId}:`;
export const sharedPrefix = (group: string) => `shared:${group}:`;
export const groupKey = (group: string) => `group:${group}`;
export const DOC_PREFIX = "doc:";

export async function originHash(tenantId: string): Promise<string> {
  return (await sha256Hex(`origin:${tenantId}`)).slice(0, 16);
}

export class RancherData {
  private tenantCache?: TenantRecord | null;

  constructor(
    private readonly store: PrivateStore,
    readonly publicLayers: PublicLayers,
    readonly ctx: AuthContext,
    readonly now: () => Date = () => new Date(),
  ) {}

  private requirePrivate() {
    if (this.ctx.plan === "public") throw new AgentError("not_entitled", "Private data needs the rancher plan.", 402);
  }

  async tenant(): Promise<TenantRecord | null> {
    this.requirePrivate();
    if (this.tenantCache === undefined) {
      const t = await this.store.get<TenantRecord>(tenantKey(this.ctx.tenantId));
      this.tenantCache = t && t.id === this.ctx.tenantId ? t : null;
    }
    return this.tenantCache;
  }

  async ranch(ranchId?: string) {
    const t = await this.tenant();
    if (!t || t.ranches.length === 0) return null;
    return ranchId ? (t.ranches.find((r) => r.id === ranchId) ?? null) : (t.ranches[0] ?? null);
  }

  /** The tenant's own records, full precision. */
  async ownObservations(): Promise<Observation[]> {
    this.requirePrivate();
    const prefix = obsPrefix(this.ctx.tenantId);
    const keys = await this.store.list(prefix, 2000);
    const rows = await Promise.all(keys.filter((k) => k.startsWith(prefix)).map((k) => this.store.get<Observation>(k)));
    return rows.filter((r): r is Observation => r !== null);
  }

  /** Other ranchers' shared records, generalized to cells per group policy. */
  async sharedCells(): Promise<{ policy: SharingGroupPolicy; cells: SharedCell[] }[]> {
    const t = await this.tenant();
    if (!t) return [];
    const mine = await originHash(this.ctx.tenantId);
    const out: { policy: SharingGroupPolicy; cells: SharedCell[] }[] = [];
    for (const group of t.sharing_groups ?? []) {
      const policy = await this.store.get<SharingGroupPolicy>(groupKey(group));
      if (!policy) continue;
      const keys = await this.store.list(sharedPrefix(group), 5000);
      const rows = (await Promise.all(keys.map((k) => this.store.get<SharedObservation>(k)))).filter(
        (r): r is SharedObservation => r !== null,
      );
      out.push({ policy, cells: sharedCells(rows, policy, this.now(), mine) });
    }
    return out;
  }

  /** Reference documents: shared library plus the tenant's own uploads. */
  async documents(): Promise<ReferenceDocument[]> {
    this.requirePrivate();
    const prefixes = [DOC_PREFIX, `tdoc:${this.ctx.tenantId}:`];
    const docs: ReferenceDocument[] = [];
    for (const p of prefixes) {
      const keys = await this.store.list(p, 500);
      for (const k of keys) {
        const d = await this.store.get<ReferenceDocument>(k);
        if (d) docs.push(d);
      }
    }
    return docs;
  }
}
