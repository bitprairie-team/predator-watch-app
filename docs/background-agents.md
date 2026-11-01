# Background agents (private rancher plan)

Three small agents run for a rancher without a question being asked. Each one
reads the rancher's data through the same tool registry as chat and writes a
short summary with sources. No model writes the text. It is built from tool
data, so tool data can't steer it and numbers can't be made up.

| Agent | What it does | Tools it may call | When |
| --- | --- | --- | --- |
| `morning_digest` | Wolf activity on each allotment since yesterday, fire and weather alerts within 50 miles of each ranch, and any layer that is stale. | `allotment_wolf_activity`, `fire_weather_alerts`, `data_freshness` | Once a day after `hour_utc` (default 14). |
| `new_report_alert` | New agency layer items and shared rancher report cells near each ranch (default 10 miles) and inside each allotment. Tells you about each item once. | `recent_predator_activity`, `allotment_wolf_activity` | Every `interval_minutes` (default 60, at least 15). |
| `meeting_prep` | A packet for a meeting with the agency contact on file: your own records, agency layer activity on your allotments, shared reports (generalized), data limits, and the topics you want to raise. No coordinates. | `agency_contacts_and_reporting`, `recent_predator_activity`, `allotment_wolf_activity`, `data_freshness` | The day before `meeting_at`. |

Every write-up ends with: "This covers only the layers and records listed
here; it is not proof that nothing else happened." Each fact line carries an
`[S#]` marker, and the sources list gives the publisher, when the data was
observed, and when we received it (UTC).

## Guardrails

All of these are enforced in `src/agents/background.ts`, not left to each
agent.

- **Tool allowlist.** The run's context carries the agent's tool list, so the
  registry itself refuses any other tool (`403`). If the access key that
  started a manual run is limited to some tools, the run is limited too.
- **Read scopes only.** The run gets the agent's scopes, never the caller's.
  `agents:run` and `outbox:approve` are not passed on.
- **Caps.** Runs per day per agent and tenant, tool calls per run, cost units
  per run (one per tool call), and a tenant-wide budget of 400 cost units a
  day across agents. Manual runs are also limited to 20 an hour. A capped run
  stops and is recorded as `capped`.
- **Same output check as chat.** Legal determinations, doses, and lethal
  instructions block the write-up. Coordinates are redacted. Links that
  aren't from a source are removed. Uncited fact sentences and numbers that
  don't appear in the tool data are dropped.
- **Human approval before anything leaves.** Anything addressed outside
  (email or text) goes to the outbox as `pending_approval` for 7 days. Only a
  person on a web session with the `outbox:approve` scope can approve it, and
  the request must say `{"confirm": true}`. Agents and MCP clients can't
  approve. **Sending is Planned**: approval is recorded and audited, and the
  item says nothing was sent so the rancher can copy it.
- **Audit.** Every run (`agent.<id>`, with status), every tool call it makes
  (client `agent:<id>`), and every approval or rejection (`outbox.approve`,
  `outbox.reject`) is in the rancher's audit log. Run records are kept 90 days.
- **Kill switches.** See below. Checked before every run.
- **Tenant isolation.** Runs use the tenant's own context. State (for example
  which reports were already alerted) is stored per tenant and agent.

## Turning an agent on

Every agent, and the assistant, is **off by default for every account**. Only
the rancher turns one on, in Ranch tools (`/ranch.html`, Settings), or with
`PUT /api/ranch/settings/agents/:id {"on": true}`. The choice is stored per
account in `prefs:<tenant>` with who changed it and when, and every change is
in the activity log. The account owner can't turn an agent on for a rancher:
an `enabled` field on the tenant record is ignored.

The tenant record may still carry default settings under `agents`. The
rancher's own settings win:

```json
"agents": {
  "morning_digest": { "hour_utc": 14, "days": 1 },
  "new_report_alert": { "interval_minutes": 60, "radius_miles": 10 },
  "meeting_prep": { "contact_index": 0, "days": 30, "topics": [] }
}
```

Settings the rancher can change (validated; unknown keys are refused):

| Agent | Setting | Range |
| --- | --- | --- |
| `morning_digest` | `hour_utc`, `days`, `areas`, `deliver_to` | hour 0 to 23, days 1 to 7 |
| `new_report_alert` | `radius_miles`, `interval_minutes`, `days`, `areas`, `deliver_to` | 1 to 50 miles (default 10), 15 to 1440 minutes, 1 to 14 days |
| `meeting_prep` | `meeting_at`, `contact_index`, `days`, `topics`, `areas` | meeting within a year, days 7 to 90 |

`areas` is a list of the rancher's own ranch or allotment ids. A ranch id
covers that ranch and its allotments. Empty means all of them.

- Snooze: `POST /api/ranch/settings/agents/:id/snooze {"days": 1-30}` skips
  scheduled runs until then; `{"days": 0}` ends it.
- `deliver_to` is optional. Without it the result stays in the app.
- `meeting_prep` goes to the outbox addressed to the contact's email only if
  the contact on file has one.
- Topics are the rancher's own words. They are cleaned of instruction-like
  text and added after the safety check, labelled "your words".

The 15-minute cron (`scheduled()` in `src/index.ts`) runs every agent a
rancher turned on, that is not snoozed, and that is due. It does nothing unless `PRIVATE_KV` is bound.

## What I did

Every run writes a plain record to the activity log (`activity:<tenant>:…`,
kept 400 days): why it ran, which data it read and with what settings, the
sources with observed and received times, the rules that applied (limits, the
output check and what it held back, the outbox rule), and what was skipped or
declined and why. Browse it in Ranch tools, Activity log, or
`GET /api/ranch/activity`. Assistant answers, declines, voice lookups,
setting changes, corrections, and outbox decisions are logged the same way.

## Overrides

Each line an agent writes is an item with a stable id. On the run's record
the rancher can **dismiss** it, **mark it wrong**, **correct** it (with a
note), or **snooze** it for 1 to 90 days, and later **show it again**
(`POST /api/ranch/items/:agent/:item`). Later runs respect this: dismissed,
wrong, and snoozed items are left out and listed under skipped with the
reason; corrected items show with the rancher's note under "Your
corrections", checked like the rest of the text. If every new alert item was
overridden, the alert run is skipped and says so.

Outbox items can be edited before approval (`PATCH /api/ranch/outbox/:id`,
title, body, or recipient). The edit is checked for blocked content and for
exact coordinates not from the rancher's own records, the agent's original is
kept, and the change is logged.

## By hand

Everything an agent does can be done by hand, with the assistant and every
agent off: `src/rancher/manual.ts` lists, for each agent, the routes that do
the same work (build the digest, check for new reports, build or download the
meeting packet, view allotment activity, nearby reports, alerts, contacts, and
data freshness, save alert areas, and exports). `test/manual-parity.test.ts`
checks each one works with everything off and that the page has a control for
it. A by-hand job does not change the agent's state, schedule, or caps.

## HTTP routes

All need a rancher access key and the rancher plan.

| Route | Scope | What it does |
| --- | --- | --- |
| `GET /api/assistant/agents` | any | The agents, their limits, whether each is on or paused, and the last scheduled run. |
| `GET /api/assistant/agents/runs` | any | Recent runs, newest first, with text, sources, and a sources footer. |
| `POST /api/assistant/agents/:id/run` | `agents:run` | Run now. |
| `POST /api/assistant/agents/:id/pause` / `resume` | `agents:run` | Pause or resume your own agent. |
| `GET /api/assistant/outbox` | any | Items waiting for approval, approved, rejected, or expired. |
| `POST /api/assistant/outbox/:id/approve` | `outbox:approve` | Body `{"confirm": true}`. Web session only. |
| `POST /api/assistant/outbox/:id/reject` | `outbox:approve` | |

Ranch tools routes (`/api/ranch/*`) are listed at the top of
`src/rancher/ranch-routes.ts`. They need the rancher plan, but not the
assistant to be on.

Create a web key with these scopes (`settings:write` lets the rancher turn
things on and change settings and items):

```sh
node scripts/rancher-access-key.mjs <tenant> <user> rancher:read settings:write agents:run outbox:approve --label "web app"
```

## Kill switches

Any one of these stops work right away. They are checked at the start of
every chat turn, voice step, MCP request, and agent run.

| Switch | Effect |
| --- | --- |
| var `ASSISTANT_DISABLED=1` | Whole assistant off: chat, voice, tools, MCP, and agents return `503`. |
| var `AGENTS_DISABLED=1` | All background agents off. |
| KV `killswitch:global` = `{"assistant": true}` or `{"agents": true}` | Same, without a deploy. Optional `"reason"` is shown to ranchers. |
| KV `killswitch:tenant:<tenant>` | Same fields, one tenant. |
| KV `killswitch:agent:<agent id>` = `{"agents": true}` | One agent for everyone. |
| KV `agentpause:<tenant>:<agent id>` | Set by the rancher with the pause route. |

With wrangler (add `--local` for local dev):

```sh
# everything off, now
npx wrangler kv key put --binding PRIVATE_KV killswitch:global '{"assistant":true,"reason":"Down for maintenance."}'
# agents only
npx wrangler kv key put --binding PRIVATE_KV killswitch:global '{"agents":true}'
# one tenant
npx wrangler kv key put --binding PRIVATE_KV killswitch:tenant:<tenant> '{"assistant":true}'
# one agent
npx wrangler kv key put --binding PRIVATE_KV killswitch:agent:new_report_alert '{"agents":true}'
# back on
npx wrangler kv key delete --binding PRIVATE_KV killswitch:global
```

KV changes can take up to a minute to reach every location. The environment
variables take effect on the next deploy.

## Planned

- Sending approved items by email or text.
- Spoken digests.
