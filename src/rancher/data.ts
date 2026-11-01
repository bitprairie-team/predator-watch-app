// Tenant-scoped data access layer. Every key is built from the AuthContext the
// layer was created with, never from tool input, so a tool cannot read another
// tenant's records. The public tier gets nothing private.
import { readData, readStatus, publicStatus } from "../cache";
import { publicInfo, type Registry } from "../registry";
import type { Category, NormalizedFeature, PublicSourceInfo, SourceStatus } from "../schema";
import { sha256Hex } from "../agents/auth";
import type { PrivateStore } from "../agents/store";
import { AgentError, type AuthContext } from "../agents/types";
import type { GroupMember, Observation, ReferenceDocument, SharedObservation, SharingGroupPolicy, TenantRecord } from "./model";
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

/** Ids that become part of a storage key: no ":" or other separators. */
export const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const isSafeId = (id: unknown): id is string => typeof id === "string" && SAFE_ID.test(id);

export const tenantKey = (id: string) => `tenant:${id}`;
export const obsPrefix = (tenantId: string) => `obs:${tenantId}:`;
export const sharedPrefix = (group: string) => `shared:${group}:`;
export const groupKey = (group: string) => `group:${group}`;
export const DOC_PREFIX = "doc:";

export async function originHash(tenantId: string): Promise<string> {
  return (await sha256Hex(`origin:${tenantId}`)).slice(0, 16);
}

export interface SharedGroupView {
  policy: SharingGroupPolicy;
  cells: SharedCell[];
  /** Set when the agreement keeps this group's reports from being shown. */
  gap?: string;
}

function memberActive(m: GroupMember, now: Date): boolean {
  if (m.status !== "active") return false;
  if (Date.parse(m.joined_at) > now.getTime()) return false;
  return !m.ends_at || Date.parse(m.ends_at) > now.getTime();
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

  /**
   * Other ranchers' shared records, generalized to cells per group policy.
   * Enforces the data-sharing agreement: the reader must be an active,
   * unexpired member with read rights, and only reports from active members
   * with contribute rights, made after they joined, are included. A group
   * with no agreement or no member list shares nothing.
   */
  async sharedCells(): Promise<SharedGroupView[]> {
    const t = await this.tenant();
    if (!t) return [];
    const mine = await originHash(this.ctx.tenantId);
    const now = this.now();
    const out: SharedGroupView[] = [];
    for (const group of t.sharing_groups ?? []) {
      if (!isSafeId(group)) continue;
      const policy = await this.store.get<SharingGroupPolicy>(groupKey(group));
      if (!policy || policy.id !== group) continue;
      const blocked = (gap: string) => out.push({ policy, cells: [], gap });
      if (!policy.agreement || !policy.members) {
        blocked(`${policy.name}: no data-sharing agreement or member list is on file, so no shared reports are shown.`);
        continue;
      }
      if (policy.agreement.expires_at && Date.parse(policy.agreement.expires_at) <= now.getTime()) {
        blocked(`${policy.name}: the data-sharing agreement expired on ${policy.agreement.expires_at.slice(0, 10)}, so no shared reports are shown.`);
        continue;
      }
      const me = policy.members.find((m) => m.origin === mine);
      if (!me || !memberActive(me, now) || me.can_read === false) {
        blocked(`${policy.name}: your membership is not active, so no shared reports are shown.`);
        continue;
      }
      const contributors = new Map(policy.members.filter((m) => memberActive(m, now) && m.can_contribute !== false).map((m) => [m.origin, m]));
      const keys = await this.store.list(sharedPrefix(group), 5000);
      const rows = (await Promise.all(keys.map((k) => this.store.get<SharedObservation>(k)))).filter((r): r is SharedObservation => {
        if (!r || r.group !== group) return false;
        const m = contributors.get(r.origin);
        return !!m && Date.parse(r.observed_at) >= Date.parse(m.joined_at);
      });
      out.push({ policy, cells: sharedCells(rows, policy, now, mine) });
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
