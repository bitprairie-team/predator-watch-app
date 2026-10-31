import type { Category, LayerStyle, NormalizedFeature, Precision } from "../schema";

/** Values every source config shares, regardless of adapter type. */
export interface BaseSourceConfig {
  id: string;
  name: string;
  category: Category;
  species: string | null;
  agency: string;
  /** Agency page where people can read about this data. */
  infoUrl: string;
  license: string;
  attribution: string;
  /** Plain-language update cadence, from the agency. */
  cadence: string;
  /** Minimum minutes between checks of this source. */
  refreshMinutes: number;
  precision: Precision;
  notes?: string;
  style: LayerStyle;
}

export interface PreviousState {
  /** Agency-reported last edit (ms since epoch) from the previous fetch. */
  sourceUpdatedMs: number | null;
  /** ETag or Last-Modified header seen on the previous fetch. */
  validator: string | null;
  hasData: boolean;
}

export interface FetchContext {
  fetch: typeof fetch;
  now: () => Date;
  env: { ARCGIS_API_KEY?: string; USER_AGENT?: string };
  previous?: PreviousState;
}

export type AdapterResult =
  | {
      changed: true;
      features: NormalizedFeature[];
      sourceUpdatedMs: number | null;
      validator: string | null;
    }
  | { changed: false; sourceUpdatedMs: number | null; validator: string | null };

/** A pluggable source adapter. One instance per configured source. */
export interface SourceAdapter {
  readonly config: BaseSourceConfig;
  /** Public URL of the agency endpoint (for attribution and docs). */
  readonly endpoint: string;
  load(ctx: FetchContext): Promise<AdapterResult>;
}
