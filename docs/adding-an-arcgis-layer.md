# Adding a public ArcGIS layer

Adding a public ArcGIS REST layer is a config change only. No adapter code is
needed.

## 1. Check the layer

Open the layer URL with `?f=json` and confirm:

- It ends in `/FeatureServer/<n>` or `/MapServer/<n>` and uses `https`.
- It is public (no token required) and the owner's terms allow display with
  attribution. Record the terms in `license`.
- The field names you want (`fields` in the response).
- Whether it has `editingInfo.lastEditDate`. If it does, the adapter skips the
  download when nothing changed. If it does not, the layer is re-read on every
  refresh, so choose a long `refreshMinutes`.
- Its `maxRecordCount` and `advancedQueryCapabilities.supportsPagination`. The
  adapter pages with `resultOffset` when supported and falls back to object id
  batches when not.

```sh
curl -s "https://.../FeatureServer/0?f=json" | jq '{name, geometryType, maxRecordCount, editingInfo, fields: [.fields[].name]}'
curl -s "https://.../FeatureServer/0/query?where=1%3D1&returnCountOnly=true&f=json"
```

## 2. Add an entry to `src/config/sources.ts`

```ts
{
  type: "arcgis",
  id: "agency-wolf-layer",              // lowercase, digits, dashes; unique
  name: "Wolf management units",         // shown in the layer list
  category: "wolf-management",           // wolf-activity | wolf-management | context
  species: "Gray wolf",                  // null for context layers
  agency: "Example Department of Fish and Wildlife",
  url: "https://services.arcgis.com/.../FeatureServer/0",
  infoUrl: "https://www.arcgis.com/home/item.html?id=...", // agency page or item page
  license: "Public data provided as is; credit the agency.",
  attribution: "Example Department of Fish and Wildlife",
  cadence: "Changes with hunting regulations.",
  refreshMinutes: 7 * 24 * 60,
  precision: "management-unit",          // see Precision in src/schema.ts
  where: "1=1",                          // optional filter
  maxAllowableOffset: 0.002,             // optional: generalize big polygons (degrees)
  geometryPrecision: 5,                  // optional: decimal places
  fields: {
    idField: "UNIT_ID",                  // optional stable id
    label: "Unit {UNIT_NAME}",           // template; {FIELD} is replaced
    observedAt: { field: "EDIT_DATE", format: "epoch-ms", precision: "day" },
    // or { fromLayer: true } to use the layer's editingInfo.lastEditDate
    details: { "Unit name": "UNIT_NAME" }, // extra fields shown in the details panel
  },
  style: { color: "#6b5b95", dashed: true },
}
```

Notes:

- Only fields named in `fields` (plus the object id) are requested.
- `observedAt.format` is one of `epoch-ms`, `iso`, `date-text` or `year`. Use
  the coarsest `precision` that matches what the agency publishes.
- Do not choose a `precision` finer than the agency's own. The map never
  makes data more precise than its source.
- `useApiKey: true` sends the optional `ARCGIS_API_KEY` secret as a token.
  Leave it off for public layers.
- `http: { minIntervalMs, timeoutMs, retries }` can tune politeness per
  source. Defaults: 250 ms between calls to the same host, 20 s timeout,
  2 retries on 429 or 5xx.

## 3. Test and document

```sh
npm test            # the registry test validates every entry
npx wrangler dev
curl -s http://127.0.0.1:8787/cdn-cgi/local/scheduled
curl -s http://127.0.0.1:8787/api/sources/agency-wolf-layer | jq '.metadata, .features[0].properties'
```

Then add a row to [data-sources.md](data-sources.md) with the URL, owner,
cadence, terms and status.
