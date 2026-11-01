// Fixtures for the rancher assistant tests. All names and places are made up.
import { sha256Hex } from "../src/agents/auth";
import { MemoryStore } from "../src/agents/store";
import type { Scope } from "../src/agents/types";
import { originHash, type PublicLayer, type PublicLayers } from "../src/rancher/data";
import type { Observation, ReferenceDocument, SharedObservation, SharingGroupPolicy, TenantRecord } from "../src/rancher/model";
import { rancherService, type ServiceOverrides } from "../src/rancher/service";
import type { Category, NormalizedFeature } from "../src/schema";
import { memoryKV } from "./helpers";

export const NOW = new Date("2026-10-31T19:00:00Z");
export const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400_000).toISOString();

export const KEYS = {
  a: "pwk_tenantAkey_aaaaaaaaaaaaaaaa",
  b: "pwk_tenantBkey_bbbbbbbbbbbbbbbb",
  pub: "pwk_publicPkey_pppppppppppppppp",
  lapsed: "pwk_lapsedLkey_llllllllllllllll",
  narrow: "pwk_narrowNkey_nnnnnnnnnnnnnnnn",
  /** Tenant A web key that may run agents and approve the outbox. */
  ops: "pwk_opsAgentKey_oooooooooooooooo",
};

const square = (lon: number, lat: number, d: number) => ({
  type: "Polygon" as const,
  coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]],
});

export const TENANT_A: TenantRecord = {
  id: "tenant-a",
  name: "Alder Creek Ranch",
  plan: "rancher",
  billing_active: true,
  sharing_groups: ["grp1"],
  ranches: [
    {
      id: "ranch-a1",
      name: "Home place",
      location: { lat: 41.8, lon: -120.9 },
      allotments: [
        {
          id: "allot-a1",
          name: "North Bench",
          managing_agency: "BLM",
          agency_allotment_id: "00001",
          geometry: square(-120.9, 41.85, 0.05),
          geometry_source: { publisher: "Bureau of Land Management", url: "https://example.invalid/allotments", received_at: daysAgo(30) },
        },
      ],
    },
  ],
  contacts: [
    {
      role: "Wildlife conflict specialist",
      name: "Pat Example",
      organization: "State wildlife agency, district office",
      phone: "555-0100",
      source: { publisher: "State wildlife agency", url: "https://example.invalid/contacts", verified_at: daysAgo(10) },
    },
  ],
  reporting: [
    {
      topic: "depredation",
      title: "Reporting a suspected depredation",
      steps: ["Protect the site and the carcass.", "Call the conflict specialist on file."],
      source: { publisher: "State wildlife agency", url: "https://example.invalid/report", verified_at: daysAgo(10) },
    },
  ],
  updated_at: daysAgo(1),
};

export const TENANT_B: TenantRecord = {
  ...TENANT_A,
  id: "tenant-b",
  name: "Birch Flat Ranch",
  ranches: [{ id: "ranch-b1", name: "B headquarters", location: { lat: 41.82, lon: -120.88 }, allotments: [] }],
  contacts: [],
  reporting: [],
};

export const TENANT_PUBLIC: TenantRecord = { ...TENANT_A, id: "tenant-p", name: "Free account", plan: "public" };
export const TENANT_LAPSED: TenantRecord = { ...TENANT_A, id: "tenant-l", name: "Lapsed", billing_active: false };

export const OBS_A: Observation = {
  id: "a-obs-1", ranch_id: "ranch-a1", species: "Gray wolf", kind: "sighting",
  lat: 41.8012, lon: -120.9034, observed_at: daysAgo(2), received_at: daysAgo(2), notes: "Two animals at the east gate", share: true,
};
export const OBS_B: Observation = {
  id: "b-obs-1", ranch_id: "ranch-b1", species: "Gray wolf", kind: "depredation",
  lat: 41.8123, lon: -120.8877, observed_at: daysAgo(5), received_at: daysAgo(5), notes: "B private note", share: true,
};

export const AGREEMENT = { id: "agr-1", version: "1", signed_at: daysAgo(400), expires_at: null };
export const GROUP: SharingGroupPolicy = { id: "grp1", name: "Valley ranchers group", cell_miles: 1.5, delay_hours: 72, den_season: { start: "04-01", end: "06-30" }, agreement: AGREEMENT };

/** Group policy with its member list (origins are hashes, so this is async). */
export async function groupWithMembers(): Promise<SharingGroupPolicy> {
  return {
    ...GROUP,
    members: [
      { origin: await originHash("tenant-a"), status: "active", joined_at: daysAgo(365) },
      { origin: await originHash("tenant-b"), status: "active", joined_at: daysAgo(365) },
    ],
  };
}

export async function sharedRecords(): Promise<SharedObservation[]> {
  const ob = await originHash("tenant-b");
  const oa = await originHash("tenant-a");
  return [
    { id: "s1", group: "grp1", origin: ob, species: "Gray wolf", kind: "depredation", lat: OBS_B.lat, lon: OBS_B.lon, observed_at: daysAgo(5), received_at: daysAgo(5) },
    { id: "s2", group: "grp1", origin: ob, species: "Gray wolf", kind: "sighting", lat: 41.79, lon: -120.95, observed_at: daysAgo(1), received_at: daysAgo(1) },
    { id: "s3", group: "grp1", origin: ob, species: "Gray wolf", kind: "sign", lat: 41.75, lon: -120.8, observed_at: daysAgo(6), received_at: daysAgo(6), sensitive: "den" },
    { id: "s4", group: "grp1", origin: oa, species: "Gray wolf", kind: "sighting", lat: OBS_A.lat, lon: OBS_A.lon, observed_at: daysAgo(4), received_at: daysAgo(4) },
  ];
}

export const DOC: ReferenceDocument = {
  id: "fixture-fladry",
  title: "Fixture guide to fladry (test data)",
  publisher: "Example Extension Service",
  url: "https://example.invalid/fladry.pdf",
  published_at: "2024-01-01",
  retrieved_at: daysAgo(20),
  topics: ["nonlethal-deterrents"],
  excerpts: ["Fladry is a line of flags hung on a fence (fixture text)."],
};

const feature = (id: string, sourceId: string, category: Category, label: string, geometry: NormalizedFeature["geometry"], observed: string | null): NormalizedFeature => ({
  type: "Feature",
  id,
  geometry,
  properties: {
    id, source_id: sourceId, source_name: sourceId, category, species: category === "context" ? null : "Gray wolf", agency: "Test agency",
    label, observed_at: observed, observed_at_precision: observed ? "day" : "dataset", received_at: daysAgo(0.1),
    precision: category === "context" ? "alert-area" : "hex-cell", geometry_type: "Polygon", attribution: "Test agency",
    url: "https://example.invalid/layer", license: "test", details: {},
  },
});

export const LAYERS: PublicLayer[] = [
  {
    info: { id: "test-wolf-cells", name: "Test collared wolf cells", category: "wolf-activity", species: "Gray wolf", agency: "Test wildlife agency", url: "https://example.invalid/wolf", info_url: "https://example.invalid/wolf-info", license: "test", attribution: "Test", cadence: "daily", precision: "hex-cell", style: { color: "#000" } },
    status: { source_id: "test-wolf-cells", state: "ok", checked_at: daysAgo(0.1), received_at: daysAgo(0.1), source_updated_at: daysAgo(1), feature_count: 2 },
    features: [
      feature("w1", "test-wolf-cells", "wolf-activity", "Collar cell near home", square(-120.92, 41.86, 0.01), daysAgo(3)),
      feature("w2", "test-wolf-cells", "wolf-activity", "Old far cell", square(-118, 40, 0.01), daysAgo(200)),
    ],
  },
  {
    info: { id: "test-alerts", name: "Test weather alerts", category: "context", species: null, agency: "Test weather service", url: "https://example.invalid/alerts", info_url: "https://example.invalid/alerts-info", license: "test", attribution: "Test", cadence: "realtime", precision: "alert-area", style: { color: "#f00" } },
    status: { source_id: "test-alerts", state: "ok", checked_at: daysAgo(0.05), received_at: daysAgo(0.05), source_updated_at: null, feature_count: 1 },
    features: [feature("n1", "test-alerts", "context", "Red Flag Warning", square(-120.9, 41.8, 0.3), daysAgo(0.2))],
  },
];

export class FakePublicLayers implements PublicLayers {
  constructor(private readonly layers: PublicLayer[] = LAYERS) {}
  async byCategory(categories: Category[], ids?: string[]) {
    return this.layers.filter((l) => categories.includes(l.info.category) && (!ids || ids.includes(l.info.id)));
  }
}

export async function addKey(store: MemoryStore, key: string, tenant: string, user: string, scopes: Scope[]) {
  await store.put(`accesskey:${await sha256Hex(key)}`, { tenant_id: tenant, user_id: user, scopes, created_at: daysAgo(30) });
}

export async function seededStore(): Promise<MemoryStore> {
  const s = new MemoryStore();
  for (const t of [TENANT_A, TENANT_B, TENANT_PUBLIC, TENANT_LAPSED]) await s.put(`tenant:${t.id}`, t);
  await addKey(s, KEYS.a, "tenant-a", "user-a", ["rancher:read"]);
  await addKey(s, KEYS.b, "tenant-b", "user-b", ["rancher:read"]);
  await addKey(s, KEYS.pub, "tenant-p", "user-p", ["rancher:read"]);
  await addKey(s, KEYS.lapsed, "tenant-l", "user-l", ["rancher:read"]);
  await addKey(s, KEYS.narrow, "tenant-a", "user-a2", ["alerts:read"]);
  await addKey(s, KEYS.ops, "tenant-a", "user-a", ["rancher:read", "agents:run", "outbox:approve", "settings:write"]);
  // Everything is off by default. These two test accounts have turned the assistant on.
  for (const t of ["tenant-a", "tenant-b"]) await s.put(`prefs:${t}`, { assistant: { on: true, at: "2026-10-01T00:00:00.000Z", by: "fixture" }, agents: {} });
  await s.put(`obs:tenant-a:${OBS_A.id}`, OBS_A);
  await s.put(`obs:tenant-b:${OBS_B.id}`, OBS_B);
  await s.put("group:grp1", await groupWithMembers());
  for (const r of await sharedRecords()) await s.put(`shared:grp1:${r.id}`, r);
  await s.put(`doc:${DOC.id}`, DOC);
  return s;
}

/** Turn agents on for a test account, the way a rancher does in Settings. `enabled: false` leaves one off. */
export async function turnOn(store: MemoryStore, tenant: string, agents: Record<string, Record<string, unknown>>, assistant = true) {
  const at = "2026-10-01T00:00:00.000Z";
  await store.put(`prefs:${tenant}`, {
    assistant: { on: assistant, at, by: "fixture" },
    agents: Object.fromEntries(Object.entries(agents).map(([id, { enabled, ...settings }]) => [id, { on: enabled !== false, at, by: "fixture", settings, snooze_until: null }])),
  });
}

export async function testService(o: ServiceOverrides = {}) {
  const store = (o.store as MemoryStore | undefined) ?? (await seededStore());
  const overrides: ServiceOverrides = { store, publicLayers: new FakePublicLayers(), now: () => NOW, provider: null, ...o };
  const env = { LAYER_CACHE: memoryKV() };
  const svc = rancherService(env, overrides)!;
  return { svc, store, env, overrides };
}

export const ctxA = { tenantId: "tenant-a", userId: "user-a", plan: "rancher" as const, scopes: ["rancher:read" as Scope], client: "test" };
export const ctxB = { ...ctxA, tenantId: "tenant-b", userId: "user-b" };
export const ctxPublic = { ...ctxA, tenantId: "tenant-p", userId: "user-p", plan: "public" as const };
