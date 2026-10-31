# Test fixtures

Recorded from the live public endpoints on 2026-10-31 and trimmed to a few
features. Used only by the tests; they are not served by the app.

- `cdfw-wolf-bins.json`: CDFW wolf location tool GeoJSON
  (https://storage.googleapis.com/cdfw-wolf-tracker/wolf_bins.geojson).
- `wdfw-layer.json`, `wdfw-query-page1.json`, `wdfw-query-page2.json`: WDFW
  wolf pack polygons (current year) layer metadata and two query pages.
  `exceededTransferLimit` was set on page 1 to exercise pagination.
- `nifc-layer.json`, `nifc-query.json`: NIFC WFIGS current perimeters layer
  metadata (with `editingInfo`) and a two-feature query.
