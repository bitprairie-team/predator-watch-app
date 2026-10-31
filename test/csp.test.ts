import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { RASTER_LAYERS } from "../src/config/sources";
import { PLANNED_SOURCES } from "../src/config/planned";

const headers: string = readFileSync("public/_headers", "utf8").toString();
const csp: string = headers.match(/Content-Security-Policy: (.*)/)?.[1] ?? "";
const directive = (name: string): string[] =>
  (csp.split(";").map((d: string) => d.trim()).find((d: string) => d.startsWith(name + " ")) ?? "").split(/\s+/).slice(1);

describe("static security headers", () => {
  it("sets HSTS, nosniff, referrer and permissions policies", () => {
    expect(headers).toMatch(/Strict-Transport-Security: max-age=\d+/);
    expect(headers).toMatch(/X-Content-Type-Options: nosniff/);
    expect(headers).toMatch(/Referrer-Policy: strict-origin-when-cross-origin/);
    expect(headers).toMatch(/Permissions-Policy: geolocation=\(self\)/);
  });

  it("allows every context tile host in img-src and connect-src, and nothing unexpected", () => {
    const hosts = new Set(["https://tiles.openfreemap.org"]);
    for (const r of RASTER_LAYERS) for (const t of r.tiles) hosts.add(new URL(t.replace(/\{[^}]+\}/g, "0")).origin);
    for (const h of hosts) {
      expect(directive("img-src")).toContain(h);
      expect(directive("connect-src")).toContain(h);
    }
    const extra = directive("connect-src").filter((h) => h.startsWith("https://") && !hosts.has(h));
    expect(extra).toEqual([]);
    expect(directive("script-src")).toEqual(["'self'"]);
    expect(directive("frame-ancestors")).toEqual(["'none'"]);
  });
});

describe("planned sources", () => {
  it("each has an https URL and a reason", () => {
    for (const p of PLANNED_SOURCES) {
      expect(p.url).toMatch(/^https:\/\//);
      expect(p.reason.length).toBeGreaterThan(20);
    }
  });
});
