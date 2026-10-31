#!/usr/bin/env node
// Create a rancher access key for a tenant. Prints the key once (give it to
// the rancher) and the wrangler commands that store only its SHA-256 hash.
// Nothing is sent anywhere by this script.
//
//   node scripts/rancher-access-key.mjs <tenant-id> <user-id> [scope ...]
//
// Scopes default to rancher:read (all read-only tools). Add --local to the
// printed commands to write to the local dev KV instead of production.
import { createHash, randomBytes } from "node:crypto";

const [tenant, user, ...scopes] = process.argv.slice(2);
const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
if (!tenant || !user || !ID.test(tenant) || !ID.test(user)) {
  console.error("usage: node scripts/rancher-access-key.mjs <tenant-id> <user-id> [scope ...]  (ids: lowercase letters, digits, dashes)");
  process.exit(1);
}
const key = "pwk_" + randomBytes(24).toString("base64url");
const hash = createHash("sha256").update(key).digest("hex");
const record = { tenant_id: tenant, user_id: user, scopes: scopes.length ? scopes : ["rancher:read"], created_at: new Date().toISOString() };

console.log(`Access key (shown once, give it to the rancher):\n  ${key}\n`);
console.log("Store the hash:");
console.log(`  npx wrangler kv key put --binding PRIVATE_KV 'accesskey:${hash}' '${JSON.stringify(record)}'`);
console.log("\nRevoke later by rewriting the record with \"revoked\": true.");
