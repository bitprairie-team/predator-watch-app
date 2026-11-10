// Features that are designed but not built. Shown in the UI as Planned.
export const PLANNED = [
  {
    id: "private-collaboration",
    name: "Private collaboration space",
    status: "Planned",
    description:
      "A paid, private space for ranchers, community members, and local, state, and federal agencies: data-sharing agreements, points of contact, schedules, and an audit log.",
    doc_url: "https://github.com/bitprairie-team/predator-watch-app/blob/main/docs/private-version.md",
  },
  {
    id: "pasturetrace-integration",
    name: "PastureTrace integration",
    status: "Planned",
    description:
      "Exchange of animal events and time-window alerts with PastureTrace for private workspaces. The message schemas carry no locations.",
    doc_url: "https://github.com/bitprairie-team/predator-watch-app/tree/main/schemas/integrations/pasturetrace/v1",
  },
] as const;

/**
 * Candidate data sources that were looked for but are not wired in as map
 * layers. Each has the reason. Rechecked 2026-11-09.
 */
export const PLANNED_SOURCES = [
  {
    name: "Areas of known wolf activity",
    agency: "Oregon Department of Fish and Wildlife",
    url: "https://nrimp.dfw.state.or.us/DataClearinghouse/default.aspx?p=202&XMLname=41160.xml",
    reason:
      "ODFW now posts official AKWA shapefiles on its Data Clearinghouse (last published 4 May 2026), but the download is a dated zip, not a live FeatureServer. Annual reports and the official minimum count are used in Updates. A live layer will be added if a stable service appears.",
  },
  {
    name: "Monthly collared wolf activity by watershed",
    agency: "Colorado Parks and Wildlife",
    url: "https://cpw.state.co.us/wolf-sightings",
    reason:
      "Still published as a monthly PDF or JPEG map. Public CPW ArcGIS services hold administrative boundaries and field forms, not a public wolf activity layer.",
  },
  {
    name: "Wolf pack polygons and occupied range",
    agency: "Minnesota Department of Natural Resources",
    url: "https://www.dnr.state.mn.us/wolves/index.html",
    reason:
      "No public pack or range FeatureServer was found on the Geospatial Commons or the DNR ArcGIS hosts (a previously cited management-zone service URL returned 404). Annual population survey PDFs from this page are used in Updates.",
  },
  {
    name: "Wolf range and pack data",
    agency: "Michigan Department of Natural Resources",
    url: "https://www.michigan.gov/dnr/education/michigan-species/mammals/wolves-in-michigan",
    reason: "No public wolf layer found on the Michigan DNR open data hub. Rechecked 2026-11-09.",
  },
  {
    name: "Predator damage management data",
    agency: "USDA APHIS Wildlife Services",
    url: "https://www.aphis.usda.gov/wildlife-services/publications/pdr",
    reason: "Annual Program Data Reports are tables by area and species; no spatial service found.",
  },
  {
    name: "Recent Mexican wolf locations (weekly hexagons)",
    agency: "Arizona Game and Fish Department",
    url: "https://services2.arcgis.com/os1CphwIyxBDDUGn/arcgis/rest/services/WolfWeeklyHexagons/FeatureServer/0",
    reason:
      "The service still requires a token (HTTP 499). The public USFWS MexicanWolf_RecentHexagons service is used instead.",
  },
  {
    name: "Wolf harvest by deer and elk hunting district (current season)",
    agency: "Montana Fish, Wildlife & Parks",
    url: "https://services3.arcgis.com/Cdxz8r11hT0MGzg1/arcgis/rest/services/Montana_Wolf_Harvest_Summary_by_Deer_Elk_Hunting_District/FeatureServer/0",
    reason:
      "Public and updated (table last edited 2026-11-09) but still a table with no geometry. A join to hunting-district boundaries is needed before it can be drawn.",
  },
  {
    name: "Esri Living Atlas layers (counties, streams, land cover, hillshade)",
    agency: "Esri",
    url: "https://livingatlas.arcgis.com/",
    reason:
      "Licensed under the Esri Master License Agreement; use outside ArcGIS needs an ArcGIS account or API key and Esri attribution. The federal originals (Census, USGS, MRLC) are used instead.",
  },
  {
    name: "Federal grizzly bear recovery zones",
    agency: "U.S. Fish and Wildlife Service",
    url: "https://www.fws.gov/media/grizzly-bear-recovery-zones-and-estimated-distributions",
    reason:
      "No official nationwide public FeatureServer was found. A USFWS graphic exists, and some BLM planning maps include a North Continental Divide unit, but those are not a complete public recovery-zone service.",
  },
] as const;
