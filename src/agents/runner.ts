// Agent runner: a provider-neutral tool loop. The model may call tools; every
// call goes through the registry (scopes, entitlement, rate limit, policy
// check, sanitizing, audit). The final answer goes through the output check
// (citations, grounding, blocked content, location redaction) before release.
//
// Per-turn limits: rounds, tool calls, output tokens, and a wall-clock timeout.
import type { Citation } from "./citations";
import type { ExecutorDeps, ToolRegistry } from "./registry";
import type { FunctionToolSpec, InputItem, ModelProvider } from "./providers/types";
import { AgentError, type AuthContext } from "./types";
import { sha256Hex } from "./auth";
import { checkOutput, numbersIn, type OutputIssue } from "../guardrails/output-check";
import { fenceId, fenceToolOutput } from "../guardrails/sanitize";
import type { GuardCategory } from "../guardrails/policy";

export type RunEvent =
  | { type: "tool_call"; name: string; arguments: unknown }
  | { type: "tool_result"; name: string; sources: Citation[]; unknown?: string; planned?: string }
  | { type: "tool_error"; name: string; code: string; message: string }
  | {
      type: "answer";
      text: string;
      citations: Citation[];
      replaced: boolean;
      blocked?: GuardCategory;
      issues?: OutputIssue[];
      general?: boolean;
      limit?: "tool_calls" | "rounds" | "timeout";
    };

export interface TurnLimits {
  /** Model rounds per turn. Default 5. */
  maxRounds: number;
  /** Tool calls per turn across all rounds. Default 6. */
  maxToolCallsPerTurn: number;
  /** Output token cap per model round. Default 800. */
  maxOutputTokens: number;
  /** Wall-clock limit for the whole turn. Default 45 s. */
  turnTimeoutMs: number;
}

export const DEFAULT_TURN_LIMITS: TurnLimits = { maxRounds: 5, maxToolCallsPerTurn: 6, maxOutputTokens: 800, turnTimeoutMs: 45_000 };

export interface RunOptions<D> {
  provider: ModelProvider;
  registry: ToolRegistry<D>;
  deps: ExecutorDeps<D>;
  ctx: AuthContext;
  instructions: string;
  messages: { role: "user" | "assistant"; content: string }[];
  /** Kept for older callers; same as limits.maxRounds. */
  maxRounds?: number;
  limits?: Partial<TurnLimits>;
}

export function toolSpecs<D>(registry: ToolRegistry<D>, ctx: AuthContext): FunctionToolSpec[] {
  return registry.listFor(ctx).map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema }));
}

/** Coordinates present in tool data. The server already applied the location tiers, so these may be shown. */
export function coordsIn(v: unknown, out: [number, number][] = []): [number, number][] {
  if (Array.isArray(v)) {
    if (v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number") out.push([v[0], v[1]]);
    else v.forEach((x) => coordsIn(x, out));
  } else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const lat = o.lat ?? o.latitude;
    const lon = o.lon ?? o.lng ?? o.longitude;
    if (typeof lat === "number" && typeof lon === "number") out.push([lat, lon]);
    Object.values(o).forEach((x) => coordsIn(x, out));
  }
  return out;
}

const DONE_EARLY: Record<NonNullable<Extract<RunEvent, { type: "answer" }>["limit"]>, string> = {
  rounds: "I don't know. I ran out of steps before finding a sourced answer.",
  tool_calls: "I don't know. I reached the limit on lookups for one question before finding a sourced answer.",
  timeout: "I don't know. That took too long to look up, so I stopped. Please try again or ask a narrower question.",
};

export async function* runAgent<D>(o: RunOptions<D>): AsyncGenerator<RunEvent> {
  const limits: TurnLimits = { ...DEFAULT_TURN_LIMITS, ...(o.maxRounds ? { maxRounds: o.maxRounds } : {}), ...o.limits };
  const input: InputItem[] = o.messages.map((m) => ({ type: "message", role: m.role, content: m.content }));
  const allTools = toolSpecs(o.registry, o.ctx);
  const catalog: Citation[] = [];
  const allowedCoords: [number, number][] = [];
  const safetyIdentifier = await sha256Hex(`${o.ctx.tenantId}:${o.ctx.userId}`);
  const deadline = Date.now() + limits.turnTimeoutMs;
  let toolCalls = 0;
  /** Fence id for this turn's tool output. Data can't guess it to fake a closing tag. */
  const fence = fenceId();
  /** Numbers the answer may state: from the question, tool arguments, and tool data. */
  const knownNumbers: number[] = numbersIn(o.messages.filter((m) => m.role === "user").map((m) => m.content));

  const finish = (text: string, limit?: "tool_calls" | "rounds" | "timeout"): RunEvent => {
    const c = checkOutput({ text, catalog, allowedCoords, knownNumbers });
    return { type: "answer", text: c.text, citations: c.citations, replaced: c.replaced, blocked: c.blocked, issues: c.issues, general: c.general, ...(limit ? { limit } : {}) };
  };

  for (let round = 0; round < limits.maxRounds; round++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      yield finish(DONE_EARLY.timeout, "timeout");
      return;
    }
    // Once the tool budget is spent, the model must answer from what it has.
    const tools = toolCalls >= limits.maxToolCallsPerTurn ? [] : allTools;
    let res;
    try {
      res = await o.provider.respond({
        instructions: o.instructions,
        input,
        tools,
        safetyIdentifier,
        maxOutputTokens: limits.maxOutputTokens,
        signal: AbortSignal.timeout(remaining),
      });
    } catch (e) {
      const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
      if (/timeout|abort/i.test(msg)) {
        yield finish(DONE_EARLY.timeout, "timeout");
        return;
      }
      throw e;
    }
    input.push(...res.output);
    if (res.functionCalls.length === 0) {
      yield finish(res.text);
      return;
    }
    // Resolve every call before the next round, as the provider docs require.
    for (const call of res.functionCalls) {
      let args: unknown = {};
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        args = null;
      }
      yield { type: "tool_call", name: call.name, arguments: args };
      let output: unknown;
      try {
        if (toolCalls >= limits.maxToolCallsPerTurn)
          throw new AgentError("rate_limited", "Tool call limit for this question reached. Answer with what you have.", 429);
        toolCalls++;
        if (args === null) throw new AgentError("invalid_input", "arguments were not valid JSON", 400);
        const r = await o.registry.execute(call.name, args, o.ctx, o.deps);
        const labelled: Citation[] = r.sources.map((s) => {
          const c: Citation = { ...s, cite: `S${catalog.length + 1}` };
          catalog.push(c);
          return c;
        });
        coordsIn(r.data, allowedCoords);
        numbersIn([args, r.data, r.unknown ?? "", r.planned ?? ""], knownNumbers);
        yield { type: "tool_result", name: call.name, sources: labelled, unknown: r.unknown, planned: r.planned };
        output = {
          data: r.data,
          unknown: r.unknown,
          planned: r.planned,
          sources: labelled.map((c) => ({ cite: c.cite, id: c.id, kind: c.kind, title: c.title, publisher: c.publisher, observed_at: c.observed_at, received_at: c.received_at })),
        };
      } catch (e) {
        const err = e instanceof AgentError ? e : new AgentError("provider_error", String(e), 500);
        yield { type: "tool_error", name: call.name, code: err.code, message: err.message };
        output = { error: err.code, message: err.message };
      }
      // Data goes to the model inside a fence with this turn's id. Our own
      // error messages are not data and are sent as plain JSON.
      const isError = !!(output as { error?: string }).error;
      input.push({ type: "function_call_output", call_id: call.call_id, output: isError ? JSON.stringify(output) : fenceToolOutput(output, fence) });
    }
  }
  yield finish(DONE_EARLY.rounds, "rounds");
}
