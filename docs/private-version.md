# Private collaboration space (Planned)

Status: **Planned.** Nothing here is built. The public map does not collect,
store, or show any rancher data, and the public build has no code path for
it. This document describes the design so it can be reviewed before any code
is written.

## Purpose

A paid, private workspace where ranchers, community members, local
government, tribal governments, and state and federal agencies share
predator-related information under written agreements. Each party controls
what it shares, with whom, and at what precision. The public map stays free.

## Organizations and people

Org types: `ranch`, `community-group`, `local-government`,
`tribal-government`, `state-agency`, `federal-agency`, `university`.

- Each person belongs to one or more orgs with a role: owner, admin, member,
  or viewer.
- Each org lists **points of contact**: name, title, email, optional phone,
  hours, and the order to try them. Agencies can list an after-hours line.
- Orgs see each other only after an agreement links them.

## Data-sharing agreements

An agreement is the only way data leaves the org that owns it.

- Provider org, recipient orgs, and the data kinds covered: sightings, losses,
  collar cells, alerts, range schedules.
- The location tier (below), cell size, and delay.
- Whether the den-season holdback applies.
- Start and end dates, who signed and when, and a reference to the signed
  document kept in each org's own records.
- Either side can end an agreement. Shared views stop at once; past audit
  entries remain.

## Location tiers

| Tier | Who sees it | Precision | Delay |
| --- | --- | --- | --- |
| Own ranch | Only the ranch that owns the data | Full precision | None |
| Shared cell | Orgs under an agreement | Grid cells 1 to 2 miles across | 2 to 3 days |
| Aggregate | Orgs under an agreement, or public summaries if agreed | County or management unit counts | Set by agreement |

- Points are snapped to the cell grid on the server before any shared view is
  built. Exact points are never sent to another org.
- **Den-season holdback.** During den season, an agency can name holdback
  areas. Cells inside them are left out of every shared view. They are not
  drawn and not marked, so a gap does not reveal a den. The holdback area
  itself is held by the agency and is not shown to other orgs.
- Small counts in aggregates are suppressed so a single ranch cannot be
  identified.

## Schedules

Orgs can post grazing, turnout, gather, range-rider, agency patrol, and
meeting schedules, and choose which partner orgs see each one. Places are
referenced by pasture or allotment name, not drawn, unless an agreement
covers it.

## Audit log

Every view, export, create, update, delete, share, agreement signature or
revocation, and login is logged with time, person, org, target, and the
agreement that allowed it. Provider orgs can read the log for their own data.
Entries cannot be edited. Retention is set per agreement, with a default of
seven years.

## ArcGIS Online and Enterprise

Each org can connect its own ArcGIS Online or ArcGIS Enterprise portal with
OAuth 2.0, using an app it registers in its own portal.

- The client secret stays in the Worker's secret store, never in the
  database or the repository.
- The org picks which of its layers to share, by item id. Access follows the
  org's ArcGIS permissions and the agreement, whichever is narrower.
- Tokens are per org and are refreshed on the server. Removing the
  connection revokes access.

## Intelligence and realtime systems

Alerts can come from partner intelligence and realtime systems such as
PastureTrace, which reads livestock tags and collars. The link is defined
in versioned JSON Schemas:

- `schemas/integrations/pasturetrace/v1/inbound.schema.json`: an animal
  event (`tenant_id`, `animal_id`, `event_type`, `timestamp`, `confidence`,
  `source: "pasturetrace"`).
- `schemas/integrations/pasturetrace/v1/outbound.schema.json`: an alert for
  a time window (`tenant_id`, `alert_level`, `species`, `window_start`,
  `window_end`, `reviewed`).

Neither message carries a location. Both schemas reject extra fields and any
location field by name. Each system keeps its own locations and matches
messages to its own pastures. Alerts marked `reviewed: false` are shown as
unreviewed.

## Code

- `src/private/types.ts`: TypeScript interfaces only. The public Worker does
  not import it; a test fails if any public module does.
- `test/pasturetrace-schema.test.ts`: schema tests.

## Open questions

- Hosting and data residency for agency partners.
- Retention defaults per data kind.
- Pricing, and how community groups and small ranches get access.
- Which agencies will name den-season holdback areas, and how they update
  them.
