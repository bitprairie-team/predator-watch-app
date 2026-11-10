import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const wrangler = readFileSync("wrangler.jsonc", "utf8");
const headers = readFileSync("public/_headers", "utf8");
const security = readFileSync("SECURITY.md", "utf8");
const workflow = readFileSync(".github/workflows/test.yml", "utf8");

describe("security config", () => {
  it("pins the map Worker closed, redacts query strings and keeps the cache binding", () => {
    expect(wrangler).toMatch(/"name": "predator-watch-map"/);
    expect(wrangler).toMatch(/"id": "a923d084b1f4495e833c453b16e4275e"/);
    expect(wrangler).toMatch(/"workers_dev": false/);
    expect(wrangler).toMatch(/"preview_urls": false/);
    expect(wrangler).toMatch(/"redact_query_string": true/);
  });

  it("sets a one-year HSTS to match Cloudflare", () => {
    expect(headers).toMatch(/Strict-Transport-Security: max-age=31536000; includeSubDomains/);
    expect(headers).not.toMatch(/63072000/);
  });

  it("points security contact at the org repo and hello@predatorwatch.org", () => {
    expect(security).toContain("https://github.com/bitprairie-team/predator-watch-app/security/advisories/new");
    expect(security).toContain("hello@predatorwatch.org");
    expect(security).not.toMatch(/steelhead99x/);
  });

  it("runs tests on pull_request and push to main, never pull_request_target", () => {
    expect(workflow).toMatch(/npm ci/);
    expect(workflow).toMatch(/npm test/);
    expect(workflow).toMatch(/pull_request:/);
    expect(workflow).toMatch(/branches: \[main\]/);
    expect(workflow).toMatch(/contents: read/);
    expect(workflow).not.toMatch(/pull_request_target/);
  });
});
