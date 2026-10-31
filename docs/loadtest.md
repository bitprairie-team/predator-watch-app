# Load test

`scripts/loadtest.mjs` uses [autocannon](https://github.com/mcollina/autocannon)
against a running Worker:

```sh
npx wrangler dev &                                   # http://127.0.0.1:8787
curl http://127.0.0.1:8787/cdn-cgi/local/scheduled   # fill KV once
npm run loadtest -- http://127.0.0.1:8787 30 50      # base URL, seconds, connections
```

Two scenarios run back to back:

1. **Crowd**: 50 connections, each request from a random client address,
   spread over one page view's worth of URLs (page, `app.js`, `styles.css`,
   `/api/layers`, `/api/status`, a place-search shard, and every GeoJSON
   layer, including the 2.4 MB weather alerts layer).
2. **One client**: 10 connections from one address on `/api/layers`.

## Results, 2026-10-31

`wrangler dev` (local workerd, one process) on an 8-core Linux box, after one
cron run. Local numbers measure the Worker code path, not Cloudflare's edge,
where cached responses are served by the cache before the Worker runs.

| Scenario | Requests | Req/s | p50 | p90 | p99 | Status codes | Errors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Crowd, 30 s, 50 conns | 3,460 | 115 | 287 ms | 881 ms | 1,695 ms | 200 × 3,460 | 0 |
| One client, 30 s, 10 conns | 16,565 | 552 | 13 ms | 24 ms | 98 ms | 200 × 600, 429 × 15,965 | 0 |

- No request reached an agency server during the run. Public requests read
  KV and the edge cache only; the cron is the only code that calls agencies
  (covered by `test/spike.test.ts`).
- The crowd scenario moved about 4.7 MB/s, mostly GeoJSON; latency there is
  dominated by compressing large layers in the single local process.
- The single client got exactly 600 answers in its first minute, then 429
  with `Retry-After: 60`.
