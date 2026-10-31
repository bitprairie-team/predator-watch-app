# Contributing

Thanks for helping. Bug reports, new public sources, accessibility fixes and
documentation are all welcome.

## Ground rules

- **Public agency data only.** A source must be published by a government
  agency or similar public body, readable without a token, under terms that
  allow display with attribution.
- **No added precision.** Never show data more precisely than the agency
  publishes it.
- **Honest freshness.** Keep the agency's own dates; do not invent them.
- **Plain writing.** Neutral, factual wording in the UI and docs. Mark
  anything not built yet as Planned.

## Suggesting a source

Open a [New data source](https://github.com/steelhead99x/predator-watch-app/issues/new?template=new-source.yml)
issue with the URL, the agency page and the terms you found.

## Adding a source yourself

1. Check the layer (`?f=json` for ArcGIS) as described in
   [docs/adding-an-arcgis-layer.md](docs/adding-an-arcgis-layer.md).
2. Add an entry to `src/config/sources.ts` (about 20 lines, no code).
3. Run `npm test` and `npm run typecheck`.
4. Run `npx wrangler dev`, trigger the refresh with
   `curl http://127.0.0.1:8787/cdn-cgi/local/scheduled`, and look at the layer.
5. Add a row to [docs/data-sources.md](docs/data-sources.md) with the URL,
   owner, cadence, terms and status.

## Code changes

```sh
npm i
npm test
npm run typecheck
npx wrangler dev
```

- Keep public routes reading from KV and the cache only. Agency servers are
  called by the scheduled job, never by a visitor's request.
- Tests use recorded fixtures and must not need the network.
- The front end is plain JavaScript modules with no build step. Keep it light
  and accessible: label controls, keep keyboard access, and check contrast.
- Never commit secrets. `.dev.vars` is gitignored.

## Pull requests

Describe what changed and why, link the issue, and include a screenshot for
visible changes. By contributing you agree that your work is licensed under
Apache-2.0 and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).
