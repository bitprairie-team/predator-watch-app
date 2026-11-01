// The rancher assistant's tools. Each one answers from real data only: the
// public agency layers the map caches, the tenant's own records and settings,
// generalized shared reports, and stored reference documents. A tool returns
// `unknown` instead of guessing, and `planned` when the data needs a feature
// that is not built yet.
import type { AuditLog } from "../agents/audit";
import { ToolRegistry } from "../agents/registry";
import type { JsonSchema, SourceRef, ToolDefinition, ToolResult } from "../agents/types";
import type { NormalizedFeature, Precision } from "../schema";
import { distanceMiles, haversineMiles, intersects, pointInGeometry, type LonLat } from "./geo";
import type { RancherData, PublicLayer } from "./data";
import type { Observation, Ranch } from "./model";
import type { SharedCell } from "./tiers";

export interface RancherDeps {
  data: RancherData;
  audit: AuditLog;
}

type Tool = ToolDefinition<any, any, RancherDeps>;

const PRECISION_TEXT: Record<Precision, string> = {
  "hex-cell": "a generalized cell chosen by the agency, not an exact location",
  "pack-territory": "an agency-drawn pack area, not where individual animals are",
  "distribution-area": "a general range or distribution area",
  "management-unit": "an administrative or regulatory boundary",
  "incident-perimeter": "a mapped incident perimeter",
  "alert-area": "an alert or advisory area",
  exact: "the exact geometry the agency publishes",
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const iso = (d: Date) => d.toISOString();

// ------------------------------------------------------------------ sources

function layerSource(layer: PublicLayer, features: NormalizedFeature[]): SourceRef {
  const observed = features
    .map((f) => f.properties.observed_at)
    .filter((x): x is string => !!x)
    .sort()
    .pop();
  return {
    id: `layer:${layer.info.id}`,
    kind: "public-layer",
    title: layer.info.name,
    publisher: layer.info.agency,
    url: layer.info.info_url,
    observed_at: observed ?? layer.status.source_updated_at,
    received_at: layer.status.received_at,
  };
}

function ownSource(rows: Observation[], tenantName: string): SourceRef {
  const sorted = [...rows].sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  return {
    id: "tenant:observations",
    kind: "tenant-data",
    title: "Your ranch records",
    publisher: tenantName,
    url: null,
    observed_at: sorted.at(-1)?.observed_at ?? null,
    received_at: sorted.map((r) => r.received_at).sort().at(-1) ?? null,
  };
}

function sharedSource(groupId: string, groupName: string, cells: SharedCell[]): SourceRef {
  return {
    id: `shared:${groupId}`,
    kind: "shared-data",
    title: `Shared reports from ${groupName} (generalized)`,
    publisher: groupName,
    url: null,
    observed_at: cells.map((c) => c.latest_observed_on).sort().at(-1) ?? null,
    received_at: cells.map((c) => c.latest_received_at).sort().at(-1) ?? null,
  };
}

function configSource(id: string, title: string, publisher: string, url: string | null, verified: string | null): SourceRef {
  return { id, kind: "tenant-config", title, publisher, url, observed_at: verified, received_at: verified };
}

// ------------------------------------------------------------------ shared schemas

const ranchIdProp: JsonSchema = { type: "string", maxLength: 64, description: "Ranch id. Defaults to your first ranch." };

const featureSchema: JsonSchema = {
  type: "object",
  required: ["label", "source_id", "observed_at", "precision"],
  properties: {
    label: { type: "string" },
    source_id: { type: "string" },
    species: { type: ["string", "null"] },
    observed_at: { type: ["string", "null"] },
    observed_at_precision: { type: "string" },
    precision: { type: "string" },
    distance_miles: { type: "number" },
    in_window: { type: ["boolean", "null"] },
  },
};

const ownObsSchema: JsonSchema = {
  type: "object",
  required: ["id", "species", "kind", "lat", "lon", "observed_at"],
  properties: {
    id: { type: "string" },
    species: { type: "string" },
    kind: { type: "string" },
    lat: { type: "number" },
    lon: { type: "number" },
    observed_at: { type: "string" },
    received_at: { type: "string" },
    distance_miles: { type: "number" },
    notes: { type: "string" },
  },
};

const cellSchema: JsonSchema = {
  type: "object",
  required: ["cell_id", "center", "report_count", "latest_observed_on", "precision"],
  properties: {
    cell_id: { type: "string" },
    center: { type: "object", properties: { lat: { type: "number" }, lon: { type: "number" } } },
    species: { type: "object" },
    report_count: { type: "integer" },
    latest_observed_on: { type: "string" },
    precision: { type: "string" },
    distance_miles: { type: "number" },
  },
};

const activitySchema: JsonSchema = {
  type: "object",
  required: ["ranch", "public_layers", "your_records", "shared_cells", "gaps"],
  properties: {
    ranch: { type: ["object", "null"] },
    window_days: { type: "integer" },
    radius_miles: { type: "number" },
    public_layers: { type: "array", items: featureSchema },
    your_records: { type: "array", items: ownObsSchema },
    shared_cells: { type: "array", items: cellSchema },
    gaps: { type: "array", items: { type: "string" } },
  },
};

// ------------------------------------------------------------------ helpers

function featureRow(f: NormalizedFeature, point: LonLat | null, since: Date) {
  const p = f.properties;
  const t = p.observed_at ? Date.parse(p.observed_at) : NaN;
  const precise = p.observed_at_precision === "instant" || p.observed_at_precision === "day";
  return {
    label: p.label,
    source_id: p.source_id,
    species: p.species,
    observed_at: p.observed_at,
    observed_at_precision: p.observed_at_precision,
    precision: p.precision,
    ...(point ? { distance_miles: round1(distanceMiles(point, f.geometry)) } : {}),
    in_window: precise && Number.isFinite(t) ? t >= since.getTime() : null,
  };
}

function layerGap(layer: PublicLayer): string | null {
  if (layer.status.state === "never" || layer.features.length === 0 && !layer.status.received_at)
    return `${layer.info.name} (${layer.info.agency}) has not loaded yet, so I can't say what it shows.`;
  if (layer.status.state === "error") return `${layer.info.name}: the last refresh failed; showing the copy received ${layer.status.received_at ?? "at an unknown time"}.`;
  return null;
}

async function needRanch(d: RancherData, ranchId?: string): Promise<Ranch | ToolResult> {
  const r = await d.ranch(ranchId);
  if (r) return r;
  return {
    data: { ranch: null, public_layers: [], your_records: [], shared_cells: [], gaps: ["No ranch location is on file."] },
    sources: [],
    unknown: ranchId ? `No ranch with id ${ranchId} is on file for your account.` : "No ranch location is on file for your account yet.",
  };
}

const isResult = (x: unknown): x is ToolResult => typeof x === "object" && x !== null && "sources" in x && "data" in x;

interface ActivityArgs {
  ranch_id?: string;
  radius_miles: number;
  days: number;
  include_shared: boolean;
}

async function activityNear(deps: RancherDeps, a: ActivityArgs): Promise<ToolResult> {
  const d = deps.data;
  const ranch = await needRanch(d, a.ranch_id);
  if (isResult(ranch)) return ranch;
  const t = await d.tenant();
  const now = d.now();
  const since = new Date(now.getTime() - a.days * 86400_000);
  const here: LonLat = [ranch.location.lon, ranch.location.lat];
  const sources: SourceRef[] = [];
  const gaps: string[] = [];

  const layers = await d.publicLayers.byCategory(["wolf-activity"]);
  const publicRows: ReturnType<typeof featureRow>[] = [];
  for (const layer of layers) {
    const gap = layerGap(layer);
    if (gap) gaps.push(gap);
    const near = layer.features.filter((f) => distanceMiles(here, f.geometry) <= a.radius_miles);
    const rows = near.map((f) => featureRow(f, here, since)).filter((r) => r.in_window !== false);
    if (rows.length) {
      publicRows.push(...rows);
      sources.push(layerSource(layer, near));
    }
  }

  const own = (await d.ownObservations())
    .filter((o) => Date.parse(o.observed_at) >= since.getTime())
    .map((o) => ({ ...o, distance_miles: round1(haversineMiles(here, [o.lon, o.lat])) }))
    .filter((o) => o.distance_miles <= a.radius_miles)
    .sort((x, y) => y.observed_at.localeCompare(x.observed_at));
  if (own.length) sources.push(ownSource(own, t?.name ?? "Your account"));

  const shared: (SharedCell & { distance_miles: number })[] = [];
  if (a.include_shared) {
    for (const g of await d.sharedCells()) {
      const cells = g.cells
        .filter((c) => c.latest_observed_on >= iso(since).slice(0, 10))
        .map((c) => ({ ...c, distance_miles: round1(distanceMiles(here, c.geometry)) }))
        .filter((c) => c.distance_miles <= a.radius_miles);
      if (cells.length) {
        shared.push(...cells);
        sources.push(sharedSource(g.policy.id, g.policy.name, cells));
      }
    }
  }

  const result: ToolResult = {
    data: {
      ranch: { id: ranch.id, name: ranch.name },
      window_days: a.days,
      radius_miles: a.radius_miles,
      public_layers: publicRows.sort((x, y) => (x.distance_miles ?? 0) - (y.distance_miles ?? 0)).slice(0, 50),
      your_records: own.slice(0, 50).map(({ share: _s, sensitive: _d, ranch_id: _r, ...o }) => o),
      shared_cells: shared.slice(0, 50).map(({ geometry: _g, group: _gr, tier: _t, latest_received_at: _r, ...c }) => c),
      gaps,
    },
    sources,
  };
  if (!sources.length)
    result.unknown = `None of the data I can read shows wolf activity within ${a.radius_miles} miles of ${ranch.name} in the last ${a.days} days. That is not proof there was none; agency layers only cover what they track.`;
  return result;
}

// ------------------------------------------------------------------ tools

const recentActivity: Tool = {
  name: "recent_predator_activity",
  title: "Recent predator activity near my ranch",
  description:
    "Wolf activity near one of the caller's ranches from public agency layers, the caller's own records (exact), and shared rancher reports (generalized cells, delayed). Returns sources with observed and received times.",
  scope: "activity:read",
  entitlement: "rancher_assistant",
  readOnly: true,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ranch_id: ranchIdProp,
      radius_miles: { type: "number", minimum: 1, maximum: 100, default: 25 },
      days: { type: "integer", minimum: 1, maximum: 90, default: 14 },
      include_shared: { type: "boolean", default: true },
    },
  },
  outputSchema: activitySchema,
  handler: (i: ActivityArgs, deps) => activityNear(deps, i),
};

const allotmentActivity: Tool = {
  name: "allotment_wolf_activity",
  title: "Wolf activity in my allotment",
  description:
    "Wolf activity inside or touching one of the caller's grazing allotments, using the allotment boundary on file for the account.",
  scope: "activity:read",
  entitlement: "rancher_assistant",
  readOnly: true,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      allotment_id: { type: "string", maxLength: 64, description: "Allotment id. Defaults to the first allotment on file." },
      days: { type: "integer", minimum: 1, maximum: 90, default: 30 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["allotment", "public_layers", "your_records", "shared_cells", "gaps"],
    properties: {
      allotment: { type: ["object", "null"] },
      public_layers: { type: "array", items: featureSchema },
      your_records: { type: "array", items: ownObsSchema },
      shared_cells: { type: "array", items: cellSchema },
      gaps: { type: "array", items: { type: "string" } },
    },
  },
  async handler(i: { allotment_id?: string; days: number }, deps) {
    const d = deps.data;
    const t = await d.tenant();
    const all = (t?.ranches ?? []).flatMap((r) => r.allotments.map((a) => ({ ...a, ranch: r })));
    const al = i.allotment_id ? all.find((a) => a.id === i.allotment_id) : all[0];
    if (!al) {
      return {
        data: { allotment: null, public_layers: [], your_records: [], shared_cells: [], gaps: [] },
        sources: [],
        unknown: "No allotment boundary is on file for your account, so I can't check inside it.",
        planned: "Looking up allotment boundaries from the agency allotment layers by allotment number.",
      };
    }
    const since = new Date(d.now().getTime() - i.days * 86400_000);
    const sources: SourceRef[] = [
      configSource(`allotment:${al.id}`, `${al.name} allotment boundary`, al.geometry_source.publisher, al.geometry_source.url, al.geometry_source.received_at),
    ];
    const gaps: string[] = [];
    const publicRows: ReturnType<typeof featureRow>[] = [];
    for (const layer of await d.publicLayers.byCategory(["wolf-activity"])) {
      const gap = layerGap(layer);
      if (gap) gaps.push(gap);
      const hit = layer.features.filter((f) => intersects(f.geometry, al.geometry));
      const rows = hit.map((f) => featureRow(f, null, since)).filter((r) => r.in_window !== false);
      if (rows.length) {
        publicRows.push(...rows);
        sources.push(layerSource(layer, hit));
      }
    }
    const own = (await d.ownObservations()).filter(
      (o) => Date.parse(o.observed_at) >= since.getTime() && pointInGeometry([o.lon, o.lat], al.geometry),
    );
    if (own.length) sources.push(ownSource(own, t?.name ?? "Your account"));
    const shared: SharedCell[] = [];
    for (const g of await d.sharedCells()) {
      const cells = g.cells.filter((c) => c.latest_observed_on >= iso(since).slice(0, 10) && intersects(c.geometry, al.geometry));
      if (cells.length) {
        shared.push(...cells);
        sources.push(sharedSource(g.policy.id, g.policy.name, cells));
      }
    }
    const result: ToolResult = {
      data: {
        allotment: { id: al.id, name: al.name, managing_agency: al.managing_agency, agency_allotment_id: al.agency_allotment_id ?? null, ranch: al.ranch.name },
        public_layers: publicRows.slice(0, 50),
        your_records: own.slice(0, 50).map(({ share: _s, sensitive: _d, ranch_id: _r, ...o }) => o),
        shared_cells: shared.slice(0, 50).map(({ geometry: _g, group: _gr, tier: _t, latest_received_at: _r, ...c }) => c),
        gaps,
      },
      sources,
    };
    if (sources.length === 1)
      result.unknown = `None of the data I can read shows wolf activity in the ${al.name} allotment in the last ${i.days} days. That is not proof there was none.`;
    return result;
  },
};

const fireWeather: Tool = {
  name: "fire_weather_alerts",
  title: "Fire and weather alerts near me",
  description: "Active wildfire perimeters and weather watches and warnings near one of the caller's ranches, from the public agency layers.",
  scope: "alerts:read",
  entitlement: "rancher_assistant",
  readOnly: true,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { ranch_id: ranchIdProp, radius_miles: { type: "number", minimum: 1, maximum: 200, default: 50 } },
  },
  outputSchema: {
    type: "object",
    required: ["ranch", "alerts", "gaps"],
    properties: { ranch: { type: ["object", "null"] }, alerts: { type: "array", items: featureSchema }, gaps: { type: "array", items: { type: "string" } } },
  },
  async handler(i: { ranch_id?: string; radius_miles: number }, deps) {
    const d = deps.data;
    const ranch = await needRanch(d, i.ranch_id);
    if (isResult(ranch)) return { data: { ranch: null, alerts: [], gaps: [] }, sources: [], unknown: ranch.unknown };
    const here: LonLat = [ranch.location.lon, ranch.location.lat];
    const sources: SourceRef[] = [];
    const gaps: string[] = [];
    const alerts: ReturnType<typeof featureRow>[] = [];
    for (const layer of await d.publicLayers.byCategory(["context"])) {
      const gap = layerGap(layer);
      if (gap) gaps.push(gap);
      const near = layer.features.filter((f) => distanceMiles(here, f.geometry) <= i.radius_miles);
      // Sources are cited even when nothing is near, so "no alerts" is a sourced answer.
      if (!gap) sources.push(layerSource(layer, near));
      alerts.push(...near.map((f) => featureRow(f, here, new Date(0))));
    }
    alerts.sort((a, b) => (a.distance_miles ?? 0) - (b.distance_miles ?? 0));
    const result: ToolResult = { data: { ranch: { id: ranch.id, name: ranch.name }, alerts: alerts.slice(0, 50), gaps }, sources };
    if (!sources.length) result.unknown = "The fire and weather layers have not loaded, so I can't say whether there are alerts.";
    return result;
  },
};

const contacts: Tool = {
  name: "agency_contacts_and_reporting",
  title: "Who to call and how to report",
  description:
    "The agency points of contact and the reporting or depredation process on file for the caller's account. Returns only entries the account has verified, with who published them.",
  scope: "directory:read",
  entitlement: "rancher_assistant",
  readOnly: true,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { topic: { type: "string", enum: ["depredation", "sighting", "general"], default: "depredation" } },
  },
  outputSchema: {
    type: "object",
    required: ["contacts", "processes"],
    properties: { contacts: { type: "array", items: { type: "object" } }, processes: { type: "array", items: { type: "object" } } },
  },
  async handler(i: { topic: string }, deps) {
    const t = await deps.data.tenant();
    const contacts = t?.contacts ?? [];
    const processes = (t?.reporting ?? []).filter((p) => p.topic === i.topic || p.topic === "general");
    const sources: SourceRef[] = [
      ...contacts.map((c, n) => configSource(`contact:${n}`, `${c.role}: ${c.name}, ${c.organization}`, c.source.publisher, c.source.url, c.source.verified_at)),
      ...processes.map((p, n) => configSource(`process:${n}`, p.title, p.source.publisher, p.source.url, p.source.verified_at)),
    ];
    const result: ToolResult = {
      data: { contacts: contacts.map(({ source: _s, ...c }) => c), processes: processes.map(({ source: _s, ...p }) => p) },
      sources,
    };
    if (!contacts.length && !processes.length) {
      result.unknown = "No agency contacts or reporting steps are on file for your account. I won't guess a phone number or process.";
      result.planned = "A verified agency directory for each area, kept current by the Predator Watch team.";
    }
    return result;
  },
};

const freshness: Tool = {
  name: "data_freshness",
  title: "What the data means and how fresh it is",
  description:
    "For each data layer: who publishes it, how often it updates, how precise it is, when it was observed and when this system received it, and limits to keep in mind. Also explains the private data tiers.",
  scope: "docs:read",
  entitlement: "rancher_assistant",
  readOnly: true,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { source_id: { type: "string", maxLength: 64, description: "One layer id. Omit for all layers." } },
  },
  outputSchema: {
    type: "object",
    required: ["layers", "private_tiers"],
    properties: { layers: { type: "array", items: { type: "object" } }, private_tiers: { type: "array", items: { type: "string" } } },
  },
  async handler(i: { source_id?: string }, deps) {
    const layers = await deps.data.publicLayers.byCategory(["wolf-activity", "wolf-management", "context"], i.source_id ? [i.source_id] : undefined);
    const rows = layers.map((l) => ({
      id: l.info.id,
      name: l.info.name,
      publisher: l.info.agency,
      category: l.info.category,
      cadence: l.info.cadence,
      precision: PRECISION_TEXT[l.info.precision],
      notes: l.info.notes ?? null,
      license: l.info.license,
      state: l.status.state,
      agency_last_edit: l.status.source_updated_at,
      received_at: l.status.received_at,
      last_checked_at: l.status.checked_at,
      feature_count: l.status.feature_count,
    }));
    const result: ToolResult = {
      data: {
        layers: rows,
        private_tiers: [
          "Your own records: shown to you at full precision.",
          "Other ranchers' shared reports: grouped into 1 to 2 mile cells and shown only after a 48 to 72 hour delay, with no names.",
          "During den season some cells are held back and not shown at all.",
          "Nothing private is shown on the public map.",
        ],
      },
      sources: layers.map((l) => layerSource(l, l.features)),
    };
    if (!layers.length) result.unknown = i.source_id ? `There is no layer with id ${i.source_id}.` : "No layers are configured.";
    return result;
  },
};

const deterrents: Tool = {
  name: "nonlethal_deterrents",
  title: "Nonlethal deterrent information",
  description:
    "Passages about nonlethal deterrents from agency and extension documents stored for this account. Only returns text from those documents, with the document cited.",
  scope: "docs:read",
  entitlement: "rancher_assistant",
  readOnly: true,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { query: { type: "string", maxLength: 200, description: "What you want to know, for example 'fladry' or 'range riders'." } },
  },
  outputSchema: {
    type: "object",
    required: ["documents"],
    properties: { documents: { type: "array", items: { type: "object" } } },
  },
  async handler(i: { query?: string }, deps) {
    const words = (i.query ?? "").toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const docs = (await deps.data.documents()).filter((doc) => doc.topics.includes("nonlethal-deterrents"));
    const scored = docs
      .map((doc) => {
        const text = `${doc.title} ${doc.excerpts.join(" ")}`.toLowerCase();
        const score = words.length ? words.filter((w) => text.includes(w)).length : 1;
        const excerpts = words.length ? doc.excerpts.filter((e) => words.some((w) => e.toLowerCase().includes(w))) : doc.excerpts;
        return { doc, score, excerpts: excerpts.length ? excerpts : doc.excerpts.slice(0, 2) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    const result: ToolResult = {
      data: { documents: scored.map((s) => ({ id: s.doc.id, title: s.doc.title, publisher: s.doc.publisher, excerpts: s.excerpts.slice(0, 4) })) },
      sources: scored.map((s) => ({
        id: `doc:${s.doc.id}`,
        kind: "document" as const,
        title: s.doc.title,
        publisher: s.doc.publisher,
        url: s.doc.url,
        observed_at: s.doc.published_at,
        received_at: s.doc.retrieved_at,
      })),
    };
    if (!scored.length) {
      result.unknown = "I don't have an agency or extension document on file that covers that. Anything else I say about it is general information, not from your Predator Watch documents.";
      result.planned = "A reviewed library of agency and extension publications on nonlethal deterrents.";
    }
    return result;
  },
};

const weekly: Tool = {
  name: "weekly_summary",
  title: "Summarize this week",
  description: "A seven-day roll-up for one ranch: wolf activity nearby, fire and weather alerts, your own records by type, and data gaps.",
  scope: "summary:read",
  entitlement: "rancher_assistant",
  readOnly: true,
  inputSchema: { type: "object", additionalProperties: false, properties: { ranch_id: ranchIdProp } },
  outputSchema: {
    type: "object",
    required: ["ranch", "activity", "alerts", "your_records_by_kind", "gaps"],
    properties: {
      ranch: { type: ["object", "null"] },
      activity: { type: "object" },
      alerts: { type: "array", items: featureSchema },
      your_records_by_kind: { type: "object" },
      gaps: { type: "array", items: { type: "string" } },
      window: { type: "object" },
    },
  },
  async handler(i: { ranch_id?: string }, deps, ctx) {
    const act = await recentActivity.handler({ ranch_id: i.ranch_id, radius_miles: 25, days: 7, include_shared: true }, deps, ctx);
    const fw = await fireWeather.handler({ ranch_id: i.ranch_id, radius_miles: 50 }, deps, ctx);
    const a = act.data as { ranch: unknown; public_layers: unknown[]; your_records: { kind: string }[]; shared_cells: unknown[]; gaps: string[] };
    const f = fw.data as { alerts: unknown[]; gaps: string[] };
    const byKind: Record<string, number> = {};
    for (const r of a.your_records) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    const seen = new Set<string>();
    const sources = [...act.sources, ...fw.sources].filter((s) => !seen.has(s.id) && seen.add(s.id));
    const result: ToolResult = {
      data: {
        ranch: a.ranch,
        activity: { public_layer_items: a.public_layers.length, your_records: a.your_records.length, shared_cells: a.shared_cells.length, items: a.public_layers.slice(0, 10) },
        alerts: f.alerts.slice(0, 20),
        your_records_by_kind: byKind,
        gaps: [...new Set([...a.gaps, ...f.gaps])],
        // The window this summary covers, so an answer can state it from data.
        window: { days: 7, activity_radius_miles: 25, alerts_radius_miles: 50 },
      },
      sources,
    };
    if (!sources.length) result.unknown = act.unknown ?? "I don't have data for this week.";
    return result;
  },
};

const auditTool: Tool = {
  name: "my_audit_log",
  title: "Recent assistant activity on my account",
  description: "The most recent tool calls made on the caller's account: who, which tool, when, outcome, and sources used.",
  scope: "audit:read",
  entitlement: "rancher_assistant",
  readOnly: true,
  inputSchema: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 20 } } },
  outputSchema: { type: "object", required: ["entries"], properties: { entries: { type: "array", items: { type: "object" } } } },
  async handler(i: { limit: number }, deps, ctx) {
    const entries = await deps.audit.list(ctx, i.limit);
    return {
      data: { entries: entries.map(({ input: _i, ...e }) => e) },
      sources: [{ id: "audit", kind: "tenant-data", title: "Audit log", publisher: "Predator Watch", url: null, observed_at: entries[0]?.at ?? null, received_at: entries[0]?.at ?? null }],
    };
  },
};

export const RANCHER_TOOLS: Tool[] = [recentActivity, allotmentActivity, fireWeather, contacts, freshness, deterrents, weekly, auditTool];

export function rancherRegistry(): ToolRegistry<RancherDeps> {
  const r = new ToolRegistry<RancherDeps>();
  for (const t of RANCHER_TOOLS) r.register(t);
  return r;
}
