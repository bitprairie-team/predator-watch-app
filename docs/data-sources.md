# Data sources

Every layer on the map comes from a public government or agency source. No
private or rancher data is collected or shown. Each source keeps the precision
the agency publishes; the map never refines, snaps or interpolates locations.

Status key:

- **Live:** wired into `src/config/sources.ts` and refreshed into the cache.
- **Live service:** an agency map service drawn directly by the browser
  (raster context layers; not cached).
- **Planned:** identified but not wired in, with the reason.

Endpoints and terms were checked on 2026-10-31. "Refresh" is how often this app
checks the source; the agency's own cadence is listed separately.

## Wolf activity

| Source (id) | Owner | Endpoint | Agency cadence | Refresh | Precision | Terms | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Collared gray wolf locations, generalized cells (`cdfw-collared-wolf-cells`) | California Department of Fish and Wildlife | GeoJSON: https://storage.googleapis.com/cdfw-wolf-tracker/wolf_bins.geojson (feeds the map at https://wildlife.ca.gov/Conservation/Mammals/Gray-Wolf/Location-Map) | Automated, about daily. Each hexagon cell holds the most recent location date of one GPS-collared wolf. | 60 min, conditional request | Agency hexagon cell; date only | CDFW Conditions of Use (https://wildlife.ca.gov/Conditions-of-Use) and the tool's stated limitations | Live |
| Wolf pack areas, current year (`wdfw-wolf-packs-current`) | Washington Department of Fish and Wildlife | ArcGIS: https://geodataservices.wdfw.wa.gov/arcgis/rest/services/WP_Statewide/Wolf_PackPolygons/MapServer/0 | Annual, after the year-end survey (currently survey year 2025) | Daily | Pack territory polygon; year | Public WDFW map service; no reuse license stated, credit WDFW | Live |
| Gray wolf distribution (`mtfwp-wolf-distribution`) | Montana Fish, Wildlife & Parks | ArcGIS: https://services3.arcgis.com/Cdxz8r11hT0MGzg1/arcgis/rest/services/WILD_DISTRIB_WOLF/FeatureServer/0 (item https://www.arcgis.com/home/item.html?id=0b2a98d65f4746f1b9c2a247fca9dad6) | Periodic; last data edit 2023-10 | Daily | Distribution area; layer edit date | Provided "as is" per item terms; credit FWP | Live |
| Mexican wolf occupied range, 2020 (`usfws-mexican-wolf-occupied-range-2020`) | U.S. Fish and Wildlife Service, Mexican Wolf Recovery Program | ArcGIS: https://services.arcgis.com/QVENGdaPbd4LUkLV/arcgis/rest/services/2020_Occupied_Range/FeatureServer/1 (item https://www.arcgis.com/home/item.html?id=4fb4062ee7a14a36bc3806cbd7b402d0) | Static 2020 layer | Daily | Distribution area; layer edit date | U.S. federal data, public domain in the U.S.; USFWS disclaimer | Live |

## Wolf management areas

| Source (id) | Owner | Endpoint | Agency cadence | Refresh | Terms | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Mexican Wolf Experimental Population Area (`usfws-mwepa`) | U.S. Fish and Wildlife Service | https://services.arcgis.com/QVENGdaPbd4LUkLV/arcgis/rest/services/2020_Occupied_Range/FeatureServer/6 | Changes only with rulemaking | Weekly | U.S. federal data, public domain in the U.S. | Live |
| Wolf management zones (`idfg-wolf-management-zones`) | Idaho Department of Fish and Game | https://services.arcgis.com/FjJI5xHF2dUPVrgK/arcgis/rest/services/Wolf_Management_Zones/FeatureServer/0 (item https://www.arcgis.com/home/item.html?id=71fda767b6e443caad932e231e7f4a2e) | Changes with regulations | Weekly | Public-use data, no warranty (item terms) | Live |
| Wolf regions and management units, 2026 season (`mtfwp-wolf-management-units`) | Montana Fish, Wildlife & Parks | https://services3.arcgis.com/Cdxz8r11hT0MGzg1/arcgis/rest/services/ADMBND_HD_WOLF_MANAGEUNITS/FeatureServer/0 (item https://www.arcgis.com/home/item.html?id=f2b9be818b73400d81ef616e54d48c20) | Changes each season | Weekly | Public FWP data provided "as is" (item terms) | Live |
| Wolf hunt areas (`wgfd-wolf-hunt-areas`) | Wyoming Game and Fish Department | https://services6.arcgis.com/cWzdqIyxbijuhPLw/arcgis/rest/services/Wolf_Hunt_Areas/FeatureServer/0 (item https://www.arcgis.com/home/item.html?id=ec5bbacd1a244ce6aa182a63963c80b8) | Changes with regulations | Weekly | Provided "as is" (item terms) | Live |
| Wolf management zones (`widnr-wolf-management-zones`) | Wisconsin Department of Natural Resources | https://dnrmaps.wi.gov/arcgis2/rest/services/WM_SPECIES_MGMT_ZONES/WM_WOLF_MGMT_ZONES_WTM_Ext/MapServer/0 | Changes with management plan updates | Weekly | Public map service; credit Wisconsin DNR | Live |

## Bears (off by default)

| Source (id) | Owner | Endpoint | Agency cadence | Refresh | Terms | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Grizzly bear occupied range, 2024 (`mtfwp-grizzly-occupied-range-2024`) | Montana Fish, Wildlife & Parks | https://services3.arcgis.com/Cdxz8r11hT0MGzg1/arcgis/rest/services/WILD_DISTRIB_GRIZZLYBEAR_EOR_MT_24/FeatureServer/0 (item https://www.arcgis.com/home/item.html?id=0297ed0bc53a4a8592c77e80af991d1b) | Updated with new survey years | Weekly | Public FWP data provided "as is" (item terms) | Live |
| Bear distribution (`mtfwp-bear-distribution`) | Montana Fish, Wildlife & Parks | https://services3.arcgis.com/Cdxz8r11hT0MGzg1/arcgis/rest/services/WILD_DISTRIB_BEARS_REGS/FeatureServer/0 (item https://www.arcgis.com/home/item.html?id=b59040cc67f742f1a0f1e72c05b2892b) | Changes with regulations | Weekly | Public FWP data provided "as is" (item terms) | Live |
| Black bear range, CWHR (`cdfw-black-bear-range`) | California Department of Fish and Wildlife | https://services2.arcgis.com/Uq9r85Potqm3MfRV/arcgis/rest/services/biosds792_fpu/FeatureServer/0 (item https://www.arcgis.com/home/item.html?id=5304ab369678420085b2e2d4f7d2d039) | Rarely | Weekly | Public CDFW data (item terms) | Live |
| Black bear habitat (`udwr-black-bear-habitat`) | Utah Division of Wildlife Resources | https://services.arcgis.com/ZzrwjTRez6FJiOq4/arcgis/rest/services/Utah_Black_Bear_Habitat/FeatureServer/0 (item https://www.arcgis.com/home/item.html?id=6440f19a05c149b783baf1705e5f2a51) | Rarely | Weekly | Public DWR data (item terms) | Live |

No public, agency-owned service for federal grizzly bear recovery zones was
found; they will be added when one is published.

## Context

| Source (id) | Owner | Endpoint | Agency cadence | Refresh | Terms | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Wildfire perimeters, current (`nifc-wildfire-perimeters`) | National Interagency Fire Center (WFIGS) | https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0 | Near real time | 15 min, skipped when `editingInfo.lastEditDate` is unchanged | U.S. federal data, public domain in the U.S.; NIFC disclaimer | Live |
| Weather watches, warnings and advisories (`nws-watches-warnings`) | National Weather Service | https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1 | Near real time | 15 min | U.S. federal data, public domain in the U.S.; https://www.weather.gov/disclaimer | Live (off by default) |
| Who manages the land, from the Surface Management Agency data (`blm-surface-management-agency`) | Bureau of Land Management | Export of layer 1 with a fixed per-agency color renderer (`ADMIN_AGENCY_CODE`), and `identify` for the click popup: https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer | Periodic | Drawn live, from zoom 6 | U.S. federal data | Live service |
| Grazing allotments, BLM (`blm-grazing-allotments`) | Bureau of Land Management | Export, layer 12: https://gis.blm.gov/arcgis/rest/services/range/BLM_Natl_Grazing_Allotment/MapServer | Periodic | Drawn live | U.S. federal data | Live service |
| Grazing allotments, Forest Service (`usfs-range-allotments`) | USDA Forest Service | Export, layer 0: https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RangeManagement_01/MapServer (visible from zoom 8 because of the service's scale limit) | Periodic | Drawn live | U.S. federal data | Live service |
| Protected and managed areas, PAD-US 4 by manager type (`usgs-padus-manager-type`) | U.S. Geological Survey, Gap Analysis Project | Vector tiles: https://tiles.arcgis.com/tiles/v01gqwM5QqNysAAi/arcgis/rest/services/PADUS_Management_Areas_Manager_Type/VectorTileServer (USGS-owned item https://www.arcgis.com/home/item.html?id=f71b5910fbcf4349b384b298f1247eb7) | Major release about every two years | Drawn live, from zoom 5 | U.S. federal data, public domain in the U.S.; USGS no-warranty statement | Live service |
| County boundaries (`census-county-boundaries`) | U.S. Census Bureau | Export, scale-dependent county layers: https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer | Current TIGER vintage | Drawn live, from zoom 5 | U.S. federal data, public domain in the U.S. | Live service |
| Federal American Indian reservations and off-reservation trust lands (`census-tribal-lands`) | U.S. Census Bureau | Export, layers 2 and 3: https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/AIANNHA/MapServer | Current TIGER vintage | Drawn live | U.S. federal data, public domain in the U.S. Statistical boundaries, not legal surveys. | Live service |
| Terrain, shaded relief (`usgs-shaded-relief`) | U.S. Geological Survey, The National Map | Cached tiles: https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer | Periodic | Drawn live | U.S. federal data, public domain in the U.S. | Live service |
| Streams and water bodies, NHD (`usgs-hydrography`) | U.S. Geological Survey, The National Map | Cached tiles: https://basemap.nationalmap.gov/arcgis/rest/services/USGSHydroCached/MapServer | Retired by USGS in October 2023; served but no longer maintained | Drawn live | U.S. federal data, public domain in the U.S. | Live service |
| Land cover, NLCD 2021 lower 48 (`mrlc-nlcd-land-cover`) | Multi-Resolution Land Characteristics Consortium (USGS lead) | WMS layer `NLCD_2021_Land_Cover_L48`: https://www.mrlc.gov/geoserver/mrlc_display/wms | Static edition | Drawn live | U.S. federal data, public domain in the U.S.; WMS lists no fees or access constraints | Live service |

Basemap: OpenFreeMap (https://openfreemap.org/), free with no API key or usage
limits, attribution "OpenFreeMap © OpenMapTiles Data from OpenStreetMap".

## Planned

Checked on 2026-10-31 with the ArcGIS Online search API, the agencies' own
open data sites, and direct requests to each endpoint.

| Candidate | Owner | URL | Why not Live yet |
| --- | --- | --- | --- |
| Approximate area of gray wolf activity | California Department of Fish and Wildlife | https://wildlife.ca.gov/Conservation/Mammals/Gray-Wolf/Updates | Published as JPEG/PDF only. The collared wolf cells above are CDFW's machine-readable layer. |
| Monthly collared wolf activity by watershed (HUC-10) | Colorado Parks and Wildlife | https://cpw.state.co.us/wolf-sightings | Published as a PDF map. CPW's public ArcGIS services (for example https://services5.arcgis.com/ttNGmDvKQA7oeDQ3/arcgis/rest/services/CPWAdminData/FeatureServer) hold administrative boundaries and Survey123 field forms, not a public wolf layer. |
| Areas of known wolf activity | Oregon Department of Fish and Wildlife | https://www.dfw.state.or.us/Wolves/ | No ODFW-owned public activity service found. ODFW publishes a modeled gray wolf range (GAP), layer 89 of https://services.arcgis.com/uUvqNMGPm7axC2dD/arcgis/rest/services/SGCN_GAP_Ranges_Mammals/FeatureServer, with no stated terms; modeled habitat is not activity. The only activity-area services found are third-party copies from 2016. |
| Wolf range and pack data | Minnesota Department of Natural Resources | https://www.dnr.state.mn.us/mammals/wolves/index.html | No public wolf layer on the Minnesota Geospatial Commons or the DNR's ArcGIS organization. |
| Wolf range and pack data | Michigan Department of Natural Resources | https://www.michigan.gov/dnr/education/michigan-species/mammals/wolves-in-michigan | No public wolf layer on the Michigan DNR open data hub. |
| Predator damage management data | USDA APHIS Wildlife Services | https://www.aphis.usda.gov/wildlife-services/publications/pdr | Annual Program Data Reports are tables by state and species; no spatial service. |
| Recent Mexican wolf locations (weekly hexagons) | Arizona Game and Fish Department | https://services2.arcgis.com/os1CphwIyxBDDUGn/arcgis/rest/services/WolfWeeklyHexagons/FeatureServer/0 | Requires a token; not public. |
| Generalized Mexican wolf locations | Arizona Game and Fish Department | https://services2.arcgis.com/os1CphwIyxBDDUGn/arcgis/rest/services/Wolf_locations_generalized_public/FeatureServer/0 | Public, but data last edited 2018-05. Would need a clear historical label. |
| Mexican wolf occupied range | Arizona Game and Fish Department | https://services2.arcgis.com/os1CphwIyxBDDUGn/arcgis/rest/services/WolfOccupiedRange/FeatureServer/0 | Data last edited 2019-12; the 2020 USFWS layer above is newer. |
| Wolf harvest by deer and elk hunting district, current season | Montana Fish, Wildlife & Parks | https://services3.arcgis.com/Cdxz8r11hT0MGzg1/arcgis/rest/services/Montana_Wolf_Harvest_Summary_by_Deer_Elk_Hunting_District/FeatureServer/0 | Public and updated daily, but a table with no geometry. Needs a join to hunting district boundaries. |
| Archived wolf observation layers (pre-2019) | Washington Department of Fish and Wildlife | WDFW WildObs services (not verified) | Historical only; would need a historical label. |
| Esri Living Atlas layers (USA Counties, USA Detailed Streams, Annual NLCD, World Hillshade) | Esri | https://livingatlas.arcgis.com/ | Licensed under the Esri Master License Agreement. Use outside ArcGIS needs an ArcGIS account or API key and "Powered by Esri" attribution. The federal originals above (Census, USGS, MRLC) are public domain and are used instead. |
| Weather alerts API | National Weather Service | https://api.weather.gov/alerts/active | Most alerts are zone-based with no geometry (17 of 370 had geometry on 2026-10-31); the NWS MapServer above is used instead. |

To propose a source, open an issue with the public URL, the owner, and its
terms. Do not add URLs that have not been checked.
