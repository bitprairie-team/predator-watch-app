// Agent runner: a provider-neutral tool loop. The model may call tools; every
// call goes through the registry (scopes, entitlement, rate limit, audit). The
// final answer is checked against the citations rule before it is released.
import { enforceCitations, type Citation } from "./citations";
import type { ExecutorDeps, ToolRegistry } from "./registry";
import type { FunctionToolSpec, InputItem, ModelProvider } from "./providers/types";
import { AgentError, type AuthContext } from "./types";
import { sha256Hex } from "./auth";

export type RunEvent =
  | { type: "tool_call"; name: string; arguments: unknown }
  | { type: "tool_result"; name: string; sources: Citation[]; unknown?: string; planned?: string }
  | { type: "tool_error"; name: string; code: string; message: string }
  | { type: "answer"; text: string; citations: Citation[]; replaced: boolean };

export interface RunOptions<D> {
  provider: ModelProvider;
  registry: ToolRegistry<D>;
  deps: ExecutorDeps<D>;
  ctx: AuthContext;
  instructions: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxRounds?: number;
}

export function toolSpecs<D>(registry: ToolRegistry<D>, ctx: AuthContext): FunctionToolSpec[] {
  return registry.listFor(ctx).map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema }));
}

export async function* runAgent<D>(o: RunOptions<D>): AsyncGenerator<RunEvent> {
  const input: InputItem[] = o.messages.map((m) => ({ type: "message", role: m.role, content: m.content }));
  const tools = toolSpecs(o.registry, o.ctx);
  const catalog: Citation[] = [];
  const safetyIdentifier = await sha256Hex(`${o.ctx.tenantId}:${o.ctx.userId}`);
  const rounds = o.maxRounds ?? 5;

  for (let round = 0; round < rounds; round++) {
    const res = await o.provider.respond({ instructions: o.instructions, input, tools, safetyIdentifier });
    input.push(...res.output);
    if (res.functionCalls.length === 0) {
      const checked = enforceCitations(res.text, catalog);
      yield { type: "answer", ...checked };
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
        if (args === null) throw new AgentError("invalid_input", "arguments were not valid JSON", 400);
        const r = await o.registry.execute(call.name, args, o.ctx, o.deps);
        const labelled: Citation[] = r.sources.map((s) => {
          const c: Citation = { ...s, cite: `S${catalog.length + 1}` };
          catalog.push(c);
          return c;
        });
        yield { type: "tool_result", name: call.name, sources: labelled, unknown: r.unknown, planned: r.planned };
        output = {
          data: r.data,
          unknown: r.unknown,
          planned: r.planned,
          sources: labelled.map((c) => ({ cite: c.cite, title: c.title, publisher: c.publisher, observed_at: c.observed_at, received_at: c.received_at })),
        };
      } catch (e) {
        const err = e instanceof AgentError ? e : new AgentError("provider_error", String(e), 500);
        yield { type: "tool_error", name: call.name, code: err.code, message: err.message };
        output = { error: err.code, message: err.message };
      }
      input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) });
    }
  }
  yield { type: "answer", ...enforceCitations("I don't know. I ran out of steps before finding a sourced answer.", catalog) };
}
