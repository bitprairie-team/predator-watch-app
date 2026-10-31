// Tool registry and executor. Every call, from any channel (web chat, voice,
// MCP), goes through execute(): scope check, entitlement check, rate limit,
// input validation, handler, output validation, audit.
import type { AuditLog } from "./audit";
import { hasScope } from "./auth";
import type { Entitlements } from "./entitlements";
import { validate, withDefaults, SOURCE_REF_SCHEMA } from "./json-schema";
import type { RateLimiter, RateLimitPolicy } from "./rate-limit";
import { AgentError, type AuthContext, type ToolDefinition, type ToolResult } from "./types";

export interface ExecutorDeps<D> {
  audit: AuditLog;
  entitlements: Entitlements;
  rateLimiter: RateLimiter;
  limits: RateLimitPolicy;
  /** Tenant-scoped data access, built for this call's AuthContext. */
  data: (ctx: AuthContext) => D;
  now?: () => Date;
}

const RESULT_SCHEMA_BASE = {
  sources: { type: "array" as const, items: SOURCE_REF_SCHEMA },
  unknown: { type: "string" as const },
  planned: { type: "string" as const },
};

export class ToolRegistry<D> {
  private readonly tools = new Map<string, ToolDefinition<any, any, D>>();

  register(tool: ToolDefinition<any, any, D>): this {
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(tool.name)) throw new Error(`Invalid tool name: ${tool.name}`);
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    if (tool.inputSchema.type !== "object") throw new Error(`${tool.name}: input schema root must be an object`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string) {
    return this.tools.get(name);
  }

  list(): ToolDefinition<any, any, D>[] {
    return [...this.tools.values()];
  }

  /** Tools this caller may use (scope only; entitlement is checked per call). */
  listFor(ctx: AuthContext) {
    return this.list().filter((t) => hasScope(ctx, t.scope));
  }

  /** Full JSON Schema of a tool's result envelope. */
  resultSchema(tool: Pick<ToolDefinition, "outputSchema">) {
    return {
      type: "object" as const,
      required: ["data", "sources"],
      properties: { data: tool.outputSchema, ...RESULT_SCHEMA_BASE },
    };
  }

  async execute(name: string, rawInput: unknown, ctx: AuthContext, deps: ExecutorDeps<D>): Promise<ToolResult> {
    const now = deps.now ?? (() => new Date());
    const started = Date.now();
    const tool = this.tools.get(name);
    const base = {
      id: crypto.randomUUID(),
      at: now().toISOString(),
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      client: ctx.client,
      tool: name,
      input: rawInput ?? {},
    };
    const fail = async (outcome: Exclude<Parameters<AuditLog["record"]>[0]["outcome"], "ok">, err: AgentError) => {
      await deps.audit.record({ ...base, outcome, error: err.message, duration_ms: Date.now() - started, sources: [] });
      throw err;
    };

    if (!tool) return fail("error", new AgentError("unknown_tool", `Unknown tool: ${name}`, 404));
    if (!hasScope(ctx, tool.scope)) return fail("denied", new AgentError("forbidden", `Missing scope ${tool.scope}`, 403));
    if (!(await deps.entitlements.has(ctx, tool.entitlement)))
      return fail("not_entitled", new AgentError("not_entitled", "This needs the private rancher plan.", 402));
    if (!(await deps.rateLimiter.hit(`tool:${ctx.tenantId}`, deps.limits.toolCallsPerMinute, 60, now().getTime())))
      return fail("rate_limited", new AgentError("rate_limited", "Too many requests. Try again in a minute.", 429));

    const input = withDefaults(tool.inputSchema, rawInput);
    const inErrors = validate(tool.inputSchema, input);
    if (inErrors.length) return fail("invalid_input", new AgentError("invalid_input", inErrors.join("; "), 400));

    let result: ToolResult;
    try {
      result = await tool.handler(input, deps.data(ctx), ctx);
    } catch (e) {
      return fail("error", new AgentError("provider_error", e instanceof Error ? e.message : String(e), 500));
    }
    const outErrors = validate(this.resultSchema(tool), result);
    if (outErrors.length) return fail("error", new AgentError("invalid_output", outErrors.join("; "), 500));

    await deps.audit.record({
      ...base,
      input,
      outcome: "ok",
      duration_ms: Date.now() - started,
      sources: result.sources.map(({ id, kind, title, url, observed_at, received_at }) => ({ id, kind, title, url, observed_at, received_at })),
    });
    return result;
  }
}
