// Join an ArcGIS table that has no geometry onto a second layer's polygons.
// Used when an agency publishes a count by district (or a similar unit) in a
// table, and publishes the unit boundaries as a separate map service.
//
// Rules:
// - Only table rows are drawn. A boundary with no table row is not a zero.
// - Every table row must match exactly one polygon. Anything else is rejected
//   so the last good copy stays up, rather than a partial map that looks complete.
// - Counts are copied. They are never summed, split, or invented.
// - The table's last edit date and a hash of the joined attributes skip the
//   geometry download when neither side has changed.

import { fetchJson, type PoliteOptions } from "../lib/http";
import { esriToGeoJson, type EsriGeometry } from "../lib/esri";
import { ensureUniqueIds } from "../lib/geometry";
import { fnv1a } from "../lib/hash";
import { buildFeature, fieldsUsed, type FieldMapping } from "../lib/normalize";
import type { NormalizedFeature } from "../schema";
import type { LayerMetadata } from "./arcgis";
import {
  UnusableSourceError,
  type AdapterResult,
  type BaseSourceConfig,
  type FetchContext,
  type SourceAdapter,
} from "./types";

export interface ArcGisJoinConfig {
  /** Attribute on the table, matched to `geometryKey`. */
  tableKey: string;
  /** Attribute on the polygon layer. */
  geometryKey: string;
  /** Fields copied from the table. The join key is always read too. */
  tableFields: string[];
  /**
   * Boundary attributes included in the change check, so an edit to the
   * outline or its labels is noticed without comparing coordinates.
   */
  boundaryFields?: string[];
  /**
   * Table field that must be a whole number from 0 to `maxCount`. A missing
   * or nonsense value rejects the result.
   */
  countField?: string;
  /** Largest accepted `countField` value. Defaults to 5000. */
  maxCount?: number;
}

export interface ArcGisJoinSourceConfig extends BaseSourceConfig {
  type: "arcgis-join";
  /** Table or layer URL that holds the values. Geometry on this layer is ignored. */
  tableUrl: string;
  /** Polygon layer the values are drawn on. */
  geometryUrl: string;
  join: ArcGisJoinConfig;
  fields: FieldMapping;
  /** Server-side generalization of the boundary, in degrees. Never adds precision. */
  maxAllowableOffset?: number;
  geometryPrecision?: number;
  pageSize?: number;
  /** Safety cap. More rows than this rejects the result instead of truncating it. */
  maxFeatures?: number;
  useApiKey?: boolean;
  http?: PoliteOptions;
}

interface EsriFeature {
  attributes: Record<string, unknown>;
  geometry?: EsriGeometry;
}

interface QueryResponse {
  features?: EsriFeature[];
  exceededTransferLimit?: boolean;
  objectIds?: number[];
  error?: { code: number; message: string };
}

interface TableRow {
  key: string;
  attrs: Record<string, unknown>;
}

const LAYER_URL = /^https:\/\/[^?#]+\/(FeatureServer|MapServer)\/\d+$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_MAX_COUNT = 5000;
const DEFAULT_MAX_FEATURES = 2000;
/** ArcGIS where-clauses stay short; district lists are chunked under this. */
const WHERE_CHUNK = 75;

export function validateArcGisJoinConfig(c: ArcGisJoinSourceConfig): string[] {
  const errs: string[] = [];
  if (!LAYER_URL.test(c.tableUrl)) errs.push(`${c.id}: tableUrl must be an https FeatureServer/MapServer layer URL`);
  if (!LAYER_URL.test(c.geometryUrl)) errs.push(`${c.id}: geometryUrl must be an https FeatureServer/MapServer layer URL`);
  if (c.tableUrl === c.geometryUrl) errs.push(`${c.id}: tableUrl and geometryUrl must be different layers`);
  const names = [c.join?.tableKey, c.join?.geometryKey, ...(c.join?.tableFields ?? []), ...(c.join?.boundaryFields ?? [])];
  if (!c.join?.tableKey || !c.join?.geometryKey) errs.push(`${c.id}: join.tableKey and join.geometryKey are required`);
  if (!c.join?.tableFields?.length) errs.push(`${c.id}: join.tableFields must name at least one field`);
  for (const name of names) if (name && !IDENT.test(name)) errs.push(`${c.id}: "${name}" is not a field name`);
  if (c.join?.countField && !c.join.tableFields?.includes(c.join.countField)) {
    errs.push(`${c.id}: join.countField must be one of join.tableFields`);
  }
  if (c.join?.maxCount !== undefined && (!Number.isInteger(c.join.maxCount) || c.join.maxCount < 0)) {
    errs.push(`${c.id}: join.maxCount must be a whole number`);
  }
  if (!c.fields?.label) errs.push(`${c.id}: fields.label is required`);
  return errs;
}

/**
 * District ids are compared as whole numbers, so a table value of 100 matches
 * a boundary value of "100". Anything else (blank, zero, text) does not match.
 */
export function districtKey(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "number" && !Number.isInteger(value)) return null;
  const s = String(value).trim();
  if (!/^\d{1,6}$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) return null;
  return String(n);
}

function wholeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function listed(keys: string[]): string {
  const shown = keys.slice(0, 8).join(", ");
  return keys.length > 8 ? `${shown} and ${keys.length - 8} more` : shown;
}

function attrText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value.trim() : String(value);
}

export class ArcGisJoinAdapter implements SourceAdapter {
  readonly endpoint: string;
  constructor(readonly config: ArcGisJoinSourceConfig) {
    const errs = validateArcGisJoinConfig(config);
    if (errs.length) throw new Error(errs.join("; "));
    this.endpoint = config.tableUrl;
  }

  private params(ctx: FetchContext, extra: Record<string, string>): string {
    const p = new URLSearchParams({ f: "json", ...extra });
    if (this.config.useApiKey && ctx.env.ARCGIS_API_KEY) p.set("token", ctx.env.ARCGIS_API_KEY);
    return p.toString();
  }

  private http(): PoliteOptions {
    return { ...this.config.http };
  }

  private async metadata(ctx: FetchContext, url: string): Promise<LayerMetadata> {
    const meta = await fetchJson<LayerMetadata>(ctx.fetch, `${url}?${this.params(ctx, {})}`, {
      ...this.http(),
      userAgent: ctx.env.USER_AGENT,
    });
    if (meta.error) throw new Error(`ArcGIS error ${meta.error.code}: ${meta.error.message}`);
    return meta;
  }

  private async query(ctx: FetchContext, url: string, params: Record<string, string>): Promise<QueryResponse> {
    const res = await fetchJson<QueryResponse>(ctx.fetch, `${url}/query?${this.params(ctx, params)}`, {
      ...this.http(),
      userAgent: ctx.env.USER_AGENT,
    });
    if (res.error) throw new Error(`ArcGIS query error ${res.error.code}: ${res.error.message}`);
    return res;
  }

  private async readAll(
    ctx: FetchContext,
    url: string,
    meta: LayerMetadata,
    base: Record<string, string>,
    cap: number,
    what: string,
  ): Promise<EsriFeature[]> {
    const oidField = meta.objectIdField ?? meta.fields?.find((f) => f.type === "esriFieldTypeOID")?.name ?? "OBJECTID";
    const maxRec = meta.maxRecordCount && meta.maxRecordCount > 0 ? meta.maxRecordCount : 1000;
    const pageSize = Math.min(this.config.pageSize ?? maxRec, maxRec);
    const raw: EsriFeature[] = [];
    const supportsPaging = meta.advancedQueryCapabilities?.supportsPagination !== false;

    const take = (got: EsriFeature[]) => {
      if (raw.length + got.length > cap) throw new UnusableSourceError(`${what} has more than ${cap} rows`);
      raw.push(...got);
    };

    if (supportsPaging) {
      let offset = 0;
      for (;;) {
        const page = await this.query(ctx, url, {
          ...base,
          orderByFields: oidField,
          resultOffset: String(offset),
          resultRecordCount: String(pageSize),
        });
        const got = page.features ?? [];
        take(got);
        offset += got.length;
        const more = page.exceededTransferLimit === true || (page.exceededTransferLimit === undefined && got.length === pageSize);
        if (!more || got.length === 0) break;
      }
    } else {
      const ids = (await this.query(ctx, url, { where: base.where!, returnIdsOnly: "true" })).objectIds ?? [];
      ids.sort((a, b) => a - b);
      if (ids.length > cap) throw new UnusableSourceError(`${what} has more than ${cap} rows`);
      for (let i = 0; i < ids.length; i += pageSize) {
        const page = await this.query(ctx, url, { ...base, objectIds: ids.slice(i, i + pageSize).join(",") });
        take(page.features ?? []);
      }
    }
    return raw;
  }

  private indexTable(features: EsriFeature[]): TableRow[] {
    const { tableKey, tableFields, countField, maxCount } = this.config.join;
    const limit = maxCount ?? DEFAULT_MAX_COUNT;
    const byKey = new Map<string, TableRow>();
    for (const f of features) {
      const key = districtKey(f.attributes[tableKey]);
      if (!key) throw new UnusableSourceError("A table row has no usable district id");
      if (byKey.has(key)) throw new UnusableSourceError(`More than one table row for district ${key}`);
      const attrs: Record<string, unknown> = {};
      for (const field of tableFields) attrs[field] = f.attributes[field];
      if (countField) {
        const n = wholeNumber(attrs[countField]);
        if (n === null || n > limit) throw new UnusableSourceError(`District ${key} has no usable ${countField} value`);
        attrs[countField] = n;
      }
      byKey.set(key, { key, attrs });
    }
    return [...byKey.values()].sort((a, b) => Number(a.key) - Number(b.key));
  }

  private indexBoundaries(features: EsriFeature[], what: string): Map<string, EsriFeature> {
    const field = this.config.join.geometryKey;
    const map = new Map<string, EsriFeature>();
    for (const f of features) {
      const key = districtKey(f.attributes[field]);
      if (!key) throw new UnusableSourceError(`${what} returned a feature with no usable district id`);
      if (map.has(key)) throw new UnusableSourceError(`More than one polygon for district ${key}`);
      map.set(key, f);
    }
    return map;
  }

  private requireMatch(rows: TableRow[], boundaries: Map<string, EsriFeature>): void {
    const missing = rows.filter((r) => !boundaries.has(r.key)).map((r) => r.key);
    if (missing.length) {
      throw new UnusableSourceError(`No hunting-district polygon for district ${listed(missing)}`);
    }
  }

  private stamp(rows: TableRow[], boundaries: Map<string, EsriFeature>): string {
    const fields = this.config.join.boundaryFields ?? [];
    const lines = rows.map((r) => {
      const b = boundaries.get(r.key)!.attributes;
      const count = this.config.join.countField ? String(r.attrs[this.config.join.countField]) : "";
      return [r.key, count, ...fields.map((f) => attrText(b[f]))].join("|");
    });
    return fnv1a(lines.join("\n"));
  }

  async load(ctx: FetchContext): Promise<AdapterResult> {
    const cap = this.config.maxFeatures ?? DEFAULT_MAX_FEATURES;
    const tableMeta = await this.metadata(ctx, this.config.tableUrl);
    const geometryMeta = await this.metadata(ctx, this.config.geometryUrl);
    const tableOid = tableMeta.objectIdField ?? "ObjectId";
    const geometryOid =
      geometryMeta.objectIdField ?? geometryMeta.fields?.find((f) => f.type === "esriFieldTypeOID")?.name ?? "OBJECTID";

    const tableFields = [...new Set([tableOid, this.config.join.tableKey, ...this.config.join.tableFields])];
    const rows = this.indexTable(
      await this.readAll(
        ctx,
        this.config.tableUrl,
        tableMeta,
        { where: "1=1", outFields: tableFields.join(","), returnGeometry: "false" },
        cap,
        "Table",
      ),
    );

    const lastEdit = tableMeta.editingInfo?.lastEditDate ?? null;
    const dataEdit = tableMeta.editingInfo?.dataLastEditDate ?? lastEdit;
    if (rows.length === 0) {
      return { changed: true, features: [], sourceUpdatedMs: lastEdit, validator: fnv1a("") };
    }

    const skip = new Set([this.config.join.tableKey, ...this.config.join.tableFields]);
    const geometryFields = [
      ...new Set(
        [geometryOid, this.config.join.geometryKey, ...fieldsUsed(this.config.fields), ...(this.config.join.boundaryFields ?? [])].filter(
          (f) => !skip.has(f),
        ),
      ),
    ];
    const keys = rows.map((r) => r.key);
    const attributeBase = { outFields: geometryFields.join(","), returnGeometry: "false" };
    const attributes = this.indexBoundaries(
      await this.readWhere(ctx, this.config.geometryUrl, geometryMeta, attributeBase, keys, cap, "Boundaries"),
      "Boundaries",
    );
    this.requireMatch(rows, attributes);
    const stamp = this.stamp(rows, attributes);

    const prev = ctx.previous;
    const sameEdit = prev !== undefined && prev.sourceUpdatedMs === lastEdit;
    if (prev?.hasData && prev.validator === stamp && sameEdit) {
      return { changed: false, sourceUpdatedMs: lastEdit, validator: stamp };
    }

    const shapeBase: Record<string, string> = { ...attributeBase, returnGeometry: "true", outSR: "4326" };
    if (this.config.maxAllowableOffset) shapeBase.maxAllowableOffset = String(this.config.maxAllowableOffset);
    if (this.config.geometryPrecision !== undefined) shapeBase.geometryPrecision = String(this.config.geometryPrecision);
    const shapes = this.indexBoundaries(
      await this.readWhere(ctx, this.config.geometryUrl, geometryMeta, shapeBase, keys, cap, "Boundaries"),
      "Boundaries",
    );
    this.requireMatch(rows, shapes);

    const receivedAt = ctx.now().toISOString();
    const features: NormalizedFeature[] = rows.map((row) => {
      const feature = shapes.get(row.key)!;
      const geometry = esriToGeoJson(feature.geometry);
      if (!geometry) throw new UnusableSourceError(`District ${row.key} has no usable polygon`);
      return buildFeature(
        this.config,
        this.endpoint,
        this.config.fields,
        { ...feature.attributes, ...row.attrs },
        geometry,
        row.key,
        receivedAt,
        dataEdit,
      );
    });
    return { changed: true, features: ensureUniqueIds(features), sourceUpdatedMs: lastEdit, validator: stamp };
  }

  /** Read the boundary layer for these district keys, in short where-clauses. */
  private async readWhere(
    ctx: FetchContext,
    url: string,
    meta: LayerMetadata,
    base: Record<string, string>,
    keys: string[],
    cap: number,
    what: string,
  ): Promise<EsriFeature[]> {
    const field = this.config.join.geometryKey;
    const out: EsriFeature[] = [];
    for (let i = 0; i < keys.length; i += WHERE_CHUNK) {
      const chunk = keys.slice(i, i + WHERE_CHUNK);
      const where = `${field} IN (${chunk.map((k) => `'${k}'`).join(",")})`;
      out.push(...(await this.readAll(ctx, url, meta, { ...base, where }, cap, what)));
      if (out.length > cap) throw new UnusableSourceError(`${what} has more than ${cap} rows`);
    }
    return out;
  }
}
