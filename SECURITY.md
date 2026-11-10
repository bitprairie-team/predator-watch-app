# Security policy

## Reporting a vulnerability

Please report security problems privately through
[GitHub security advisories](https://github.com/bitprairie-team/predator-watch-app/security/advisories/new)
or by email to [hello@predatorwatch.org](mailto:hello@predatorwatch.org).
Do not open a public issue.

Include what you found, how to reproduce it and the impact you expect. We aim
to acknowledge reports within a few days and will credit you in the fix
unless you prefer otherwise.

## Scope

- The Worker and static site in this repository, deployed at
  https://app.predatorwatch.org.
- Out of scope: agency services the map reads from (report those to the
  agency), denial of service through volume, and findings that need a
  compromised device.

## Design notes

- The public map stores no accounts, no user data and no private data.
- No secrets are needed to run it. An optional ArcGIS API key is only ever an
  environment secret and is never committed.
- Public requests read cached data only; only the scheduled job calls agency
  servers. Per-client rate limits apply to `/api`, `/ogc` and exports.
- A strict Content Security Policy and other security headers are set in
  `public/_headers`.
