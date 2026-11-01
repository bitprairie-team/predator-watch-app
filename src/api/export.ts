// Per-layer exports of public-source data: GeoJSON, KML and CSV.
// Geometry is exported exactly as cached (the agency's own precision); no
// centroids or derived points are added.
import type { Geometry, NormalizedCollection, NormalizedFeature } from "../schema";

export type ExportFormat = "geojson" | "kml" | "csv";

export const EXPORT_TYPES: Record<ExportFormat, string> = {
  geojson: "application/geo+json; charset=utf-8",
  kml: "application/vnd.google-earth.kml+xml; charset=utf-8",
  csv: "text/csv; charset=utf-8",
};

const xml = (v: unknown) =>
  String(v ?? "").replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
// Strip characters that are not allowed in XML 1.0.
// eslint-disable-next-line no-control-regex
const xmlText = (v: unknown) => xml(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

const coordList = (cs: number[][]) => cs.map((c) => `${c[0]},${c[1]}`).join(" ");
const polygonKml = (rings: number[][][]) =>
  `<Polygon>${rings
    .map((r, i) => `<${i === 0 ? "outerBoundaryIs" : "innerBoundaryIs"}><LinearRing><coordinates>${coordList(r)}</coordinates></LinearRing></${i === 0 ? "outerBoundaryIs" : "innerBoundaryIs"}>`)
    .join("")}</Polygon>`;

export function geometryToKml(g: Geometry | null): string {
  if (!g) return "";
  switch (g.type) {
    case "Point":
      return `<Point><coordinates>${g.coordinates[0]},${g.coordinates[1]}</coordinates></Point>`;
    case "MultiPoint":
      return `<MultiGeometry>${g.coordinates.map((c) => `<Point><coordinates>${c[0]},${c[1]}</coordinates></Point>`).join("")}</MultiGeometry>`;
    case "LineString":
      return `<LineString><coordinates>${coordList(g.coordinates)}</coordinates></LineString>`;
    case "MultiLineString":
      return `<MultiGeometry>${g.coordinates.map((l) => `<LineString><coordinates>${coordList(l)}</coordinates></LineString>`).join("")}</MultiGeometry>`;
    case "Polygon":
      return polygonKml(g.coordinates);
    case "MultiPolygon":
      return `<MultiGeometry>${g.coordinates.map(polygonKml).join("")}</MultiGeometry>`;
  }
}

const PROPERTY_COLUMNS = [
  "id",
  "label",
  "species",
  "agency",
  "source_id",
  "source_name",
  "observed_at",
  "observed_at_precision",
  "received_at",
  "precision",
  "geometry_type",
  "attribution",
  "license",
  "url",
] as const;

export function toKml(fc: NormalizedCollection): string {
  const src = fc.metadata.source;
  const placemarks = fc.features
    .map((f) => {
      const p = f.properties;
      const data = [
        ...PROPERTY_COLUMNS.map((k) => [k, p[k]] as const),
        ...Object.entries(p.details ?? {}).map(([k, v]) => [`detail: ${k}`, v] as const),
      ]
        .map(([k, v]) => `<Data name="${xml(k)}"><value>${xmlText(v)}</value></Data>`)
        .join("");
      return `<Placemark id="${xml(f.id)}"><name>${xmlText(p.label)}</name><ExtendedData>${data}</ExtendedData>${geometryToKml(f.geometry)}</Placemark>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<name>${xmlText(src.name)} (${xmlText(src.agency)})</name>
<description>${xmlText(`Source: ${src.attribution}. Terms: ${src.license}. Received: ${fc.metadata.received_at ?? "not yet"}. ${src.info_url}`)}</description>
${placemarks}
</Document></kml>
`;
}

/** WKT for CSV; keeps the full published geometry. */
export function geometryToWkt(g: Geometry | null): string {
  if (!g) return "";
  const pt = (c: number[]) => `${c[0]} ${c[1]}`;
  const line = (cs: number[][]) => `(${cs.map(pt).join(", ")})`;
  const poly = (rs: number[][][]) => `(${rs.map(line).join(", ")})`;
  switch (g.type) {
    case "Point":
      return `POINT (${pt(g.coordinates)})`;
    case "MultiPoint":
      return `MULTIPOINT (${g.coordinates.map((c) => `(${pt(c)})`).join(", ")})`;
    case "LineString":
      return `LINESTRING ${line(g.coordinates)}`;
    case "MultiLineString":
      return `MULTILINESTRING (${g.coordinates.map(line).join(", ")})`;
    case "Polygon":
      return `POLYGON ${poly(g.coordinates)}`;
    case "MultiPolygon":
      return `MULTIPOLYGON (${g.coordinates.map(poly).join(", ")})`;
  }
}

/** CSV cell with quoting and protection against spreadsheet formula injection. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(features: NormalizedFeature[]): string {
  const detailKeys = [...new Set(features.flatMap((f) => Object.keys(f.properties.details ?? {})))];
  const header = [...PROPERTY_COLUMNS, ...detailKeys.map((k) => `detail: ${k}`), "wkt"];
  const rows = features.map((f) =>
    [
      ...PROPERTY_COLUMNS.map((k) => f.properties[k]),
      ...detailKeys.map((k) => f.properties.details?.[k]),
      geometryToWkt(f.geometry),
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.map(csvCell).join(","), ...rows].join("\r\n") + "\r\n";
}
