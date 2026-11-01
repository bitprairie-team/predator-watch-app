import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { handleRequest } from "../src/index";
import { memoryKV } from "./helpers";

// The rancher assistant lives only on the feat/rancher-agents branch. The
// public map must ship no assistant, agent, model or chat code, UI or route.
function files(dir: string, exts: RegExp): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "vendor" || n === "data" || n === "private" ? [] : files(p, exts);
    return exts.test(n) ? [p] : [];
  });
}
const BANNED = /\b(assistant|chatbot|llm|openai|anthropic|xai_api_key|grok-|gpt-\d|workers-ai|@cloudflare\/ai|mcp|oauth|prompt\.ts|model_provider)\b/i;

describe("no assistant features in the public build", () => {
  it("has no assistant, model or chat code in src or public", () => {
    for (const f of [...files("src", /\.ts$/), ...files("public", /\.(js|html|css|webmanifest|json)$/)]) {
      const text = readFileSync(f, "utf8");
      const m = text.match(BANNED);
      expect(m?.[0], f).toBeUndefined();
    }
    expect(existsSync("src/rancher")).toBe(false);
    expect(existsSync("docs/rancher-assistant.md")).toBe(false);
  });

  it("has no AI binding, model secrets or assistant routes in wrangler config", () => {
    const w = readFileSync("wrangler.jsonc", "utf8");
    expect(w).not.toMatch(/"ai"\s*:|PRIVATE_KV|OAUTH_KV|XAI_|\/mcp|\/oauth|\/authorize/i);
    expect(w).toMatch(/"run_worker_first": \["\/api\/\*", "\/ogc", "\/ogc\/\*"\]/);
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(" ");
    expect(deps).not.toMatch(/openai|anthropic|@ai-sdk|\bai\b|agents|workers-oauth|modelcontextprotocol/i);
  });

  it("answers 404 for assistant-style routes", async () => {
    const env = { LAYER_CACHE: memoryKV() };
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
    for (const p of ["/api/assistant", "/api/chat", "/api/agent", "/api/rancher/ask", "/api/voice"]) {
      const res = await handleRequest(new Request(`https://example.org${p}`), env, ctx);
      expect(res.status, p).toBe(404);
    }
  });
});
