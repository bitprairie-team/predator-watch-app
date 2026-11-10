# Public API

All endpoints are read-only and need no key. Catalog, source and export
endpoints allow cross-origin `GET`, `HEAD`, and `OPTIONS`.
`/api/geocode` allows those methods only from `https://app.predatorwatch.org`
(and from localhost when the Worker is running locally). Data is the agencies' own published data, refreshed
by the Worker on each source's schedule (see `docs/data-sources.md`).
Credit the agency named in each response when you reuse it.

Base URL: `https://app.predatorwatch.org`

## Conventions

- **Caching.** Responses carry `Cache-Control` (`public, max-age=N,
  stale-while-revalidate=5N`) and a weak `ETag`. Send `If-None-Match` to get
  `304 Not Modified` when nothing changed.
- **Errors** are JSON: `{ "error": "message", "status": 400 }`, not cached.
  `400` for bad parameters, `404` for unknown ids, `405` for
  other methods (with `Allow`), `414` for query strings over 512 characters,
  `429` when place search is busy (with `Retry-After`).
- **Coordinates** are WGS 84 longitude, latitude (CRS84). Geometry is never
  more precise than the agency publishes it. Rings that cross the
  antimeridian are unwrapped so they do not span the globe.
- **Times** are RFC 3339 UTC strings.

## Map API

| Endpoint | Returns |
| --- | --- |
| `GET /api/layers` | Every layer with its agency, license, cadence, style, and status, plus `planned` features and `planned_sources` (checked candidates and why they are not live). |
| `GET /api/sources/{id}` | GeoJSON FeatureCollection for one source. `metadata` holds the source info and status (`checked_at`, `received_at`, `source_updated_at`, `feature_count`, `state`). |
| `GET /api/sources/{id}.geojson` | Same, as a download. |
| `GET /api/sources/{id}.kml` | KML 2.2 download. One Placemark per feature, properties in `ExtendedData`. |
| `GET /api/sources/{id}.csv` | CSV download. One row per feature, property columns, `detail: <name>` columns, and a `wkt` geometry column. Cells that start with `=`, `+`, `-`, or `@` and are not numbers are prefixed with `'` so spreadsheets do not run them as formulas. |
| `GET /api/sources/{id}/changes` | What changed at the last refreshes of one source (below). |
| `GET /api/changes` | The same for every source. |
| `GET /api/geocode?q=…` | Place search (below). |
| `GET /api/health` | `{ "ok": true, "sources": N }`. Not cached. |

Download file names are `{id}-{YYYY-MM-DD}.{ext}`, using the date the data
was received from the agency.

### Changes feed

Each refresh that brings new data is compared with the previous copy. Up to
10 entries are kept per source, newest first:

```json
{
  "source_id": "wdfw-wolf-packs-current",
  "checked_at": "2026-10-31T20:00:04.112Z",
  "received_at": "2026-10-31T20:00:04.112Z",
  "changes": [
    {
      "at": "2026-10-31T20:00:04.112Z",
      "added": 1, "removed": 0, "modified": 2,
      "added_items": [{ "id": "…", "label": "…" }],
      "removed_items": [],
      "modified_items": [{ "id": "…", "label": "…" }]
    }
  ]
}
```

Up to 20 items are listed per kind; the counts are always complete. A source
whose configuration changed starts a new history.

### Place search

Places, counties and ZIP codes are searched in the browser against static
files built from the U.S. Census Bureau Gazetteer (public domain), so they
never reach an outside service:

- `/data/gazetteer/{letter}.json`: `[name, state, lat, lon, kind, land_sq_mi]`,
  where kind is `p` (place) or `c` (county), sorted by name.
- `/data/gazetteer/zip/{first two digits}.json`: `{ "59715": [lat, lon] }`.
- Rebuild with `node scripts/build-gazetteer.mjs`.

`/api/geocode?q=` only accepts street addresses (a house number then a
street, 8 to 120 characters). Anything else gets a 400. Addresses are looked
up with the [U.S. Census Bureau Geocoder](https://geocoding.geo.census.gov/geocoder/).
Results are cached at the edge for a day. Calls to the Census service are
capped across all clients, and one isolate calls it at most once a second.

```json
{ "query": "1 Main St, Helena MT", "results": [{ "name": "1 MAIN ST, HELENA, MT, 59601", "lat": 46.59, "lon": -112.03, "bbox": null }],
  "attribution": "Address search: U.S. Census Bureau Geocoder. This product uses the Census Bureau Data API but is not endorsed or certified by the Census Bureau." }
```

The map also accepts `lat, lon` typed directly without calling this endpoint.

### Status

`/api/status` lists every source with `state`, `last_success_at`,
`last_change_at`, `last_attempt_at`, `failures_in_a_row`, `last_error_at`,
`last_error`, `feature_count`, `refresh_minutes` and `overdue`. It also gives
`last_cron_run`. A readable version is at [/status](/status).

### Caching and rate limits

Every public response is built from the KV cache and stored in the
Cloudflare edge cache (`s-maxage`, 30 seconds to a day depending on the
endpoint; `x-edge-cache: HIT|MISS` says which). Public requests never call an
agency server. Only the 15-minute cron does that.

Per-client limits, per Cloudflare location (approximate):

| Class | Applies to | Limit |
| --- | --- | --- |
| api | `/api/*`, `/ogc/*` | 600 requests a minute |
| export | `.geojson`, `.kml`, `.csv`, OGC items with `limit` over 100 | 60 a minute |
| search | `/api/geocode` | 30 a minute |

Over the limit you get `429` with `Retry-After: 60` and the usual error JSON.

## OGC API – Features

A read-only service following OGC API – Features – Part 1: Core, with
GeoJSON encoding. Each wolf or context source with features is a
collection. Agency map-service layers that are drawn as images (for example
land cover) are not collections.

| Endpoint | Returns |
| --- | --- |
| `GET /ogc` | Landing page with links. |
| `GET /ogc/conformance` | Conformance classes (Core, GeoJSON). |
| `GET /ogc/collections` | Collections with title, attribution, terms, and extent. |
| `GET /ogc/collections/{id}` | One collection, with links to items and to the GeoJSON, KML, and CSV downloads. |
| `GET /ogc/collections/{id}/items` | Features, `application/geo+json`. |
| `GET /ogc/collections/{id}/items/{featureId}` | One feature. |

Items parameters:

- `bbox=minLon,minLat,maxLon,maxLat`: four numbers in range, `minLat ≤
  maxLat`. `minLon > maxLon` is a box that crosses the antimeridian.
- `limit`: 1 to 1000, default 100.
- `offset`: 0 or more, for paging. `next` and `prev` links are included.
- `f`: `json` or `geojson`.

Any other parameter is a `400`, so a typo is not silently ignored. Responses
include `numberMatched`, `numberReturned`, and `timeStamp`.

Examples:

```sh
curl 'https://app.predatorwatch.org/ogc/collections'
curl 'https://app.predatorwatch.org/ogc/collections/wdfw-wolf-packs-current/items?bbox=-121,46,-116,49&limit=10'
curl -OJ 'https://app.predatorwatch.org/api/sources/mtfwp-wolf-distribution.kml'
```

QGIS: *Layer → Add Layer → Add WFS / OGC API – Features Layer*, new
connection, URL `https://app.predatorwatch.org/ogc`, version *OGC API –
Features*.

ArcGIS Pro: *Insert → Connections → Server → New OGC API Server*, URL
`https://app.predatorwatch.org/ogc`.
