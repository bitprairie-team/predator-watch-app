// Tool registry and executor. Every call, from any channel (web chat, voice,
// MCP), goes through execute(): scope check, entitlement check, rate limit,
// input validation, handler, output validation, audit.
import { excerpt, type AuditLog } from "./audit";
import { classifyInput } from "../guardrails/classifier";
import { refusalText } from "../guardrails/policy";
import { sanitizeData } from "../guardrails/sanitize";
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
  /** Abort a tool handler after this many milliseconds. Default 10000. */
  toolTimeoutMs?: number;
}

/** Every string in a tool input, for the policy check on free-text arguments. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

function shortInput(v: unknown): unknown {
  if (typeof v === "string") return excerpt(v);
  if (Array.isArray(v)) return v.slice(0, 20).map(shortInput);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shortInput(x)]));
  return v;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AgentError("timeout", `The tool took longer than ${ms} ms.`, 504)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
    return this.list().filter((t) => hasScope(ctx, t.scope) && (!ctx.tools || ctx.tools.includes(t.name)));
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
      ...(ctx.keyId ? { key_id: ctx.keyId } : {}),
      tool: name,
      input: shortInput(rawInput ?? {}),
    };
    const fail = async (
      outcome: Exclude<Parameters<AuditLog["record"]>[0]["outcome"], "ok">,
      err: AgentError,
      extra: { category?: string; flags?: string[] } = {},
    ) => {
      await deps.audit.record({ ...base, outcome, error: err.message, duration_ms: Date.now() - started, sources: [], ...extra });
      throw err;
    };

    if (!tool) return fail("error", new AgentError("unknown_tool", `Unknown tool: ${name}`, 404));
    if (!hasScope(ctx, tool.scope)) return fail("denied", new AgentError("forbidden", `Missing scope ${tool.scope}`, 403));
    if (ctx.tools && !ctx.tools.includes(name))
      return fail("denied", new AgentError("forbidden", `This key or agent is not allowed to use ${name}.`, 403));
    if (!(await deps.entitlements.has(ctx, tool.entitlement)))
      return fail("not_entitled", new AgentError("not_entitled", "This needs the private rancher plan.", 402));
    if (!(await deps.rateLimiter.hit(`tool:${ctx.tenantId}`, deps.limits.toolCallsPerMinute, 60, now().getTime())))
      return fail("rate_limited", new AgentError("rate_limited", "Too many requests. Try again in a minute.", 429));
    if (ctx.keyId && ctx.callsPerDay !== undefined && !(await deps.rateLimiter.hit(`keyday:${ctx.keyId}`, ctx.callsPerDay, 86_400, now().getTime())))
      return fail("rate_limited", new AgentError("rate_limited", "This key has used its tool calls for today.", 429));

    const input = withDefaults(tool.inputSchema, rawInput);
    const inErrors = validate(tool.inputSchema, input);
    if (inErrors.length) return fail("invalid_input", new AgentError("invalid_input", inErrors.join("; "), 400));

    // Same scope policy as chat, applied to free-text arguments. This covers
    // MCP clients and voice, which call tools directly.
    for (const text of strings(input)) {
      const d = classifyInput(text);
      if (d.action === "decline" && d.category)
        return fail("refused", new AgentError("policy_declined", refusalText(d.category), 422), { category: d.category, flags: [`rule:${d.rule}`] });
    }

    let result: ToolResult;
    try {
      result = await withTimeout(Promise.resolve(tool.handler(input, deps.data(ctx), ctx)), deps.toolTimeoutMs ?? 10_000);
    } catch (e) {
      if (e instanceof AgentError && e.code === "timeout") return fail("timeout", e);
      return fail("error", new AgentError("provider_error", e instanceof Error ? e.message : String(e), 500));
    }
    // Tool output is data. Strip instruction-like text before any model sees it.
    const clean = sanitizeData(result);
    result = clean.value;
    const outErrors = validate(this.resultSchema(tool), result);
    if (outErrors.length) return fail("error", new AgentError("invalid_output", outErrors.join("; "), 500));

    await deps.audit.record({
      ...base,
      input: shortInput(input),
      outcome: "ok",
      ...(clean.flagged ? { flags: [`sanitized:${clean.flagged}`] } : {}),
      duration_ms: Date.now() - started,
      sources: result.sources.map(({ id, kind, title, url, observed_at, received_at }) => ({ id, kind, title, url, observed_at, received_at })),
    });
    return result;
  }
}
