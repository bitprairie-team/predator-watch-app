// Generic adapter for agencies that publish a GeoJSON file at a stable URL.
// Uses ETag / Last-Modified for change detection (conditional requests), and
// keeps the agency's geometry exactly as published.

import { politeFetch, type PoliteOptions } from "../lib/http";
import { ensureUniqueIds, unwrapGeometry } from "../lib/geometry";
import { buildFeature, type FieldMapping } from "../lib/normalize";
import type { Geometry, NormalizedFeature } from "../schema";
import type { AdapterResult, BaseSourceConfig, FetchContext, SourceAdapter } from "./types";

export interface GeoJsonSourceConfig extends BaseSourceConfig {
  type: "geojson";
  url: string;
  fields: FieldMapping;
  maxFeatures?: number;
  http?: PoliteOptions;
}

interface RawFeature {
  type: "Feature";
  id?: string | number;
  geometry: Geometry | null;
  properties: Record<string, unknown> | null;
}

const GEOMETRY_TYPES = new Set(["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"]);

export class GeoJsonAdapter implements SourceAdapter {
  readonly endpoint: string;
  constructor(readonly config: GeoJsonSourceConfig) {
    if (!/^https:\/\//.test(config.url)) throw new Error(`${config.id}: url must be https`);
    this.endpoint = config.url;
  }

  async load(ctx: FetchContext): Promise<AdapterResult> {
    const headers: Record<string, string> = { Accept: "application/geo+json, application/json" };
    const prev = ctx.previous;
    if (prev?.hasData && prev.validator) {
      if (prev.validator.startsWith("etag:")) headers["If-None-Match"] = prev.validator.slice(5);
      else if (prev.validator.startsWith("lm:")) headers["If-Modified-Since"] = prev.validator.slice(3);
    }
    const res = await politeFetch(ctx.fetch, this.config.url, {
      userAgent: ctx.env.USER_AGENT,
      ...this.config.http,
      headers: { ...headers, ...this.config.http?.headers },
    });
    const lm = res.headers.get("Last-Modified");
    const etag = res.headers.get("ETag");
    const validator = etag ? `etag:${etag}` : lm ? `lm:${lm}` : null;
    const lmMs = lm ? Date.parse(lm) : NaN;
    const sourceUpdatedMs = Number.isFinite(lmMs) ? lmMs : null;

    if (res.status === 304) return { changed: false, sourceUpdatedMs: prev?.sourceUpdatedMs ?? sourceUpdatedMs, validator };
    if (prev?.hasData && sourceUpdatedMs !== null && prev.sourceUpdatedMs === sourceUpdatedMs) {
      return { changed: false, sourceUpdatedMs, validator };
    }

    const body = (await res.json()) as { type?: string; features?: RawFeature[] };
    if (body.type !== "FeatureCollection" || !Array.isArray(body.features)) {
      throw new Error(`${this.config.id}: response is not a GeoJSON FeatureCollection`);
    }
    const receivedAt = ctx.now().toISOString();
    const cap = this.config.maxFeatures ?? 20_000;
    const features: NormalizedFeature[] = [];
    body.features.slice(0, cap).forEach((f, i) => {
      const geom = f.geometry && GEOMETRY_TYPES.has(f.geometry.type) ? unwrapGeometry(f.geometry) : null;
      const attrs = f.properties ?? {};
      const idField = this.config.fields.idField;
      const native = idField && attrs[idField] != null ? `${String(attrs[idField])}-${i}` : String(f.id ?? i);
      features.push(buildFeature(this.config, this.endpoint, this.config.fields, attrs, geom, native, receivedAt, sourceUpdatedMs));
    });
    return { changed: true, features: ensureUniqueIds(features), sourceUpdatedMs, validator };
  }
}
