// Common schema every adapter normalizes to. Each item on the map is a GeoJSON
// Feature whose properties follow NormalizedProperties.

export type Category = "wolf-activity" | "wolf-management" | "context";

/**
 * How precisely the agency publishes the location. We never display data more
 * precisely than this, and we never derive finer geometry from it.
 */
export type Precision =
  | "hex-cell" // generalized hexagon cell chosen by the agency
  | "pack-territory" // agency-drawn pack territory polygon
  | "distribution-area" // generalized range or distribution polygon
  | "management-unit" // administrative or regulatory boundary
  | "incident-perimeter" // mapped event perimeter (for example a fire)
  | "alert-area" // warning or advisory polygon
  | "exact"; // agency publishes exact geometry

/** How precise observed_at is. */
export type TimePrecision = "instant" | "day" | "month" | "year" | "dataset";

export interface NormalizedProperties {
  /** Stable id: `${source_id}:${native id}` */
  id: string;
  source_id: string;
  source_name: string;
  category: Category;
  /** Common species name, or null for context layers */
  species: string | null;
  agency: string;
  /** Short human label for the item (pack name, fire name, alert type). */
  label: string;
  /** ISO 8601 time the agency says this was observed or last valid, or null. */
  observed_at: string | null;
  observed_at_precision: TimePrecision;
  /** ISO 8601 time this system fetched it from the agency. */
  received_at: string;
  precision: Precision;
  geometry_type: string;
  attribution: string;
  url: string;
  license: string;
  /** Extra agency-provided fields, already filtered to a safe allow-list. */
  details: Record<string, string | number | boolean | null>;
}

export type Geometry =
  | { type: "Point"; coordinates: number[] }
  | { type: "MultiPoint"; coordinates: number[][] }
  | { type: "LineString"; coordinates: number[][] }
  | { type: "MultiLineString"; coordinates: number[][][] }
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

export interface NormalizedFeature {
  type: "Feature";
  id: string;
  geometry: Geometry | null;
  properties: NormalizedProperties;
}

export interface SourceStatus {
  source_id: string;
  /** "ok" fresh data, "unchanged" agency data has not changed since last fetch,
   *  "error" last refresh failed (cached data, if any, is still served),
   *  "fixture" bundled sample data is served because the network was unavailable. */
  state: "ok" | "unchanged" | "error" | "fixture" | "never";
  /** When we last successfully contacted the agency. */
  checked_at: string | null;
  /** When the cached data last changed (our fetch time). */
  received_at: string | null;
  /** Agency-reported last edit time of the data, if they publish one. */
  source_updated_at: string | null;
  feature_count: number;
  /** Last refresh attempt by the cron, successful or not. */
  attempted_at?: string | null;
  /** Failed refreshes in a row; 0 after a success. */
  failures?: number;
  /** When the most recent failure happened. */
  last_error_at?: string | null;
  error?: string;
}

export interface NormalizedCollection {
  type: "FeatureCollection";
  features: NormalizedFeature[];
  metadata: SourceStatus & { source: PublicSourceInfo };
}

/** Public, display-safe description of a source. */
export interface PublicSourceInfo {
  id: string;
  name: string;
  category: Category;
  species: string | null;
  agency: string;
  url: string;
  info_url: string;
  license: string;
  attribution: string;
  cadence: string;
  precision: Precision;
  notes?: string;
  style: LayerStyle;
}

export interface LayerStyle {
  /** Fill / line / circle colour on the light basemap, hex (BitPrairie palette, at least 3:1 against the basemap). */
  color: string;
  /** Colour on the dark basemap, hex. Falls back to `color`. */
  colorDark?: string;
  /** Polygon fill opacity, 0..1 */
  fillOpacity?: number;
  /** Optional dashed outline for management boundaries. */
  dashed?: boolean;
  /** Draw order hint: higher draws on top. */
  order?: number;
  /** Start with the layer visible. */
  defaultVisible?: boolean;
}
