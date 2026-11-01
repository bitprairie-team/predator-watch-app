// Per-key permissions: tool allowlist, expiry, daily caps, key id in audit,
// and OAuth grants that end when their key is revoked.
import { describe, expect, it } from "vitest";
import { sha256Hex, type AccessKeyRecord } from "../src/agents/auth";
import type { MemoryStore } from "../src/agents/store";
import { handleRequest } from "../src/index";
import { contextFromProps } from "../src/mcp/oauth";
import { daysAgo, NOW, seededStore, testService } from "./rancher-fixtures";

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const KEY = "pwk_scopedKeyForTests_ssssssssssss";

async function withKey(rec: Partial<AccessKeyRecord>) {
  const store = await seededStore();
  await store.put(`accesskey:${await sha256Hex(KEY)}`, { tenant_id: "tenant-a", user_id: "user-k", scopes: ["rancher:read"], created_at: daysAgo(1), ...rec });
  return store;
}
async function call(store: MemoryStore, path: string, init: RequestInit = {}) {
  const t = await testService({ store });
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${KEY}`);
  headers.set("host", "localhost");
  return { res: await handleRequest(new Request(`http://localhost${path}`, { ...init, headers }), t.env as never, execCtx, t.overrides), svc: t.svc };
}
const rpc = (id: number, method: string, params: unknown = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
async function mcp(store: MemoryStore, body: string) {
  const r = await call(store, "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body });
  const text = await r.res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return { status: r.res.status, msg: line ? JSON.parse(line.slice(6)) : text ? JSON.parse(text) : null, svc: r.svc };
}

describe("access keys: tool allowlist", () => {
  it("MCP lists only the allowed tools", async () => {
    const store = await withKey({ tools: ["weekly_summary", "data_freshness"] });
    const r = await mcp(store, rpc(1, "tools/list"));
    expect(r.msg.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["data_freshness", "weekly_summary"]);
  });
  it("calling a tool outside the list is denied and audited", async () => {
    const store = await withKey({ tools: ["weekly_summary"] });
    const r = await call(store, "/api/assistant/tools/agency_contacts_and_reporting", { method: "POST", body: JSON.stringify({ arguments: {} }) });
    expect(r.res.status).toBe(403);
    const audit = await r.svc.audit.list({ tenantId: "tenant-a", userId: "x", plan: "rancher", scopes: [], client: "t" }, 5);
    expect(audit[0]).toMatchObject({ outcome: "denied", tool: "agency_contacts_and_reporting", key_id: (await sha256Hex(KEY)).slice(0, 12) });
  });
  it("an empty list allows nothing", async () => {
    const store = await withKey({ tools: [] });
    const r = await mcp(store, rpc(1, "tools/list"));
    // With no tools the server offers no tools capability at all.
    expect(r.msg.result?.tools ?? []).toEqual([]);
  });
});

describe("access keys: expiry and caps", () => {
  it("an expired key is refused", async () => {
    const store = await withKey({ expires_at: daysAgo(0.01) });
    expect((await call(store, "/api/assistant/me")).res.status).toBe(401);
    expect((await mcp(store, rpc(1, "tools/list"))).status).toBe(401);
  });
  it("a key that has not expired works", async () => {
    const store = await withKey({ expires_at: new Date(NOW.getTime() + 86400_000).toISOString() });
    expect((await call(store, "/api/assistant/me")).res.status).toBe(200);
  });
  it("a garbled expiry is treated as expired", async () => {
    const store = await withKey({ expires_at: "soon" });
    expect((await call(store, "/api/assistant/me")).res.status).toBe(401);
  });
  it("the daily cap stops tool calls", async () => {
    const store = await withKey({ calls_per_day: 2 });
    const go = () => call(store, "/api/assistant/tools/data_freshness", { method: "POST", body: JSON.stringify({ arguments: {} }) });
    expect((await go()).res.status).toBe(200);
    expect((await go()).res.status).toBe(200);
    const third = await go();
    expect(third.res.status).toBe(429);
    expect(((await third.res.json()) as { message: string }).message).toMatch(/used its tool calls for today/);
  });
  it("every tool call records the key id", async () => {
    const store = await withKey({});
    const r = await call(store, "/api/assistant/tools/data_freshness", { method: "POST", body: JSON.stringify({ arguments: {} }) });
    expect(r.res.status).toBe(200);
    const audit = await r.svc.audit.list({ tenantId: "tenant-a", userId: "x", plan: "rancher", scopes: [], client: "t" }, 1);
    expect(audit[0]!.key_id).toBe((await sha256Hex(KEY)).slice(0, 12));
  });
});

describe("access keys: OAuth grants follow the key", () => {
  const env = (store: MemoryStore) => ({ LAYER_CACHE: {} as KVNamespace, PRIVATE_KV: kvFrom(store) });
  it("a grant carries the key's tool list", async () => {
    const store = await withKey({ tools: ["weekly_summary"] });
    const ctx = await contextFromProps(env(store) as never, { tenantId: "tenant-a", userId: "user-k", keyScopes: ["rancher:read"], keyHash: await sha256Hex(KEY) }, ["rancher:read"], "mcp:oauth");
    expect(ctx?.tools).toEqual(["weekly_summary"]);
  });
  it("revoking the key ends the grant", async () => {
    const store = await withKey({ revoked: true });
    const ctx = await contextFromProps(env(store) as never, { tenantId: "tenant-a", userId: "user-k", keyHash: await sha256Hex(KEY) }, ["rancher:read"], "mcp:oauth");
    expect(ctx).toBeNull();
  });
  it("a grant can't be pointed at another tenant", async () => {
    const store = await withKey({});
    const ctx = await contextFromProps(env(store) as never, { tenantId: "tenant-b", userId: "user-k", keyHash: await sha256Hex(KEY) }, ["rancher:read"], "mcp:oauth");
    expect(ctx).toBeNull();
  });
});

/** Minimal KVNamespace over a MemoryStore, for code that builds its own service from env. */
function kvFrom(store: MemoryStore): KVNamespace {
  return {
    async get(key: string, type?: string) {
      const v = store.map.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) { store.map.set(key, value); },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return { keys: [...store.map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true, cursor: "" };
    },
  } as unknown as KVNamespace;
}
