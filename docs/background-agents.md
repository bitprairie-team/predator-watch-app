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

Agent settings live on the tenant record under `agents`:

```json
"agents": {
  "morning_digest": { "enabled": true, "hour_utc": 14, "days": 1, "deliver_to": { "channel": "email", "to": "rancher@example.invalid" } },
  "new_report_alert": { "enabled": true, "interval_minutes": 60, "radius_miles": 10 },
  "meeting_prep": { "enabled": true, "meeting_at": "2026-11-12T17:00:00Z", "contact_index": 0, "days": 30, "topics": ["Range rider schedule for spring"] }
}
```

- Off unless `enabled` is `true`.
- `deliver_to` is optional. Without it the result stays in the app.
- `meeting_prep` goes to the outbox addressed to the contact's email only if
  the contact on file has one.
- Topics are the rancher's own words. They are cleaned of instruction-like
  text and added after the safety check, labelled "your words".

The 15-minute cron (`scheduled()` in `src/index.ts`) runs every enabled agent
that is due. It does nothing unless `PRIVATE_KV` is bound.

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

Create a web key with these scopes:

```sh
node scripts/rancher-access-key.mjs <tenant> <user> rancher:read agents:run outbox:approve --label "web app"
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
- A screen in the app to read, approve, and reject outbox items, and to turn
  agents on.
- Spoken digests.
