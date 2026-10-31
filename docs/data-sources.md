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
| Wolf hunt areas (`wgfd-wolf-hunt-areas`) | Wyoming Game and Fish Department | https://services6.arcgis.com/cWzdqIyxbijuhPLw/arcgis/rest/services/Wolf_Hunt_Areas/FeatureServer/0 (item https://www.arcgis.com/home/item.html?id=ec5bbacd1a244ce6aa182a63963c80b8) | Changes with regulations | Weekly | Provided "as is" (item terms) | Live |
| Wolf management zones (`widnr-wolf-management-zones`) | Wisconsin Department of Natural Resources | https://dnrmaps.wi.gov/arcgis2/rest/services/WM_SPECIES_MGMT_ZONES/WM_WOLF_MGMT_ZONES_WTM_Ext/MapServer/0 | Changes with management plan updates | Weekly | Public map service; credit Wisconsin DNR | Live |

## Context

| Source (id) | Owner | Endpoint | Agency cadence | Refresh | Terms | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Wildfire perimeters, current (`nifc-wildfire-perimeters`) | National Interagency Fire Center (WFIGS) | https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0 | Near real time | 15 min, skipped when `editingInfo.lastEditDate` is unchanged | U.S. federal data, public domain in the U.S.; NIFC disclaimer | Live |
| Weather watches, warnings and advisories (`nws-watches-warnings`) | National Weather Service | https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1 | Near real time | 15 min | U.S. federal data, public domain in the U.S.; https://www.weather.gov/disclaimer | Live (off by default) |
| Public land ownership, surface management agency (`blm-surface-management-agency`) | Bureau of Land Management | Cached tiles: https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer | Periodic | Drawn live | U.S. federal data | Live service |
| Grazing allotments, BLM (`blm-grazing-allotments`) | Bureau of Land Management | Export, layer 12: https://gis.blm.gov/arcgis/rest/services/range/BLM_Natl_Grazing_Allotment/MapServer | Periodic | Drawn live | U.S. federal data | Live service |
| Grazing allotments, Forest Service (`usfs-range-allotments`) | USDA Forest Service | Export, layer 0: https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RangeManagement_01/MapServer (visible from zoom 8 because of the service's scale limit) | Periodic | Drawn live | U.S. federal data | Live service |

Basemap: OpenFreeMap (https://openfreemap.org/), free with no API key or usage
limits, attribution "OpenFreeMap © OpenMapTiles Data from OpenStreetMap".

## Planned

| Candidate | Owner | URL | Why not Live yet |
| --- | --- | --- | --- |
| Approximate area of gray wolf activity | California Department of Fish and Wildlife | https://wildlife.ca.gov/Conservation/Mammals/Gray-Wolf/Updates | Published as JPEG/PDF only; no machine-readable layer found. |
| Monthly collared wolf activity by watershed (HUC-10) | Colorado Parks and Wildlife | https://cpw.state.co.us/wolf-sightings | Published as a PDF map only. |
| Generalized Mexican wolf locations | Arizona Game and Fish Department | https://services2.arcgis.com/os1CphwIyxBDDUGn/arcgis/rest/services/Wolf_locations_generalized_public/FeatureServer/0 | Public, but data last edited 2018-05. Would be misleading as "activity" without a clear historical label. |
| Mexican wolf occupied range (2019) | Arizona Game and Fish Department | AGFD `WolfOccupiedRange` ArcGIS item (URL to be confirmed) | Superseded by the 2020 USFWS layer above. |
| Wolf regions and management units (2026) | Montana Fish, Wildlife & Parks | https://services3.arcgis.com/Cdxz8r11hT0MGzg1/arcgis/rest/services/ADMBND_HD_WOLF_MANAGEUNITS/FeatureServer | Found; field mapping and terms review pending. Config-only to add. |
| Areas of known wolf activity | Oregon Department of Fish and Wildlife | Not verified | Believed PDF only; no service endpoint verified. |
| Wolf range and pack data | Minnesota DNR, Michigan DNR | Not verified | No public service endpoint verified yet. |
| Wildlife Services predator damage data | USDA APHIS Wildlife Services | Not verified | Program data tables; no spatial service verified. |
| Archived wolf observation layers (pre-2019) | Washington Department of Fish and Wildlife | WDFW WildObs services (not verified) | Historical only; would need a historical label. |
| Protected Areas Database (PAD-US) | U.S. Geological Survey | Not wired in | BLM surface management agency tiles cover land ownership for now. |
| Weather alerts API | National Weather Service | https://api.weather.gov/alerts/active | Most alerts are zone-based with no geometry (17 of 370 had geometry on 2026-10-31); the NWS MapServer above is used instead. |

To propose a source, open an issue with the public URL, the owner, and its
terms. Do not add URLs that have not been checked.
