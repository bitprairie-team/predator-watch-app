#!/usr/bin/env node
// Create a rancher access key for a tenant. Prints the key once (give it to
// the rancher) and the wrangler command that stores only its SHA-256 hash.
// Nothing is sent anywhere by this script.
//
//   node scripts/rancher-access-key.mjs <tenant-id> <user-id> [scope ...] [options]
//
// Options:
//   --tools a,b,c       only these tools (default: every tool the scopes allow)
//   --expires 90d|ISO   key stops working after this many days or at this time
//                       (default 365d; use --expires never for no expiry)
//   --calls-per-day N   tool calls per day for this key
//   --label TEXT        a note for you, for example "laptop MCP client"
//
// Scopes default to rancher:read (all read-only tools). Add --local to the
// printed command to write to the local dev KV instead of production.
import { createHash, randomBytes } from "node:crypto";

const TOOLS = ["recent_predator_activity", "allotment_wolf_activity", "fire_weather_alerts", "agency_contacts_and_reporting", "data_freshness", "nonlethal_deterrents", "weekly_summary", "my_audit_log"];
const SCOPES = ["rancher:read", "activity:read", "alerts:read", "directory:read", "docs:read", "summary:read", "audit:read"];

const args = process.argv.slice(2);
const opts = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) opts[a.slice(2)] = args[++i];
  else pos.push(a);
}
const [tenant, user, ...scopes] = pos;
const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const fail = (m) => {
  console.error(m);
  console.error("usage: node scripts/rancher-access-key.mjs <tenant-id> <user-id> [scope ...] [--tools a,b] [--expires 90d|ISO|never] [--calls-per-day N] [--label TEXT]");
  process.exit(1);
};
if (!tenant || !user || !ID.test(tenant) || !ID.test(user)) fail("ids: lowercase letters, digits, dashes");
const badScope = scopes.find((s) => !SCOPES.includes(s));
if (badScope) fail(`unknown scope: ${badScope}`);

const record = { tenant_id: tenant, user_id: user, scopes: scopes.length ? scopes : ["rancher:read"], created_at: new Date().toISOString() };
if (opts.tools) {
  const tools = opts.tools.split(",").map((t) => t.trim()).filter(Boolean);
  const bad = tools.find((t) => !TOOLS.includes(t));
  if (bad) fail(`unknown tool: ${bad}`);
  record.tools = tools;
}
const exp = opts.expires ?? "365d";
if (exp !== "never") {
  const days = /^(\d{1,4})d$/.exec(exp);
  const at = days ? new Date(Date.now() + Number(days[1]) * 86400_000) : new Date(exp);
  if (Number.isNaN(at.getTime())) fail(`bad --expires: ${exp}`);
  record.expires_at = at.toISOString();
}
if (opts["calls-per-day"] !== undefined) {
  const n = Number(opts["calls-per-day"]);
  if (!Number.isInteger(n) || n < 1) fail("--calls-per-day must be a whole number above 0");
  record.calls_per_day = n;
}
if (opts.label) record.label = String(opts.label).slice(0, 80);

const key = "pwk_" + randomBytes(24).toString("base64url");
const hash = createHash("sha256").update(key).digest("hex");

console.log(`Access key (shown once, give it to the rancher):\n  ${key}\n`);
console.log(`Key id in the audit log: ${hash.slice(0, 12)}\n`);
console.log("Store the hash:");
console.log(`  npx wrangler kv key put --binding PRIVATE_KV 'accesskey:${hash}' '${JSON.stringify(record).replace(/'/g, "'\\''")}'`);
console.log('\nRevoke later by rewriting the record with "revoked": true. MCP connections made with this key stop at the next request.');
