// Every vector source the Worker refreshes and caches. Adding an ArcGIS layer
// is config only: copy an entry, set `url` to the layer and map its fields.
// See docs/adding-an-arcgis-layer.md. Only add endpoints you have verified are
// public, live, and reusable; list everything else as Planned in
// docs/data-sources.md.
import type { ArcGisSourceConfig } from "../adapters/arcgis";
import type { GeoJsonSourceConfig } from "../adapters/geojson";

export type SourceConfig = ArcGisSourceConfig | GeoJsonSourceConfig;

const item = (id: string) => `https://www.arcgis.com/home/item.html?id=${id}`;

export const SOURCES: SourceConfig[] = [
  // ---------------------------------------------------------------- wolf activity
  {
    type: "geojson",
    id: "cdfw-collared-wolf-cells",
    name: "Collared gray wolf locations (generalized cells)",
    category: "wolf-activity",
    species: "Gray wolf",
    agency: "California Department of Fish and Wildlife",
    url: "https://storage.googleapis.com/cdfw-wolf-tracker/wolf_bins.geojson",
    infoUrl: "https://wildlife.ca.gov/Conservation/Mammals/Gray-Wolf/Location-Map",
    license:
      "Published by CDFW for public information under the CDFW Conditions of Use (https://wildlife.ca.gov/Conditions-of-Use) and the tool's stated limitations. Not comprehensive; no warranty.",
    attribution: "California Department of Fish and Wildlife (CDFW) wolf location tool",
    cadence: "Automated, about daily. Each cell holds the most recent location of one GPS-collared wolf.",
    refreshMinutes: 60,
    precision: "hex-cell",
    notes:
      "Only a subset of wolves wear GPS collars. A cell shows the most recent location reported by a collar; it is not a current position and does not show uncollared wolves. Shown exactly as CDFW publishes the cells.",
    fields: {
      idField: "name",
      label: "{name}",
      observedAt: { field: "most_recent_adj", format: "date-text", precision: "day" },
      details: { "Pack of origin": "pack_origin", "Time of day (agency)": "time_of_day" },
    },
    style: { color: "#0b7a4b", fillOpacity: 0.35, order: 30, defaultVisible: true },
  },
  {
    type: "arcgis",
    id: "wdfw-wolf-packs-current",
    name: "Wolf pack areas (current year)",
    category: "wolf-activity",
    species: "Gray wolf",
    agency: "Washington Department of Fish and Wildlife",
    url: "https://geodataservices.wdfw.wa.gov/arcgis/rest/services/WP_Statewide/Wolf_PackPolygons/MapServer/0",
    infoUrl: "https://wdfw.wa.gov/species-habitats/at-risk/species-recovery/gray-wolf",
    license: "Public WDFW map service. No reuse license is stated on the service; credit WDFW.",
    attribution: "Washington Department of Fish and Wildlife (WDFW)",
    cadence: "Annual, after the year-end wolf survey.",
    refreshMinutes: 24 * 60,
    precision: "pack-territory",
    notes: "Generalized pack areas drawn by WDFW for the survey year shown. Not a location of individual wolves.",
    fields: {
      idField: "PackID",
      label: "{Pack} pack",
      observedAt: { field: "Year", format: "year" },
      details: { "Survey year": "Year", "Pack status": "PackStatus" },
    },
    style: { color: "#1f5fa8", fillOpacity: 0.2, order: 20, defaultVisible: true },
  },
  {
    type: "arcgis",
    id: "mtfwp-wolf-distribution",
    name: "Gray wolf distribution",
    category: "wolf-activity",
    species: "Gray wolf",
    agency: "Montana Fish, Wildlife & Parks",
    url: "https://services3.arcgis.com/Cdxz8r11hT0MGzg1/arcgis/rest/services/WILD_DISTRIB_WOLF/FeatureServer/0",
    infoUrl: item("0b2a98d65f4746f1b9c2a247fca9dad6"),
    license: 'Public FWP data provided "as is" without warranty (see item terms). Credit Montana Fish, Wildlife & Parks.',
    attribution: "Montana Fish, Wildlife & Parks (FWP)",
    cadence: "Periodic; FWP updates the layer when distribution is revised.",
    refreshMinutes: 24 * 60,
    precision: "distribution-area",
    notes: "General extent of wolf distribution. The date shown is the layer's last data edit reported by FWP.",
    fields: { label: "Gray wolf distribution", observedAt: { fromLayer: true }, details: { Acres: "ACRES" } },
    maxAllowableOffset: 0.002,
    style: { color: "#6b3fa0", fillOpacity: 0.15, order: 10, defaultVisible: true },
  },
  {
    type: "arcgis",
    id: "usfws-mexican-wolf-occupied-range-2020",
    name: "Mexican wolf occupied range (2020)",
    category: "wolf-activity",
    species: "Mexican wolf",
    agency: "U.S. Fish and Wildlife Service",
    url: "https://services.arcgis.com/QVENGdaPbd4LUkLV/arcgis/rest/services/2020_Occupied_Range/FeatureServer/1",
    infoUrl: item("4fb4062ee7a14a36bc3806cbd7b402d0"),
    license: "U.S. federal government data (public domain in the U.S.); USFWS disclaimer applies.",
    attribution: "U.S. Fish and Wildlife Service, Mexican Wolf Recovery Program",
    cadence: "Static 2020 range layer; checked daily for changes.",
    refreshMinutes: 24 * 60,
    precision: "distribution-area",
    fields: { label: "Mexican wolf occupied range (2020)", observedAt: { fromLayer: true } },
    maxAllowableOffset: 0.002,
    style: { color: "#a34a00", fillOpacity: 0.15, order: 11, defaultVisible: true },
  },

  // ---------------------------------------------------------- management areas
  {
    type: "arcgis",
    id: "usfws-mwepa",
    name: "Mexican Wolf Experimental Population Area",
    category: "wolf-management",
    species: "Mexican wolf",
    agency: "U.S. Fish and Wildlife Service",
    url: "https://services.arcgis.com/QVENGdaPbd4LUkLV/arcgis/rest/services/2020_Occupied_Range/FeatureServer/6",
    infoUrl: item("4fb4062ee7a14a36bc3806cbd7b402d0"),
    license: "U.S. federal government data (public domain in the U.S.); USFWS disclaimer applies.",
    attribution: "U.S. Fish and Wildlife Service",
    cadence: "Regulatory boundary; changes only with rulemaking.",
    refreshMinutes: 7 * 24 * 60,
    precision: "management-unit",
    fields: { label: "Mexican Wolf Experimental Population Area" },
    maxAllowableOffset: 0.002,
    style: { color: "#7a4a1d", fillOpacity: 0, dashed: true, order: 5 },
  },
  {
    type: "arcgis",
    id: "idfg-wolf-management-zones",
    name: "Wolf management zones",
    category: "wolf-management",
    species: "Gray wolf",
    agency: "Idaho Department of Fish and Game",
    url: "https://services.arcgis.com/FjJI5xHF2dUPVrgK/arcgis/rest/services/Wolf_Management_Zones/FeatureServer/0",
    infoUrl: item("71fda767b6e443caad932e231e7f4a2e"),
    license: "IDFG public-use data for informational purposes; no warranty (see item terms).",
    attribution: "Idaho Department of Fish and Game (IDFG)",
    cadence: "Changes with hunting regulations.",
    refreshMinutes: 7 * 24 * 60,
    precision: "management-unit",
    fields: { label: "{DAU} wolf management zone" },
    maxAllowableOffset: 0.002,
    style: { color: "#3d4f63", fillOpacity: 0, dashed: true, order: 4 },
  },
  {
    type: "arcgis",
    id: "wgfd-wolf-hunt-areas",
    name: "Wolf hunt areas",
    category: "wolf-management",
    species: "Gray wolf",
    agency: "Wyoming Game and Fish Department",
    url: "https://services6.arcgis.com/cWzdqIyxbijuhPLw/arcgis/rest/services/Wolf_Hunt_Areas/FeatureServer/0",
    infoUrl: item("ec5bbacd1a244ce6aa182a63963c80b8"),
    license: 'State of Wyoming / WGFD data provided "as is" (see item terms).',
    attribution: "Wyoming Game and Fish Department (WGFD)",
    cadence: "Changes with hunting regulations.",
    refreshMinutes: 7 * 24 * 60,
    precision: "management-unit",
    fields: {
      idField: "HUNTAREA",
      label: "{HUNTNAME} (hunt area {HUNTAREA})",
      details: { "Management area": "MGMTAREA" },
    },
    maxAllowableOffset: 0.002,
    style: { color: "#3d4f63", fillOpacity: 0, dashed: true, order: 4 },
  },
  {
    type: "arcgis",
    id: "widnr-wolf-management-zones",
    name: "Wolf management zones",
    category: "wolf-management",
    species: "Gray wolf",
    agency: "Wisconsin Department of Natural Resources",
    url: "https://dnrmaps.wi.gov/arcgis2/rest/services/WM_SPECIES_MGMT_ZONES/WM_WOLF_MGMT_ZONES_WTM_Ext/MapServer/0",
    infoUrl: "https://dnr.wisconsin.gov/topic/WildlifeHabitat/wolf",
    license: "Public Wisconsin DNR map service; credit Wisconsin DNR.",
    attribution: "Wisconsin Department of Natural Resources",
    cadence: "Changes with management plan updates.",
    refreshMinutes: 7 * 24 * 60,
    precision: "management-unit",
    fields: {
      label: "Wolf management zone {WOLF_MGMT_ZONE}",
      observedAt: { field: "LAST_UPDATE_DATE", format: "epoch-ms", precision: "day" },
      details: { Zone: "WOLF_MGMT_ZONE", Subzone: "IS_SUBZONE" },
    },
    maxAllowableOffset: 0.002,
    style: { color: "#3d4f63", fillOpacity: 0, dashed: true, order: 4 },
  },

  // ----------------------------------------------------------------- context
  {
    type: "arcgis",
    id: "nifc-wildfire-perimeters",
    name: "Wildfire perimeters (current)",
    category: "context",
    species: null,
    agency: "National Interagency Fire Center",
    url: "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0",
    infoUrl: "https://data-nifc.opendata.arcgis.com/datasets/nifc::wfigs-current-interagency-fire-perimeters",
    license: "U.S. federal interagency data (public domain in the U.S.); NIFC disclaimer applies.",
    attribution: "NIFC / Wildland Fire Interagency Geospatial Services (WFIGS)",
    cadence: "Near real time; perimeters update as incidents report.",
    refreshMinutes: 15,
    precision: "incident-perimeter",
    fields: {
      idField: "attr_UniqueFireIdentifier",
      label: "{poly_IncidentName} fire",
      observedAt: { field: "poly_DateCurrent", format: "epoch-ms" },
      details: { Acres: "poly_GISAcres", "Percent contained": "attr_PercentContained" },
    },
    maxAllowableOffset: 0.001,
    geometryPrecision: 5,
    style: { color: "#c62828", fillOpacity: 0.25, order: 40, defaultVisible: true },
  },
  {
    type: "arcgis",
    id: "nws-watches-warnings",
    name: "Weather watches, warnings and advisories",
    category: "context",
    species: null,
    agency: "National Weather Service",
    url: "https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1",
    infoUrl: "https://www.weather.gov/",
    license: "U.S. federal government data (public domain in the U.S.); see https://www.weather.gov/disclaimer.",
    attribution: "NOAA National Weather Service",
    cadence: "Near real time; refreshed as alerts are issued and expire.",
    refreshMinutes: 15,
    precision: "alert-area",
    fields: {
      idField: "cap_id",
      label: "{prod_type}",
      observedAt: { field: "issuance", format: "iso" },
      details: { Expires: "expiration", "Forecast office": "wfo", "Alert link": "url" },
    },
    maxAllowableOffset: 0.01,
    geometryPrecision: 3,
    style: { color: "#b8860b", fillOpacity: 0.15, order: 35 },
  },
];

export interface RasterContextLayer {
  id: string;
  name: string;
  category: "context";
  agency: string;
  attribution: string;
  license: string;
  info_url: string;
  cadence: string;
  /** MapLibre raster tile URL template. */
  tiles: string[];
  tileSize: number;
  minzoom?: number;
  maxzoom?: number;
  opacity: number;
  /** Agency legend endpoint. */
  legend_url: string;
  /** Representative swatch colour for the in-app legend. */
  color: string;
}

const exportTiles = (service: string, layers: string) =>
  `${service}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&dpi=96&layers=${encodeURIComponent(layers)}&f=image`;

// Rendered by the agency's own map service on request, so they are always as
// current as the service. Not cached by this Worker.
export const RASTER_LAYERS: RasterContextLayer[] = [
  {
    id: "blm-surface-management-agency",
    name: "Public land ownership (surface management agency)",
    category: "context",
    agency: "Bureau of Land Management",
    attribution: "BLM National Surface Management Agency",
    license: "U.S. federal government data (public domain in the U.S.).",
    info_url: "https://www.blm.gov/services/geospatial/GISData",
    cadence: "Updated by BLM periodically; rendered live from BLM tiles.",
    tiles: ["https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer/tile/{z}/{y}/{x}"],
    tileSize: 256,
    maxzoom: 16,
    opacity: 0.45,
    legend_url: "https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer/legend",
    color: "#f2d28b",
  },
  {
    id: "blm-grazing-allotments",
    name: "Grazing allotments (BLM)",
    category: "context",
    agency: "Bureau of Land Management",
    attribution: "BLM National Grazing Allotment Polygons",
    license: "U.S. federal government data (public domain in the U.S.).",
    info_url: "https://www.blm.gov/services/geospatial/GISData",
    cadence: "Updated by BLM periodically; rendered live from the BLM map service.",
    tiles: [exportTiles("https://gis.blm.gov/arcgis/rest/services/range/BLM_Natl_Grazing_Allotment/MapServer", "show:12")],
    tileSize: 256,
    minzoom: 5,
    opacity: 0.8,
    legend_url: "https://gis.blm.gov/arcgis/rest/services/range/BLM_Natl_Grazing_Allotment/MapServer/legend",
    color: "#8d6e63",
  },
  {
    id: "usfs-range-allotments",
    name: "Grazing allotments (Forest Service)",
    category: "context",
    agency: "USDA Forest Service",
    attribution: "USDA Forest Service Enterprise Data Warehouse, Range Allotments",
    license: "U.S. federal government data (public domain in the U.S.).",
    info_url: "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RangeManagement_01/MapServer",
    cadence: "Updated by the Forest Service periodically; rendered live. Visible from zoom 8.",
    tiles: [exportTiles("https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RangeManagement_01/MapServer", "show:0")],
    tileSize: 256,
    minzoom: 8,
    opacity: 0.8,
    legend_url: "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RangeManagement_01/MapServer/legend",
    color: "#2e7d32",
  },
];
