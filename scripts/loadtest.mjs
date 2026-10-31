#!/usr/bin/env node
// Load test against a running Worker (default: wrangler dev on :8787).
//
//   npx wrangler dev &   curl localhost:8787/cdn-cgi/local/scheduled
//   node scripts/loadtest.mjs [baseUrl] [seconds] [connections]
//
// Scenario 1, "crowd": many different visitors open the map at once. Each
// request carries a random cf-connecting-ip (wrangler dev passes it through;
// in production Cloudflare sets it), and the mix matches one page view:
// shell files, the layer index, layer GeoJSON, status, and a search shard.
// Scenario 2, "one client": a single address hammers /api/layers, which
// should turn into 429s after the per-client limit.
import autocannon from "autocannon";

const base = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const seconds = Number(process.argv[3] ?? 20);
const connections = Number(process.argv[4] ?? 50);

const layers = await (await fetch(`${base}/api/layers`)).json();
const ids = layers.layers.filter((l) => l.type === "geojson").map((l) => l.id);
const paths = [
  "/", "/app.js", "/styles.css", "/api/layers", "/api/status", "/data/gazetteer/b.json",
  ...ids.map((id) => `/api/sources/${id}.geojson`),
];
const ip = () => `10.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}`;

const bad = {};

function run(title, opts) {
  return new Promise((resolve, reject) => {
    const inst = autocannon({ url: base, duration: seconds, connections, ...opts }, (err, r) => (err ? reject(err) : resolve(r)));
    autocannon.track(inst, { renderProgressBar: false, renderResultsTable: false, renderLatencyTable: false });
    console.error(`running ${title}…`);
  });
}

function summary(title, r) {
  const codes = Object.fromEntries(Object.entries(r.statusCodeStats ?? {}).map(([k, v]) => [k, v.count]));
  return {
    scenario: title,
    seconds,
    connections: r.connections,
    requests: r.requests.total,
    req_per_sec_avg: Math.round(r.requests.average),
    latency_ms: { p50: r.latency.p50, p90: r.latency.p90, p99: r.latency.p99, max: r.latency.max },
    status_codes: codes,
    errors: r.errors,
    timeouts: r.timeouts,
    mb_per_sec: +(r.throughput.average / 1e6).toFixed(1),
  };
}

const crowd = await run("crowd", {
  requests: [
    {
      setupRequest: (req, ctx) => {
        ctx.path = paths[(Math.random() * paths.length) | 0];
        return { ...req, path: ctx.path, headers: { ...req.headers, "cf-connecting-ip": ip(), "accept-encoding": "gzip" } };
      },
      onResponse: (status, _body, ctx) => {
        if (status !== 200) bad[`${ctx.path} ${status}`] = (bad[`${ctx.path} ${status}`] ?? 0) + 1;
      },
    },
  ],
});
const one = await run("one client", {
  connections: 10,
  requests: [{ method: "GET", path: "/api/layers", headers: { "cf-connecting-ip": "203.0.113.50" } }],
});
const out = [summary("crowd (random visitors, page-view mix)", crowd), summary("one client on /api/layers", one)];
if (Object.keys(bad).length) out[0].non_200_by_path = bad;
console.log(JSON.stringify(out, null, 2));
