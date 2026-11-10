// Every vector source the Worker refreshes and caches. Adding an ArcGIS layer
// is config only: copy an entry, set `url` to the layer and map its fields.
// See docs/adding-an-arcgis-layer.md. Only add endpoints you have verified are
// public, live, and reusable; list everything else as Planned in
// docs/data-sources.md.
import type { ArcGisSourceConfig } from "../adapters/arcgis";
import type { GeoJsonSourceConfig } from "../adapters/geojson";
import type { LayerStyle } from "../schema";
import { LAND_MANAGER_COLORS, esriRgba, layerColor } from "./palette";

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
    creditShort: "CDFW",
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
    style: { color: layerColor("cdfw-collared-wolf-cells"), fillOpacity: 0.35, order: 30, defaultVisible: true },
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
    creditShort: "WDFW",
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
    style: { color: layerColor("wdfw-wolf-packs-current"), fillOpacity: 0.2, order: 20, defaultVisible: true },
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
    creditShort: "Montana FWP",
    attribution: "Montana Fish, Wildlife & Parks (FWP)",
    cadence: "Periodic; FWP updates the layer when distribution is revised.",
    refreshMinutes: 24 * 60,
    precision: "distribution-area",
    notes: "General extent of wolf distribution. The date shown is the layer's last data edit reported by FWP.",
    fields: { label: "Gray wolf distribution", observedAt: { fromLayer: true }, details: { Acres: "ACRES" } },
    maxAllowableOffset: 0.002,
    style: { color: layerColor("mtfwp-wolf-distribution"), fillOpacity: 0.15, order: 10, defaultVisible: true },
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
    creditShort: "USFWS Mexican Wolf Recovery Program",
    attribution: "U.S. Fish and Wildlife Service, Mexican Wolf Recovery Program",
    cadence: "Static 2020 range layer; checked daily for changes.",
    refreshMinutes: 24 * 60,
    precision: "distribution-area",
    fields: { label: "Mexican wolf occupied range (2020)", observedAt: { fromLayer: true } },
    maxAllowableOffset: 0.002,
    style: { color: layerColor("usfws-mexican-wolf-occupied-range-2020"), fillOpacity: 0.15, order: 11, defaultVisible: true },
  },
  {
    type: "arcgis",
    id: "usfws-mexican-wolf-occupied-range-2023",
    name: "Mexican wolf occupied range (2023)",
    category: "wolf-activity",
    species: "Mexican wolf",
    agency: "U.S. Fish and Wildlife Service",
    url: "https://services.arcgis.com/QVENGdaPbd4LUkLV/arcgis/rest/services/OccupiedRange2023/FeatureServer/0",
    infoUrl: item("46b1946bc59343cd99121d9d633378e0"),
    license: "U.S. federal government data (public domain in the U.S.); USFWS disclaimer applies.",
    creditShort: "USFWS Mexican Wolf Recovery Program",
    attribution: "U.S. Fish and Wildlife Service, Mexican Wolf Recovery Program",
    cadence: "Annual; this layer is the 2023 occupied range from the program annual report.",
    refreshMinutes: 24 * 60,
    precision: "distribution-area",
    notes: "The area Mexican wolves were known to occupy in 2023, as published for the annual report. Off by default; the 2020 range stays on as the existing default layer.",
    fields: { label: "Mexican wolf occupied range (2023)", observedAt: { fromLayer: true }, details: { "Square miles": "area_mi2", "Square kilometers": "area_km2" } },
    maxAllowableOffset: 0.002,
    style: { color: layerColor("usfws-mexican-wolf-occupied-range-2023"), fillOpacity: 0.15, order: 12 },
  },
  {
    type: "arcgis",
    id: "usfws-mexican-wolf-recent-hexagons",
    name: "Recent Mexican wolf locations (generalized cells)",
    category: "wolf-activity",
    species: "Mexican wolf",
    agency: "U.S. Fish and Wildlife Service",
    url: "https://services.arcgis.com/QVENGdaPbd4LUkLV/arcgis/rest/services/MexicanWolf_RecentHexagons/FeatureServer",
    discoverLayer: { namePrefix: "RecentHexagons" },
    infoUrl: item("20c06d78e1814f2eabf256476bd8266e"),
    license: "U.S. federal government data (public domain in the U.S.); USFWS disclaimer applies.",
    creditShort: "USFWS Mexican Wolf Recovery Program",
    attribution: "U.S. Fish and Wildlife Service, Mexican Wolf Recovery Program",
    cadence: "The public location map is updated about every one to two weeks. The service layer is republished under a dated name.",
    refreshMinutes: 24 * 60,
    precision: "hex-cell",
    notes: "Generalized hexagon cells from the program's public location map. A cell is not an exact location or a current position. Pack names are as the program published them. Off by default.",
    fields: {
      idField: "OBJECTID",
      label: "{pack}",
      observedAt: { field: "date_time", format: "date-text", precision: "day" },
      details: { Pack: "pack", Studbook: "studbook" },
    },
    style: { color: layerColor("usfws-mexican-wolf-recent-hexagons"), fillOpacity: 0.35, order: 31 },
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
    creditShort: "USFWS",
    attribution: "U.S. Fish and Wildlife Service",
    cadence: "Regulatory boundary; changes only with rulemaking.",
    refreshMinutes: 7 * 24 * 60,
    precision: "management-unit",
    fields: { label: "Mexican Wolf Experimental Population Area" },
    maxAllowableOffset: 0.002,
    style: { color: layerColor("usfws-mwepa"), fillOpacity: 0, dashed: true, order: 5 },
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
    creditShort: "IDFG",
    attribution: "Idaho Department of Fish and Game (IDFG)",
    cadence: "Changes with hunting regulations.",
    refreshMinutes: 7 * 24 * 60,
    precision: "management-unit",
    fields: { label: "{DAU} wolf management zone", observedAt: { fromLayer: true } },
    maxAllowableOffset: 0.002,
    style: { color: layerColor("idfg-wolf-management-zones"), fillOpacity: 0, dashed: true, order: 4 },
  },
  {
    type: "arcgis",
    id: "mtfwp-wolf-management-units",
    name: "Wolf regions and management units (2026 season)",
    category: "wolf-management",
    species: "Gray wolf",
    agency: "Montana Fish, Wildlife & Parks",
    url: "https://services3.arcgis.com/Cdxz8r11hT0MGzg1/arcgis/rest/services/ADMBND_HD_WOLF_MANAGEUNITS/FeatureServer/0",
    infoUrl: item("f2b9be818b73400d81ef616e54d48c20"),
    license: 'Public FWP data provided "as is" without warranty (see item terms). Credit Montana Fish, Wildlife & Parks.',
    creditShort: "Montana FWP",
    attribution: "Montana Fish, Wildlife & Parks (FWP)",
    cadence: "Changes with hunting and trapping regulations each season.",
    refreshMinutes: 7 * 24 * 60,
    precision: "management-unit",
    fields: {
      label: "{NAME}",
      observedAt: { fromLayer: true },
      details: { Region: "REG", "Harvest type": "HARVTYPE", "Regulations page": "WEBPAGE" },
    },
    maxAllowableOffset: 0.002,
    style: { color: layerColor("mtfwp-wolf-management-units"), fillOpacity: 0, dashed: true, order: 4 },
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
    creditShort: "WGFD",
    attribution: "Wyoming Game and Fish Department (WGFD)",
    cadence: "Changes with hunting regulations.",
    refreshMinutes: 7 * 24 * 60,
    precision: "management-unit",
    fields: {
      idField: "HUNTAREA",
      label: "{HUNTNAME} (hunt area {HUNTAREA})",
      observedAt: { fromLayer: true },
      details: { "Management area": "MGMTAREA" },
    },
    maxAllowableOffset: 0.002,
    style: { color: layerColor("wgfd-wolf-hunt-areas"), fillOpacity: 0, dashed: true, order: 4 },
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
    creditShort: "Wisconsin DNR",
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
    style: { color: layerColor("widnr-wolf-management-zones"), fillOpacity: 0, dashed: true, order: 4 },
  },

  // -------------------------------------------------------------------- bears
  // Off by default: turn on from the Bears group.
  {
    type: "arcgis",
    id: "mtfwp-grizzly-occupied-range-2024",
    name: "Grizzly bear estimated occupied range (2024)",
    category: "bear",
    species: "Grizzly bear",
    agency: "Montana Fish, Wildlife & Parks",
    url: "https://services3.arcgis.com/Cdxz8r11hT0MGzg1/arcgis/rest/services/WILD_DISTRIB_GRIZZLYBEAR_EOR_MT_24/FeatureServer/0",
    infoUrl: item("0297ed0bc53a4a8592c77e80af991d1b"),
    license: 'Public FWP data provided "as is" without warranty (see item terms). Credit Montana Fish, Wildlife & Parks.',
    creditShort: "Montana FWP",
    attribution: "Montana Fish, Wildlife & Parks (FWP)",
    cadence: "Annual estimate; FWP publishes a new layer for each estimate year.",
    refreshMinutes: 7 * 24 * 60,
    precision: "distribution-area",
    notes: "Combined estimated occupied range of the grizzly bear populations FWP monitors. A generalized range, not bear locations.",
    fields: { label: "Grizzly bear estimated occupied range (2024)", observedAt: { fromLayer: true }, details: { Acres: "AREA_ACRES" } },
    maxAllowableOffset: 0.002,
    style: { color: layerColor("mtfwp-grizzly-occupied-range-2024"), fillOpacity: 0.18, order: 9 },
  },
  {
    type: "arcgis",
    id: "mtfwp-bear-distribution",
    name: "Black and grizzly bear generalized distribution",
    category: "bear",
    species: "Black bear and grizzly bear",
    agency: "Montana Fish, Wildlife & Parks",
    url: "https://services3.arcgis.com/Cdxz8r11hT0MGzg1/arcgis/rest/services/WILD_DISTRIB_BEARS_REGS/FeatureServer/0",
    infoUrl: item("b59040cc67f742f1a0f1e72c05b2892b"),
    license: 'Public FWP data provided "as is" without warranty (see item terms). Credit Montana Fish, Wildlife & Parks.',
    creditShort: "Montana FWP",
    attribution: "Montana Fish, Wildlife & Parks (FWP)",
    cadence: "Periodic; FWP updates the layer when distribution is revised.",
    refreshMinutes: 7 * 24 * 60,
    precision: "distribution-area",
    notes: "Where people may encounter black or grizzly bears, as generalized by FWP. Not bear locations.",
    fields: { label: "{BEAR}", observedAt: { fromLayer: true }, details: { Bears: "BEAR" } },
    maxAllowableOffset: 0.002,
    style: { color: layerColor("mtfwp-bear-distribution"), fillOpacity: 0.12, order: 8 },
  },
  {
    type: "arcgis",
    id: "cdfw-black-bear-range",
    name: "Black bear range (CWHR)",
    category: "bear",
    species: "Black bear",
    agency: "California Department of Fish and Wildlife",
    url: "https://services2.arcgis.com/Uq9r85Potqm3MfRV/arcgis/rest/services/biosds792_fpu/FeatureServer/0",
    infoUrl: item("5304ab369678420085b2e2d4f7d2d039"),
    license: "CDFW BIOS public dataset ds792 (California Wildlife Habitat Relationships). Use within the limits stated in the item metadata; credit CDFW.",
    creditShort: "CDFW CWHR",
    attribution: "California Department of Fish and Wildlife, California Wildlife Habitat Relationships (CWHR)",
    cadence: "Revised when CDFW updates the CWHR range maps.",
    refreshMinutes: 7 * 24 * 60,
    precision: "distribution-area",
    notes: "Generalized area where the species is expected to occur regularly, without regard to specific habitat. Not bear locations.",
    fields: { label: "{CName} range", observedAt: { fromLayer: true }, details: { Season: "Season", Uncertain: "Uncertain" } },
    maxAllowableOffset: 0.002,
    style: { color: layerColor("cdfw-black-bear-range"), fillOpacity: 0.12, order: 7 },
  },
  {
    type: "arcgis",
    id: "udwr-black-bear-habitat",
    name: "Black bear habitat",
    category: "bear",
    species: "Black bear",
    agency: "Utah Division of Wildlife Resources",
    url: "https://services.arcgis.com/ZzrwjTRez6FJiOq4/arcgis/rest/services/Utah_Black_Bear_Habitat/FeatureServer/0",
    infoUrl: item("6440f19a05c149b783baf1705e5f2a51"),
    license: "Public Utah DWR data; no warranty (see item terms). Credit the Utah Division of Wildlife Resources.",
    creditShort: "Utah DWR",
    attribution: "Utah Division of Wildlife Resources (DWR)",
    cadence: "Periodic; DWR updates the layer when habitat mapping is revised.",
    refreshMinutes: 7 * 24 * 60,
    precision: "distribution-area",
    notes: "Current distribution with season of use and habitat value, simplified by DWR for web use. Not bear locations.",
    fields: { label: "Black bear habitat ({SEASON})", observedAt: { fromLayer: true }, details: { Season: "SEASON", "Habitat value": "VALUE" } },
    maxAllowableOffset: 0.002,
    style: { color: layerColor("udwr-black-bear-habitat"), fillOpacity: 0.12, order: 6 },
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
    creditShort: "NIFC WFIGS",
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
    style: { color: layerColor("nifc-wildfire-perimeters"), fillOpacity: 0.25, order: 40 },
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
    creditShort: "NOAA NWS",
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
    style: { color: layerColor("nws-watches-warnings"), fillOpacity: 0.15, order: 35 },
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
  /** Short credit for the map's always-visible credits line, e.g. "BLM". */
  credit_short: string;
  /**
   * Fixed palette color (src/config/palette.ts) used by the selector swatch
   * and the legend. Where the agency service allows it (ArcGIS dynamic
   * layers, vector tiles), the map draws in this color too; see
   * `drawn_in_palette`.
   */
  style: Pick<LayerStyle, "color" | "fillOpacity" | "dashed">;
  /** True when the map paints this layer in `style.color`; false when the tiles are images styled by the agency. */
  drawn_in_palette: boolean;
  /**
   * When set, `tiles` are Mapbox vector tiles (pbf) and are drawn as a fill
   * of this source layer instead of as images.
   */
  vector?: { source_layer: string; fill_opacity: number };
  /** One-line plain description shown in the layer row. */
  summary?: string;
  /** Shown in the row and legend below `minzoom`. */
  zoom_hint?: string;
  /** Classes drawn in fixed colors, for the mini legend and the popup. */
  classes?: LandClass[];
  /** Note added under every popup for this layer. */
  popup_note?: string;
  /** ArcGIS identify endpoint for "what is here" popups. */
  identify?: { url: string; layer_id: number; field: string };
}

export interface LandClass {
  key: keyof typeof LAND_MANAGER_COLORS;
  label: string;
  /** Agency codes (ADMIN_AGENCY_CODE) in this class; "other" takes everything else. */
  codes: string[];
  color: string;
  /** "What this means", in plain words. */
  meaning: string;
}

const EXPORT = "export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&dpi=96";
const exportTiles = (service: string, layers: string) => `${service}/${EXPORT}&layers=${encodeURIComponent(layers)}&f=image`;

/**
 * Export tiles drawn by the agency's ArcGIS server in our palette color, via
 * the documented `dynamicLayers` parameter (the service must report
 * supportsDynamicLayers). The polygon outline is the layer color and the
 * fill is the same color at low alpha, so the map matches the swatch.
 */
export function paletteExportTiles(service: string, mapLayerId: number, color: string, fillAlpha = 46): string {
  const dynamicLayers = [{
    id: mapLayerId,
    source: { type: "mapLayer", mapLayerId },
    drawingInfo: {
      renderer: {
        type: "simple",
        symbol: {
          type: "esriSFS", style: "esriSFSSolid", color: esriRgba(color, fillAlpha),
          outline: { type: "esriSLS", style: "esriSLSSolid", color: esriRgba(color), width: 1.2 },
        },
      },
    },
  }];
  return `${service}/${EXPORT}&dynamicLayers=${encodeURIComponent(JSON.stringify(dynamicLayers))}&f=image`;
}

const SMA_SERVICE = "https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer";
const lm = (key: keyof typeof LAND_MANAGER_COLORS, label: string, codes: string[], meaning: string): LandClass =>
  ({ key, label, codes, color: LAND_MANAGER_COLORS[key], meaning });

/** Who manages the surface of the land, from BLM's Surface Management Agency data. */
export const LAND_CLASSES: LandClass[] = [
  lm("blm", "Bureau of Land Management", ["BLM"], "Federal public land. Much of it is leased for grazing; turn on Grazing allotments (BLM) to see them."),
  lm("usfs", "U.S. Forest Service", ["USFS"], "National forest or grassland. Much of it is leased for grazing; turn on Grazing allotments (Forest Service) to see them."),
  lm("nps", "National Park Service", ["NPS"], "National park land. Park rules on grazing and wildlife differ from other public land."),
  lm("usfws", "U.S. Fish and Wildlife Service", ["FWS"], "National wildlife refuge or other Fish and Wildlife Service land. Refuge rules apply."),
  lm("dod", "Department of Defense", ["DOD", "ARMY", "NAVY", "USAF", "USMC", "USACE"], "Military land. Public access is usually restricted."),
  lm("bor", "Bureau of Reclamation", ["USBR"], "Federal land around reservoirs, dams and canals."),
  lm("tribal", "Tribal land", ["BIA", "NTVALL", "NTVPIC"], "Tribal or Indian trust land. Tribal governments set their own land and wildlife rules."),
  lm("state", "State", ["ST"], "State-managed land, such as state trust land, parks or wildlife areas. Rules depend on the state agency."),
  lm("other", "Private or other", [], "Private, local government or other federal land. BLM's data does not separate these here."),
];

/** BLM's server draws the land manager layer in LAND_CLASSES colors (dynamicLayers unique-value renderer). */
export function landManagerTiles(fillAlpha = 64): string {
  // Private and other land is the background: lighter, no outline, so the
  // public land managers and the predator layers above stay readable.
  const sym = (hex: string, quiet = false) => ({
    type: "esriSFS", style: "esriSFSSolid", color: esriRgba(hex, quiet ? Math.round(fillAlpha / 2.5) : fillAlpha),
    outline: { type: "esriSLS", style: "esriSLSSolid", color: esriRgba(hex, quiet ? 0 : 110), width: quiet ? 0 : 0.4 },
  });
  const other = LAND_CLASSES.find((c) => c.key === "other")!;
  const dynamicLayers = [{
    id: 1,
    source: { type: "mapLayer", mapLayerId: 1 },
    drawingInfo: {
      renderer: {
        type: "uniqueValue",
        field1: "ADMIN_AGENCY_CODE",
        defaultSymbol: sym(other.color, true),
        uniqueValueInfos: LAND_CLASSES.flatMap((c) => c.codes.map((code) => ({ value: code, label: c.label, symbol: sym(c.color) }))),
      },
    },
  }];
  return `${SMA_SERVICE}/${EXPORT}&dynamicLayers=${encodeURIComponent(JSON.stringify(dynamicLayers))}&f=image`;
}

/**
 * Basemap credit, always shown on the map (index.html renders these same
 * strings statically so they are visible before any script runs; a test
 * keeps the two in step).
 */
export const BASEMAP_CREDITS = [
  { name: "OpenFreeMap", url: "https://openfreemap.org/" },
  { name: "© OpenMapTiles", url: "https://openmaptiles.org/" },
  { name: "© OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright" },
] as const;

// Rendered by the agency's own map service on request, so they are always as
// current as the service. Not cached by this Worker.
export const RASTER_LAYERS: RasterContextLayer[] = [
  {
    id: "blm-surface-management-agency",
    name: "Who manages the land",
    category: "context",
    agency: "Bureau of Land Management",
    credit_short: "BLM Surface Management Agency",
    attribution: "Bureau of Land Management, Surface Management Agency",
    summary: "Shows which agency manages the surface of public land: BLM, Forest Service, Park Service, state trust land, tribal, private. Not mineral rights or exact property lines.",
    license: "U.S. federal government data (public domain in the U.S.).",
    info_url: "https://www.blm.gov/services/geospatial/GISData",
    cadence: "Updated by BLM periodically; drawn live by the BLM map service. Visible from zoom 6.",
    tiles: [landManagerTiles()],
    tileSize: 256,
    minzoom: 6,
    maxzoom: 16,
    opacity: 0.85,
    zoom_hint: "Zoom in to see land managers",
    legend_url: `${SMA_SERVICE}/legend`,
    drawn_in_palette: true,
    classes: LAND_CLASSES,
    popup_note: "Surface management only, not mineral rights or exact property lines. Rules for predator management vary by agency; check with the managing agency.",
    identify: { url: `${SMA_SERVICE}/identify`, layer_id: 1, field: "ADMIN_AGENCY_CODE" },
    style: { color: layerColor("blm-surface-management-agency"), fillOpacity: 0.25 },
  },
  {
    id: "blm-grazing-allotments",
    name: "Grazing allotments (BLM)",
    category: "context",
    agency: "Bureau of Land Management",
    credit_short: "BLM",
    attribution: "BLM National Grazing Allotment Polygons",
    license: "U.S. federal government data (public domain in the U.S.).",
    info_url: "https://www.blm.gov/services/geospatial/GISData",
    cadence: "Updated by BLM periodically; rendered live from the BLM map service.",
    tiles: [paletteExportTiles("https://gis.blm.gov/arcgis/rest/services/range/BLM_Natl_Grazing_Allotment/MapServer", 12, layerColor("blm-grazing-allotments"))],
    tileSize: 256,
    minzoom: 5,
    opacity: 0.8,
    legend_url: "https://gis.blm.gov/arcgis/rest/services/range/BLM_Natl_Grazing_Allotment/MapServer/legend",
    drawn_in_palette: true,
    style: { color: layerColor("blm-grazing-allotments"), fillOpacity: 0.3 },
  },
  {
    id: "usfs-range-allotments",
    name: "Grazing allotments (Forest Service)",
    category: "context",
    agency: "USDA Forest Service",
    credit_short: "USDA Forest Service",
    attribution: "USDA Forest Service Enterprise Data Warehouse, Range Allotments",
    license: "U.S. federal government data (public domain in the U.S.).",
    info_url: "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RangeManagement_01/MapServer",
    cadence: "Updated by the Forest Service periodically; rendered live. Visible from zoom 8.",
    tiles: [paletteExportTiles("https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RangeManagement_01/MapServer", 0, layerColor("usfs-range-allotments"))],
    tileSize: 256,
    minzoom: 8,
    opacity: 0.8,
    legend_url: "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RangeManagement_01/MapServer/legend",
    drawn_in_palette: true,
    style: { color: layerColor("usfs-range-allotments"), fillOpacity: 0.3 },
  },
  {
    id: "usgs-padus-manager-type",
    name: "Protected and managed areas (PAD-US, by manager type)",
    category: "context",
    agency: "U.S. Geological Survey, Gap Analysis Project",
    credit_short: "USGS PAD-US",
    attribution: "USGS Protected Areas Database of the United States (PAD-US) 4",
    license: "U.S. federal government data (public domain in the U.S.). Provided by USGS without warranty.",
    info_url: "https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-data-overview",
    cadence: "Major PAD-US releases about every two years; tiles published by USGS.",
    tiles: ["https://tiles.arcgis.com/tiles/v01gqwM5QqNysAAi/arcgis/rest/services/PADUS_Management_Areas_Manager_Type/VectorTileServer/tile/{z}/{y}/{x}.pbf"],
    tileSize: 512,
    minzoom: 5,
    maxzoom: 14,
    opacity: 1,
    legend_url: "https://www.arcgis.com/home/item.html?id=f71b5910fbcf4349b384b298f1247eb7",
    drawn_in_palette: true,
    style: { color: layerColor("usgs-padus-manager-type"), fillOpacity: 0.3 },
    vector: { source_layer: "PADUS", fill_opacity: 0.22 },
  },
  {
    id: "census-county-boundaries",
    name: "County boundaries",
    category: "context",
    agency: "U.S. Census Bureau",
    credit_short: "U.S. Census Bureau",
    attribution: "U.S. Census Bureau TIGERweb",
    license: "U.S. federal government data (public domain in the U.S.).",
    info_url: "https://tigerweb.geo.census.gov/tigerwebmain/TIGERweb_main.html",
    cadence: "Current TIGER vintage; rendered live from the Census map service. Visible from zoom 5.",
    tiles: [exportTiles("https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer", "show:1,3,5,7,9,11,13")],
    tileSize: 256,
    minzoom: 5,
    opacity: 0.9,
    legend_url: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/legend",
    drawn_in_palette: false,
    style: { color: layerColor("census-county-boundaries"), fillOpacity: 0 },
  },
  {
    id: "census-tribal-lands",
    name: "Federal American Indian reservations and trust lands",
    category: "context",
    agency: "U.S. Census Bureau",
    credit_short: "U.S. Census Bureau",
    attribution: "U.S. Census Bureau TIGERweb (AIANNH)",
    license: "U.S. federal government data (public domain in the U.S.). Census statistical boundaries, not legal surveys.",
    info_url: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/AIANNHA/MapServer",
    cadence: "Current TIGER vintage; rendered live from the Census map service.",
    tiles: [exportTiles("https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/AIANNHA/MapServer", "show:2,3")],
    tileSize: 256,
    minzoom: 4,
    opacity: 0.8,
    legend_url: "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/AIANNHA/MapServer/legend",
    drawn_in_palette: false,
    style: { color: layerColor("census-tribal-lands"), fillOpacity: 0 },
  },
  {
    id: "usgs-shaded-relief",
    name: "Terrain (shaded relief)",
    category: "context",
    agency: "U.S. Geological Survey, The National Map",
    credit_short: "USGS The National Map",
    attribution: "USGS The National Map: 3D Elevation Program",
    license: "U.S. federal government data (public domain in the U.S.).",
    info_url: "https://www.usgs.gov/programs/national-geospatial-program/national-map",
    cadence: "Refreshed by USGS periodically; cached tiles.",
    tiles: ["https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}"],
    tileSize: 256,
    maxzoom: 16,
    opacity: 0.35,
    legend_url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer",
    drawn_in_palette: false,
    style: { color: layerColor("usgs-shaded-relief"), fillOpacity: 0.3 },
  },
  {
    id: "usgs-hydrography",
    name: "Streams and water bodies (NHD)",
    category: "context",
    agency: "U.S. Geological Survey, The National Map",
    credit_short: "USGS The National Map",
    attribution: "USGS The National Map: National Hydrography Dataset",
    license: "U.S. federal government data (public domain in the U.S.).",
    info_url: "https://www.usgs.gov/national-hydrography",
    cadence: "USGS retired the NHD in October 2023; it is still served but no longer maintained. Cached tiles.",
    tiles: ["https://basemap.nationalmap.gov/arcgis/rest/services/USGSHydroCached/MapServer/tile/{z}/{y}/{x}"],
    tileSize: 256,
    maxzoom: 16,
    opacity: 0.9,
    legend_url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSHydroCached/MapServer",
    drawn_in_palette: false,
    style: { color: layerColor("usgs-hydrography"), fillOpacity: 0.3 },
  },
  {
    id: "mrlc-nlcd-land-cover",
    name: "Land cover (NLCD 2021, lower 48)",
    category: "context",
    agency: "Multi-Resolution Land Characteristics Consortium (USGS lead)",
    credit_short: "MRLC NLCD",
    attribution: "MRLC National Land Cover Database 2021",
    license: "U.S. federal government data (public domain in the U.S.). WMS lists no fees or access constraints.",
    info_url: "https://www.mrlc.gov/data",
    cadence: "Static 2021 edition; rendered live from the MRLC WMS.",
    tiles: ["https://www.mrlc.gov/geoserver/mrlc_display/wms?service=WMS&request=GetMap&version=1.1.1&layers=NLCD_2021_Land_Cover_L48&styles=&format=image/png&transparent=true&srs=EPSG:3857&bbox={bbox-epsg-3857}&width=256&height=256"],
    tileSize: 256,
    maxzoom: 15,
    opacity: 0.45,
    legend_url: "https://www.mrlc.gov/data/legends/national-land-cover-database-class-legend-and-description",
    drawn_in_palette: false,
    style: { color: layerColor("mrlc-nlcd-land-cover"), fillOpacity: 0.3 },
  },
];
