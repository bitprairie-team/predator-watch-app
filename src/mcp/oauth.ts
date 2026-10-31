// OAuth for MCP clients, using @cloudflare/workers-oauth-provider. The
// provider serves discovery, dynamic client registration, and the token
// endpoint; this file serves the sign-in and consent page at /authorize.
// Rancher access keys are also accepted directly as bearer tokens on /mcp for
// clients that can set a header.
import { OAuthProvider, type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { contextFromAccessKey } from "../agents/auth";
import type { AuthContext } from "../agents/types";
import { rancherService, type PrivateEnv } from "../rancher/service";
import { handleMcp, MCP_ROUTE, scopesFrom } from "./server";

export const DEFAULT_SCOPES = ["rancher:read"];
export const OAUTH_PATHS = [MCP_ROUTE, "/authorize", "/oauth/token", "/oauth/register", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"];

export function isOAuthPath(pathname: string): boolean {
  return OAUTH_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

interface Props {
  tenantId: string;
  userId: string;
  /** Set when the bearer was a rancher access key rather than an OAuth token. */
  accessKeyScopes?: string[];
}

type Env = PrivateEnv & { OAUTH_PROVIDER?: OAuthHelpers };

async function contextFromProps(env: Env, props: Props, scope: string[], client: string): Promise<AuthContext | null> {
  const svc = rancherService(env);
  if (!svc || !props?.tenantId) return null;
  const tenant = await svc.store.get<{ plan?: "public" | "rancher" }>(`tenant:${props.tenantId}`);
  if (!tenant) return null;
  return { tenantId: props.tenantId, userId: props.userId, plan: tenant.plan ?? "public", scopes: scopesFrom(scope), client };
}

const apiHandler = {
  async fetch(request: Request, env: Env, execCtx: ExecutionContext) {
    const ctx = execCtx as ExecutionContext & { props?: Props; auth?: { scope: string[]; clientId?: string } };
    const svc = rancherService(env);
    if (!svc) return new Response("Not configured", { status: 503 });
    const props = ctx.props as Props;
    const scope = props?.accessKeyScopes ?? ctx.auth?.scope ?? [];
    const auth = await contextFromProps(env, props, scope, `mcp:${props?.accessKeyScopes ? "access-key" : (ctx.auth?.clientId ?? "oauth")}`);
    if (!auth) return new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401, headers: { "content-type": "application/json" } });
    return handleMcp(request, svc, auth);
  },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(body: string, headers?: Headers, status = 200): Response {
  const h = new Headers(headers);
  h.set("content-type", "text/html; charset=utf-8");
  h.set("cache-control", "no-store");
  h.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to Predator Watch</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1d2a22}h1{font-size:1.4rem}label{display:block;margin:1rem 0 .3rem;font-weight:600}input{width:100%;padding:.5rem;font:inherit;box-sizing:border-box}.row{display:flex;gap:.5rem;margin-top:1rem}button{padding:.5rem 1rem;font:inherit}.note{color:#555;font-size:.9rem}.err{color:#a00}</style></head><body>${body}</body></html>`,
    { status, headers: h },
  );
}

async function consentPage(helpers: OAuthHelpers, authReq: AuthRequest, handle: string, headers: Headers | undefined, error?: string) {
  const d = await helpers.describeConsent(authReq);
  const host = (d as { redirectHost?: string }).redirectHost ?? new URL(authReq.redirectUri).host;
  const loop = (d as { redirectIsLoopback?: boolean }).redirectIsLoopback;
  return page(
    `<h1>Connect an app to your rancher account</h1>
<p><strong>${esc(d.clientName)}</strong>${d.clientDomain ? ` (${esc(d.clientDomain)})` : ""} wants read-only access to your Predator Watch rancher tools.</p>
<p class="note">Access is sent to <strong>${esc(host)}</strong>${loop ? ", an app on this computer" : ""}. It can read activity near your ranches, alerts, your contacts, and documents. It cannot change anything. Every call is recorded in your audit log.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${esc(handle)}">
<label for="k">Rancher access key</label>
<input id="k" name="access_key" type="password" autocomplete="off" required>
<div class="row"><button name="action" value="approve" type="submit">Allow read-only access</button><button name="action" value="deny" type="submit" formnovalidate>Cancel</button></div>
</form>`,
    headers,
  );
}

async function authorize(request: Request, env: Env): Promise<Response> {
  const helpers = env.OAUTH_PROVIDER;
  const svc = rancherService(env);
  if (!helpers || !svc) return page("<h1>Not available</h1><p>Rancher sign-in is not set up on this server.</p>", undefined, 503);
  try {
    if (request.method === "GET") {
      const authReq = await helpers.parseAuthRequest(request);
      const tx = await helpers.beginConsent(authReq);
      return consentPage(helpers, authReq, tx.handle, tx.headers);
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const form = await request.clone().formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("action") === "deny") {
      const denied = await helpers.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const key = String(form.get("access_key") ?? "").trim();
    const ctx = await contextFromAccessKey(svc.store, key, "oauth");
    if (!ctx || !(await svc.entitlements.has(ctx, "rancher_assistant"))) {
      return page(
        `<h1>That key didn't work</h1><p>Check your rancher access key and that your rancher plan is active, then start the connection again from your app.</p>`,
        undefined,
        401,
      );
    }
    const approved = await helpers.approveConsent(request, handle, { scope: DEFAULT_SCOPES });
    const { redirectTo } = await helpers.completeAuthorization({
      request: approved.request,
      userId: encodeURIComponent(`${ctx.tenantId}:${ctx.userId}`),
      metadata: { tenant_id: ctx.tenantId, granted_at: new Date().toISOString() },
      scope: DEFAULT_SCOPES,
      props: { tenantId: ctx.tenantId, userId: ctx.userId } satisfies Props,
    });
    const h = new Headers(approved.headers);
    h.set("location", redirectTo);
    return new Response(null, { status: 302, headers: h });
  } catch (e) {
    console.error("authorize error", e);
    return page(`<h1>Sign-in could not continue</h1><p>Start the connection again from your app.</p>`, undefined, 400);
  }
}

const providers = new Map<string, OAuthProvider<Env>>();

/** The OAuth-wrapped handler for one origin. Built lazily; cached per origin. */
export function oauthProvider(origin: string, fallback: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>) {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: MCP_ROUTE,
      apiHandler,
      defaultHandler: {
        async fetch(request: Request, env: Env, ctx: ExecutionContext) {
          const url = new URL(request.url);
          if (url.pathname === "/authorize") return authorize(request, env);
          return fallback(request, env, ctx);
        },
      },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      scopesSupported: DEFAULT_SCOPES,
      requiredScopes: DEFAULT_SCOPES,
      resourceMetadata: { resource: `${origin}${MCP_ROUTE}` },
      accessTokenTTL: 3600,
      async resolveExternalToken({ token, env }) {
        const svc = rancherService(env);
        if (!svc || !token.startsWith("pwk_")) return null;
        const ctx = await contextFromAccessKey(svc.store, token, "mcp:access-key");
        if (!ctx) return null;
        return { props: { tenantId: ctx.tenantId, userId: ctx.userId, accessKeyScopes: ctx.scopes } satisfies Props, audience: `${origin}${MCP_ROUTE}` };
      },
    });
    providers.set(origin, p);
  }
  return p;
}
