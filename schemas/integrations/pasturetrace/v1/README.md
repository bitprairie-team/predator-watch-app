# PastureTrace integration schemas, v1 (Planned)

JSON Schemas (draft 2020-12) for the planned link between a private
Predator Watch tenant and PastureTrace. Nothing in the public map sends or
receives these messages.

- `inbound.schema.json`: an animal event from PastureTrace to Predator Watch.
- `outbound.schema.json`: an alert from Predator Watch to PastureTrace for a
  time window.

Both schemas set `additionalProperties: false` and also reject any location
field by name (`lat`, `lon`, `lng`, `latitude`, `longitude`, `geometry`,
`coordinates`, `location`, `position`, `point`, `x`, `y`, `wkt`, `geojson`,
`bbox`, and others). Locations stay with the rancher's own system; the
messages only carry ids, times, and levels.

`window_end` must not be before `window_start`. JSON Schema cannot compare
two fields, so receivers check that in code (the tests show the check).
TypeScript shapes for both messages are in `src/private/types.ts`.

Tests: `test/pasturetrace-schema.test.ts`.
