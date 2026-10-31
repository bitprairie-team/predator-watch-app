// MCP server (Streamable HTTP) exposing the same tool registry as the web
// assistant. Each request builds a stateless server bound to the caller's
// AuthContext, so every MCP tool call goes through the same scope check,
// entitlement gate, rate limit, location tiers, and audit log.
import { createMcpHandler } from "agents/mcp/server";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import type { RancherService } from "../rancher/service";
import { AgentError, READ_SCOPES, type AuthContext, type Scope } from "../agents/types";
import { MCP_INSTRUCTIONS } from "../rancher/prompt";
import { DATA_NOTICE } from "../guardrails/sanitize";

export const MCP_ROUTE = "/mcp";
export const MCP_SERVER_INFO = { name: "predator-watch-rancher", version: "0.1.0" };
const KNOWN_SCOPES = new Set<Scope>(["rancher:read", ...READ_SCOPES]);

export function scopesFrom(granted: string[]): Scope[] {
  return granted.filter((s): s is Scope => KNOWN_SCOPES.has(s as Scope));
}

export function buildMcpServer(svc: RancherService, ctx: AuthContext): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    instructions: `${MCP_INSTRUCTIONS} If a result sets \`unknown\`, tell the user you don't know rather than guessing.`,
  });
  for (const tool of svc.registry.listFor(ctx)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema as never),
        outputSchema: fromJsonSchema(svc.registry.resultSchema(tool) as never),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await svc.registry.execute(tool.name, args ?? {}, ctx, svc.deps);
          return {
            // Same tiers, sanitizing, and policy check as the web assistant (all in registry.execute).
            content: [
              { type: "text" as const, text: JSON.stringify(result) },
              { type: "text" as const, text: DATA_NOTICE },
            ],
            structuredContent: result as unknown as Record<string, unknown>,
          };
        } catch (e) {
          const err = e instanceof AgentError ? e : new AgentError("provider_error", "Tool failed.", 500);
          return { isError: true, content: [{ type: "text" as const, text: `${err.code}: ${err.message}` }] };
        }
      },
    );
  }
  return server;
}

/** Serve one MCP request for an already-authenticated caller. */
export async function handleMcp(request: Request, svc: RancherService, ctx: AuthContext): Promise<Response> {
  if (!(await svc.entitlements.has(ctx, "rancher_assistant"))) {
    return new Response(JSON.stringify({ error: "not_entitled", message: "MCP access needs the private rancher plan." }), {
      status: 402,
      headers: { "content-type": "application/json" },
    });
  }
  const handler = createMcpHandler(() => buildMcpServer(svc, ctx), { route: MCP_ROUTE, corsOptions: false });
  return handler.fetch(request);
}
