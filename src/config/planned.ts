// Features that are designed but not built. Shown in the UI as Planned.
export const PLANNED = [
  {
    id: "private-collaboration",
    name: "Private collaboration space",
    status: "Planned",
    description:
      "A paid, private space for ranchers, community members, and local, state, and federal agencies: data-sharing agreements, points of contact, schedules, and an audit log.",
    doc_url: "https://github.com/steelhead99x/predator-watch-app/blob/main/docs/private-version.md",
  },
] as const;

/**
 * Candidate data sources that were looked for but are not wired in. Each has
 * the reason. Checked 2026-10-31.
 */
export const PLANNED_SOURCES = [
  {
    name: "Areas of known wolf activity",
    agency: "Oregon Department of Fish and Wildlife",
    url: "https://www.dfw.state.or.us/Wolves/",
    reason:
      "No ODFW-owned public wolf activity service found. ODFW's ArcGIS organization publishes a modeled gray wolf range (GAP, layer 89 of SGCN_GAP_Ranges_Mammals) and a staff entry form; the only activity-area services are third-party copies from 2016.",
  },
  {
    name: "Monthly collared wolf activity by watershed",
    agency: "Colorado Parks and Wildlife",
    url: "https://cpw.state.co.us/wolf-sightings",
    reason:
      "Published as a PDF map. CPW's public ArcGIS services hold administrative boundaries (CPWAdminData) and Survey123 field forms, not a public wolf layer.",
  },
  {
    name: "Wolf range and pack data",
    agency: "Minnesota Department of Natural Resources",
    url: "https://www.dnr.state.mn.us/mammals/wolves/index.html",
    reason: "No public wolf layer found on the Minnesota Geospatial Commons or the DNR's ArcGIS organization.",
  },
  {
    name: "Wolf range and pack data",
    agency: "Michigan Department of Natural Resources",
    url: "https://www.michigan.gov/dnr/education/michigan-species/mammals/wolves-in-michigan",
    reason: "No public wolf layer found on the Michigan DNR open data hub.",
  },
  {
    name: "Predator damage management data",
    agency: "USDA APHIS Wildlife Services",
    url: "https://www.aphis.usda.gov/wildlife-services/publications/pdr",
    reason: "Annual Program Data Reports are tables by state and species; no spatial service found.",
  },
  {
    name: "Recent Mexican wolf locations (weekly hexagons)",
    agency: "Arizona Game and Fish Department",
    url: "https://services2.arcgis.com/os1CphwIyxBDDUGn/arcgis/rest/services/WolfWeeklyHexagons/FeatureServer/0",
    reason: "The service requires a token; it is not public.",
  },
  {
    name: "Wolf harvest by deer and elk hunting district (current season)",
    agency: "Montana Fish, Wildlife & Parks",
    url: "https://services3.arcgis.com/Cdxz8r11hT0MGzg1/arcgis/rest/services/Montana_Wolf_Harvest_Summary_by_Deer_Elk_Hunting_District/FeatureServer/0",
    reason: "Public and updated daily, but a table with no geometry. Needs a join to the hunting district boundaries.",
  },
  {
    name: "Esri Living Atlas layers (counties, streams, land cover, hillshade)",
    agency: "Esri",
    url: "https://livingatlas.arcgis.com/",
    reason:
      "Licensed under the Esri Master License Agreement; use outside ArcGIS needs an ArcGIS account or API key and Esri attribution. The federal originals (Census, USGS, MRLC) are used instead.",
  },
] as const;
