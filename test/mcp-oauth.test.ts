import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { KEYS, seededStore } from "./rancher-fixtures";
import { memoryKV } from "./helpers";
import type { MemoryStore } from "../src/agents/store";

/** KV namespace backed by a MemoryStore, with list() and TTL options accepted. */
function kvFrom(store: MemoryStore): KVNamespace {
  return {
    async get(key: string, opt?: string | { type?: string }) {
      const v = store.map.get(key);
      if (v === undefined) return null;
      const type = typeof opt === "string" ? opt : opt?.type;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      store.map.set(key, value);
    },
    async delete(key: string) {
      store.map.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      const keys = [...store.map.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  } as unknown as KVNamespace;
}

const execCtx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

async function env() {
  const priv = await seededStore();
  const oauth = new (priv.constructor as new () => MemoryStore)();
  return { LAYER_CACHE: memoryKV(), PRIVATE_KV: kvFrom(priv), OAUTH_KV: kvFrom(oauth) };
}

describe("MCP over OAuth", () => {
  it("publishes protected resource metadata for /mcp", async () => {
    const res = await worker.fetch(new Request("https://app.example.test/.well-known/oauth-protected-resource/mcp"), (await env()) as never, execCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; scopes_supported?: string[] };
    expect(body.resource).toBe("https://app.example.test/mcp");
  });

  it("challenges an unauthenticated MCP request", async () => {
    const res = await worker.fetch(new Request("https://app.example.test/mcp", { method: "POST", body: "{}" }), (await env()) as never, execCtx);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  it("accepts a rancher access key as a bearer token and lists tools", async () => {
    const res = await worker.fetch(
      new Request("https://app.example.test/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${KEYS.a}`, "content-type": "application/json", accept: "application/json, text/event-stream", host: "app.example.test" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      (await env()) as never,
      execCtx,
    );
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const msg = JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
    expect(msg.result.tools).toHaveLength(8);
  });

  it("serves the sign-in page only for a valid authorization request", async () => {
    const res = await worker.fetch(new Request("https://app.example.test/authorize?client_id=nope"), (await env()) as never, execCtx);
    expect(res.status).toBe(400);
  });

  it("completes the authorization code flow with PKCE and the token reaches tenant A's tools", async () => {
    const e = await env();
    const base = "https://app.example.test";
    const f = (path: string, init: RequestInit = {}) => worker.fetch(new Request(base + path, init), e as never, execCtx);
    const reg = await f("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://localhost:3333/cb"], token_endpoint_auth_method: "none", client_name: "Test client" }),
    });
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };
    const verifier = "v".repeat(64);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "http://localhost:3333/cb", scope: "rancher:read", state: "xyz", code_challenge: challenge, code_challenge_method: "S256" });
    const page = await f(`/authorize?${q}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Test client");
    expect(html).toContain("read-only");
    const handle = html.match(/name="handle" value="([^"]+)"/)![1]!;
    const cookie = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

    const bad = await f("/authorize", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ handle, access_key: KEYS.pub, action: "approve" }) });
    expect(bad.status).toBe(401);

    const ok = await f("/authorize", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ handle, access_key: KEYS.a, action: "approve" }) });
    expect(ok.status).toBe(302);
    const loc = new URL(ok.headers.get("location")!);
    expect(loc.searchParams.get("state")).toBe("xyz");
    const code = loc.searchParams.get("code")!;

    const tok = await f("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "http://localhost:3333/cb", client_id, code_verifier: verifier }),
    });
    expect(tok.status).toBe(200);
    const { access_token, scope } = (await tok.json()) as { access_token: string; scope: string };
    expect(scope).toBe("rancher:read");

    const res = await f("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream", host: "app.example.test" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agency_contacts_and_reporting", arguments: {} } }),
    });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const msg = JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
    expect(msg.result.structuredContent.data.contacts[0].name).toBe("Pat Example");
  });

  it("leaves the public map untouched when OAuth is configured", async () => {
    const res = await worker.fetch(new Request("https://app.example.test/api/health"), (await env()) as never, execCtx);
    expect(res.status).toBe(200);
  });
});

describe("OAuth scope narrowing", () => {
  it("never grants a token more than the access key that approved it", async () => {
    const { narrowScopes } = await import("../src/mcp/oauth");
    expect(narrowScopes(["rancher:read"], ["rancher:read"])).toEqual(["rancher:read"]);
    expect(narrowScopes(["rancher:read"], ["alerts:read"])).toEqual(["alerts:read"]);
    expect(narrowScopes(["activity:read"], ["alerts:read"])).toEqual([]);
    expect(narrowScopes(["rancher:read"], undefined)).toEqual(["rancher:read"]);
  });
});
