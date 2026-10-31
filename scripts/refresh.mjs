#!/usr/bin/env node
// Runs the scheduled refresh once against a LOCAL `wrangler dev` and prints
// what each source did. Local only: it refuses any non-local host, so it can
// never trigger the deployed Worker.
//
//   npx wrangler dev --test-scheduled      # in one terminal
//   npm run refresh                        # in another
//   npm run refresh -- --url http://127.0.0.1:8788
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const base = new URL(arg("--url") ?? process.env.REFRESH_URL ?? "http://127.0.0.1:8787");
if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(base.hostname)) {
  console.error(`refusing to trigger ${base.origin}: npm run refresh only runs against a local wrangler dev`);
  process.exit(2);
}
const cron = encodeURIComponent("*/15 * * * *");
const triggers = [`/cdn-cgi/handler/scheduled?cron=${cron}`, `/__scheduled?cron=${cron}`];

async function trigger() {
  for (const path of triggers) {
    try {
      const res = await fetch(new URL(path, base));
      if (res.ok) return path;
    } catch (e) {
      console.error(`cannot reach ${base.origin}: ${e.message}. Is \`npx wrangler dev --test-scheduled\` running?`);
      process.exit(1);
    }
  }
  console.error("the scheduled handler is not exposed; start wrangler dev with --test-scheduled");
  process.exit(1);
}

const before = (await (await fetch(new URL("/api/status", base))).json()).runs?.[0]?.finished_at ?? null;
const used = await trigger();
console.log(`triggered ${used} on ${base.origin}; waiting for the run to finish…`);
// The handler returns at once and refreshes in waitUntil; wait for a new run log entry.
const deadline = Date.now() + 10 * 60_000;
let run = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  const status = await (await fetch(new URL(`/api/status?t=${Date.now()}`, base))).json();
  if (status.runs?.[0] && status.runs[0].finished_at !== before) {
    run = status.runs[0];
    break;
  }
}
if (!run) {
  console.error("no new run recorded within 10 minutes");
  process.exit(1);
}
console.log(`run finished ${run.finished_at} in ${(run.duration_ms / 1000).toFixed(1)} s, ${run.requests} requests`);
for (const [id, s] of Object.entries(run.sources)) {
  console.log(`  ${s.state.padEnd(9)} ${id}${s.feature_count != null ? ` (${s.feature_count})` : ""}${s.error ? `: ${s.error}` : ""}`);
}
process.exit(Object.values(run.sources).some((s) => s.state === "error") ? 3 : 0);
