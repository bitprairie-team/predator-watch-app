// Generic adapter for Esri ArcGIS REST FeatureServer and MapServer layers.
// Adding a layer is config only: a layer URL plus a field mapping.
//
// Behaviour:
// - Reads layer metadata (`<layer>?f=json`) for name, maxRecordCount,
//   pagination support, object id field and editingInfo.lastEditDate.
// - Change detection: if the agency's lastEditDate has not moved since the
//   previous fetch, the features are not downloaded again.
// - Queries with outSR=4326 and pages with resultOffset while the server
//   reports exceededTransferLimit (or a full page). Servers without pagination
//   support fall back to fetching object ids, then features in id batches.
// - All requests go through politeFetch (per-host spacing, timeouts, retries).
// - An optional ArcGIS API key comes only from the ARCGIS_API_KEY env var and
//   is sent only for sources that set useApiKey: true.

import { fetchJson, type PoliteOptions } from "../lib/http";
import { esriToGeoJson, type EsriGeometry } from "../lib/esri";
import { ensureUniqueIds } from "../lib/geometry";
import { buildFeature, fieldsUsed, type FieldMapping } from "../lib/normalize";
import type { NormalizedFeature } from "../schema";
import type { AdapterResult, BaseSourceConfig, FetchContext, SourceAdapter } from "./types";

export interface ArcGisSourceConfig extends BaseSourceConfig {
  type: "arcgis";
  /** Layer URL, ending in /FeatureServer/<n> or /MapServer/<n>. */
  url: string;
  where?: string;
  fields: FieldMapping;
  /** Server-side generalization in degrees (e.g. 0.001 ~ 100 m). Never adds precision. */
  maxAllowableOffset?: number;
  /** Decimal places for returned coordinates. */
  geometryPrecision?: number;
  /** Page size; capped by the layer's maxRecordCount. */
  pageSize?: number;
  /** Safety cap on total features stored. */
  maxFeatures?: number;
  useApiKey?: boolean;
  http?: PoliteOptions;
  /**
   * When set, `url` is a FeatureServer or MapServer root (no layer id). On
   * each fetch the adapter lists the service layers and uses the one whose
   * name starts with `namePrefix`, preferring the newest YYYYMMDD suffix.
   * Use this when an agency republishes a layer under a dated name.
   */
  discoverLayer?: { namePrefix: string };
}

export interface LayerMetadata {
  name?: string;
  type?: string;
  geometryType?: string;
  maxRecordCount?: number;
  objectIdField?: string;
  fields?: { name: string; type: string }[];
  editingInfo?: { lastEditDate?: number; dataLastEditDate?: number };
  advancedQueryCapabilities?: { supportsPagination?: boolean };
  copyrightText?: string;
  error?: { code: number; message: string };
}

interface QueryResponse {
  features?: { attributes: Record<string, unknown>; geometry?: EsriGeometry }[];
  exceededTransferLimit?: boolean;
  objectIds?: number[];
  objectIdFieldName?: string;
  error?: { code: number; message: string };
}

const LAYER_URL = /^https:\/\/[^?#]+\/(FeatureServer|MapServer)\/\d+$/;
const SERVICE_URL = /^https:\/\/[^?#]+\/(FeatureServer|MapServer)\/?$/;

export function validateArcGisConfig(c: ArcGisSourceConfig): string[] {
  const errs: string[] = [];
  if (c.discoverLayer) {
    if (!c.discoverLayer.namePrefix) errs.push(`${c.id}: discoverLayer.namePrefix is required`);
    if (!SERVICE_URL.test(c.url)) errs.push(`${c.id}: url must be an https FeatureServer/MapServer root when discoverLayer is set`);
  } else if (!LAYER_URL.test(c.url)) {
    errs.push(`${c.id}: url must be an https FeatureServer/MapServer layer URL`);
  }
  if (!c.fields?.label) errs.push(`${c.id}: fields.label is required`);
  return errs;
}

/** Pick the current layer id from a service listing when names are dated. */
export function pickDatedLayer(
  layers: { id: number; name?: string }[] | undefined,
  namePrefix: string,
): { id: number; name: string } {
  const matches = (layers ?? [])
    .filter((l) => typeof l.id === "number" && (l.name ?? "").startsWith(namePrefix))
    .map((l) => {
      const m = (l.name ?? "").match(/(\d{8})$/);
      return { id: l.id, name: l.name ?? "", stamp: m ? m[1]! : "" };
    })
    .sort((a, b) => b.stamp.localeCompare(a.stamp) || b.id - a.id);
  if (!matches.length) throw new Error(`no layer named ${namePrefix}*`);
  return { id: matches[0]!.id, name: matches[0]!.name };
}

export class ArcGisAdapter implements SourceAdapter {
  readonly endpoint: string;
  constructor(readonly config: ArcGisSourceConfig) {
    const errs = validateArcGisConfig(config);
    if (errs.length) throw new Error(errs.join("; "));
    this.endpoint = config.url;
  }

  private params(ctx: FetchContext, extra: Record<string, string>): string {
    const p = new URLSearchParams({ f: "json", ...extra });
    if (this.config.useApiKey && ctx.env.ARCGIS_API_KEY) p.set("token", ctx.env.ARCGIS_API_KEY);
    return p.toString();
  }

  private http(ctx: FetchContext): PoliteOptions {
    return { userAgent: ctx.env.USER_AGENT, ...this.config.http };
  }

  /** Resolved layer URL for this load (stable `config.url` when no discovery). */
  private async layerUrl(ctx: FetchContext): Promise<string> {
    if (!this.config.discoverLayer) return this.config.url;
    const root = this.config.url.replace(/\/$/, "");
    const listing = await fetchJson<{ layers?: { id: number; name?: string }[]; error?: { code: number; message: string } }>(
      ctx.fetch,
      `${root}?${this.params(ctx, {})}`,
      this.http(ctx),
    );
    if (listing.error) throw new Error(`ArcGIS error ${listing.error.code}: ${listing.error.message}`);
    const layer = pickDatedLayer(listing.layers, this.config.discoverLayer.namePrefix);
    return `${root}/${layer.id}`;
  }

  async metadata(ctx: FetchContext, url?: string): Promise<LayerMetadata> {
    const meta = await fetchJson<LayerMetadata>(
      ctx.fetch,
      `${url ?? this.config.url}?${this.params(ctx, {})}`,
      this.http(ctx),
    );
    if (meta.error) throw new Error(`ArcGIS error ${meta.error.code}: ${meta.error.message}`);
    return meta;
  }

  async load(ctx: FetchContext): Promise<AdapterResult> {
    const url = await this.layerUrl(ctx);
    const meta = await this.metadata(ctx, url);
    const lastEdit = meta.editingInfo?.lastEditDate ?? null;
    const dataEdit = meta.editingInfo?.dataLastEditDate ?? lastEdit;
    const prev = ctx.previous;
    if (prev?.hasData && lastEdit !== null && prev.sourceUpdatedMs === lastEdit) {
      return { changed: false, sourceUpdatedMs: lastEdit, validator: null };
    }

    const oidField = meta.objectIdField ?? meta.fields?.find((f) => f.type === "esriFieldTypeOID")?.name ?? "OBJECTID";
    const idField = this.config.fields.idField ?? oidField;
    const outFields = [...new Set([oidField, idField, ...fieldsUsed(this.config.fields)])].join(",");
    const maxRec = meta.maxRecordCount && meta.maxRecordCount > 0 ? meta.maxRecordCount : 1000;
    const pageSize = Math.min(this.config.pageSize ?? maxRec, maxRec);
    const cap = this.config.maxFeatures ?? 20_000;

    const base: Record<string, string> = {
      where: this.config.where ?? "1=1",
      outFields,
      returnGeometry: "true",
      outSR: "4326",
    };
    if (this.config.maxAllowableOffset) base.maxAllowableOffset = String(this.config.maxAllowableOffset);
    if (this.config.geometryPrecision !== undefined) base.geometryPrecision = String(this.config.geometryPrecision);

    const raw: NonNullable<QueryResponse["features"]> = [];
    const supportsPaging = meta.advancedQueryCapabilities?.supportsPagination !== false;

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
        raw.push(...got);
        offset += got.length;
        const more = page.exceededTransferLimit === true || (page.exceededTransferLimit === undefined && got.length === pageSize);
        if (!more || got.length === 0 || raw.length >= cap) break;
      }
    } else {
      const ids = (await this.query(ctx, url, { where: base.where!, returnIdsOnly: "true" })).objectIds ?? [];
      ids.sort((a, b) => a - b);
      for (let i = 0; i < ids.length && raw.length < cap; i += pageSize) {
        const page = await this.query(ctx, url, { ...base, objectIds: ids.slice(i, i + pageSize).join(",") });
        raw.push(...(page.features ?? []));
      }
    }

    const receivedAt = ctx.now().toISOString();
    const features: NormalizedFeature[] = raw.slice(0, cap).map((f) =>
      buildFeature(
        this.config,
        this.endpoint,
        this.config.fields,
        f.attributes,
        esriToGeoJson(f.geometry),
        String(f.attributes[idField] ?? f.attributes[oidField]),
        receivedAt,
        dataEdit,
      ),
    );
    return { changed: true, features: ensureUniqueIds(features), sourceUpdatedMs: lastEdit, validator: null };
  }

  private async query(ctx: FetchContext, url: string, params: Record<string, string>): Promise<QueryResponse> {
    const res = await fetchJson<QueryResponse>(
      ctx.fetch,
      `${url}/query?${this.params(ctx, params)}`,
      this.http(ctx),
    );
    if (res.error) throw new Error(`ArcGIS query error ${res.error.code}: ${res.error.message}`);
    return res;
  }
}
