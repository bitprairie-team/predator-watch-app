// Field mapping and normalization helpers shared by all adapters.
import type { BaseSourceConfig } from "../adapters/types";
import type { Geometry, NormalizedFeature, TimePrecision } from "../schema";

export type TimeMapping =
  | { field: string; format: "epoch-ms" | "iso" | "date-text" | "year"; precision?: TimePrecision }
  /** Use the layer's agency-reported edit date (e.g. editingInfo.dataLastEditDate). */
  | { fromLayer: true };

export interface FieldMapping {
  /** Field holding a stable native id. Defaults to the layer's object id field. */
  idField?: string;
  /**
   * Label template. Field names go in braces, e.g. "{Pack} pack" or "{name}".
   * Text without braces is used as a fixed label for every item.
   */
  label: string;
  observedAt?: TimeMapping;
  /** Display key -> source field. Only these fields are passed through. */
  details?: Record<string, string>;
}

type Attrs = Record<string, unknown>;

export function fieldsUsed(m: FieldMapping): string[] {
  const out = new Set<string>();
  if (m.idField) out.add(m.idField);
  for (const t of m.label.match(/\{([^}]+)\}/g) ?? []) out.add(t.slice(1, -1));
  if (m.observedAt && "field" in m.observedAt) out.add(m.observedAt.field);
  for (const f of Object.values(m.details ?? {})) out.add(f);
  return [...out];
}

const clean = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

export function renderLabel(m: FieldMapping, a: Attrs, fallback: string): string {
  let placeholders = 0;
  let filled = 0;
  const s = m.label
    .replace(/\{([^}]+)\}/g, (_, f: string) => {
      placeholders++;
      const v = clean(a[f]);
      if (v) filled++;
      return v;
    })
    .replace(/\s+/g, " ")
    .trim();
  // If every referenced field is empty, the template would be meaningless.
  if (placeholders > 0 && filled === 0) return fallback;
  return s || fallback;
}

/** Parse agency date text as a calendar date (UTC midnight), ignoring any time of day. */
function parseDateText(s: string): string | null {
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*(\d{4})(?:$|\s)/);
  if (m) {
    const mi = months.indexOf(m[1]!.slice(0, 3).toLowerCase());
    if (mi >= 0) return new Date(Date.UTC(Number(m[3]), mi, Number(m[2]))).toISOString();
  }
  // M/D/YYYY or MM/DD/YYYY, optionally followed by a time ("11/1/2026, 5:01 PM").
  const md = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:$|[,\sT])/);
  if (md) {
    const month = Number(md[1]), day = Number(md[2]), year = Number(md[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return new Date(Date.UTC(year, month - 1, day)).toISOString();
    }
  }
  const isoDay = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDay) return `${isoDay[1]}T00:00:00.000Z`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Keep only the UTC calendar date, so a "day" value never carries a time of day. */
export function dateOnly(iso: string | null): string | null {
  if (!iso) return iso;
  const day = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T00:00:00.000Z` : iso;
}

const SENSITIVE_DETAIL = /^(studbook|animal[_ -]?id)$/i;

/** Strip animal-id fields and truncate day-precision times for public output, including stale KV copies. */
export function sanitizePublicFeature(f: NormalizedFeature): NormalizedFeature {
  const details: NormalizedFeature["properties"]["details"] = {};
  for (const [k, v] of Object.entries(f.properties.details ?? {})) {
    if (!SENSITIVE_DETAIL.test(k)) details[k] = v;
  }
  let observed_at = f.properties.observed_at;
  if (observed_at && f.properties.observed_at_precision === "day") observed_at = dateOnly(observed_at);
  return { ...f, properties: { ...f.properties, details, observed_at } };
}

export function parseObserved(
  m: TimeMapping | undefined,
  a: Attrs,
  layerUpdatedMs: number | null,
): { observed_at: string | null; observed_at_precision: TimePrecision } {
  if (!m) return { observed_at: null, observed_at_precision: "dataset" };
  if ("fromLayer" in m) {
    return {
      observed_at: layerUpdatedMs ? new Date(layerUpdatedMs).toISOString() : null,
      observed_at_precision: "dataset",
    };
  }
  const v = a[m.field];
  if (v === null || v === undefined || v === "") return { observed_at: null, observed_at_precision: "dataset" };
  let iso: string | null = null;
  let precision: TimePrecision = m.precision ?? "instant";
  switch (m.format) {
    case "epoch-ms": {
      const n = Number(v);
      iso = Number.isFinite(n) ? new Date(n).toISOString() : null;
      break;
    }
    case "iso": {
      const t = Date.parse(String(v));
      iso = Number.isFinite(t) ? new Date(t).toISOString() : null;
      break;
    }
    case "date-text":
      iso = parseDateText(String(v));
      precision = m.precision ?? "day";
      break;
    case "year": {
      const y = Number(v);
      iso = Number.isInteger(y) && y > 1900 && y < 3000 ? new Date(Date.UTC(y, 0, 1)).toISOString() : null;
      precision = "year";
      break;
    }
  }
  if (iso && precision === "day") iso = dateOnly(iso);
  return { observed_at: iso, observed_at_precision: iso ? precision : "dataset" };
}

export function pickDetails(m: FieldMapping, a: Attrs): NormalizedFeature["properties"]["details"] {
  const out: NormalizedFeature["properties"]["details"] = {};
  for (const [key, field] of Object.entries(m.details ?? {})) {
    const v = a[field];
    if (v === undefined) continue;
    out[key] = typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "boolean" ? v : v === null ? null : String(v);
  }
  return out;
}

export function buildFeature(
  cfg: BaseSourceConfig,
  endpoint: string,
  mapping: FieldMapping,
  attrs: Attrs,
  geometry: Geometry | null,
  nativeId: string,
  receivedAt: string,
  layerUpdatedMs: number | null,
): NormalizedFeature {
  const id = `${cfg.id}:${nativeId}`;
  return {
    type: "Feature",
    id,
    geometry,
    properties: {
      id,
      source_id: cfg.id,
      source_name: cfg.name,
      category: cfg.category,
      species: cfg.species,
      agency: cfg.agency,
      label: renderLabel(mapping, attrs, cfg.name),
      ...parseObserved(mapping.observedAt, attrs, layerUpdatedMs),
      received_at: receivedAt,
      precision: cfg.precision,
      geometry_type: geometry?.type ?? "None",
      attribution: cfg.attribution,
      url: cfg.infoUrl || endpoint,
      license: cfg.license,
      details: pickDetails(mapping, attrs),
    },
  };
}
