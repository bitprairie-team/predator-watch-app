// The public map must never expose the assistant. This branch carries the
// private rancher plan, so these checks make sure it stays behind its own
// routes and bindings: public routes say nothing about it, the public map
// script never calls it, and the public modules never import it.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";
import { memoryKV } from "./helpers";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE_WORDS = /assistant|grok|xai|\bmcp\b|access key|outbox|agents?:run/i;

describe("public routes never expose the assistant", () => {
  const env = { LAYER_CACHE: memoryKV() };
  it.each(["/api/layers", "/api/health", "/api/sources/nope", "/api/nope"])("%s says nothing about it", async (path) => {
    const res = await handleRequest(new Request(`http://x${path}`), env as never, ctx);
    expect(await res.text()).not.toMatch(PRIVATE_WORDS);
  });
  it.each(["/api/assistant/me", "/api/assistant/agents", "/api/assistant/outbox", "/mcp"])("%s is off (503) without the private store", async (path) => {
    const res = await handleRequest(new Request(`http://x${path}`, { method: path === "/mcp" ? "POST" : "GET" }), env as never, ctx);
    expect(res.status).toBe(503);
  });
  it("the public map script never calls the assistant", () => {
    const app = readFileSync(join(ROOT, "public/app.js"), "utf8");
    expect(app).not.toMatch(/\/api\/assistant|\/mcp\b|rancher\.js|xai|grok/i);
  });
  it("public modules never import private code", () => {
    const publicRoots = ["src/cache.ts", "src/registry.ts", "src/schema.ts", ...["src/adapters", "src/lib", "src/config"].flatMap((d) => readdirSync(join(ROOT, d)).map((f) => `${d}/${f}`))];
    const seen = new Set<string>();
    const walk = (rel: string) => {
      if (seen.has(rel)) return;
      seen.add(rel);
      const src = readFileSync(join(ROOT, rel), "utf8");
      for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
        const target = join(dirname(rel), m[1]!).replace(/\\/g, "/");
        expect(target, `${rel} imports ${m[1]}`).not.toMatch(/^src\/(agents|rancher|mcp|guardrails)\//);
        if (!/\.json$/.test(target)) walk(target.endsWith(".ts") ? target : `${target}.ts`);
      }
    };
    publicRoots.filter((f) => f.endsWith(".ts")).forEach(walk);
    expect(seen.size).toBeGreaterThan(5);
  });
});
