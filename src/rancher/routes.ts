// HTTP routes for the private rancher assistant.
//   GET  /api/assistant/me              who am I, plan, ranches, tools
//   GET  /api/assistant/tools           tool list with JSON Schemas
//   POST /api/assistant/chat            text chat, streamed as Server-Sent Events
//   POST /api/assistant/voice/session   short-lived voice credential + session config
//   POST /api/assistant/voice/guard     policy check on a voice transcript (input or output)
//   POST /api/assistant/tools/:name     run one tool (used by the voice client)
//   GET  /api/assistant/audit           the caller's own audit log
//   /api/assistant/agents*, /outbox*    background agents and approvals (see agents-service.ts)
//   /api/ranch/*                        ranch tools: settings, activity log, by-hand jobs (see ranch-routes.ts)
//
// The assistant is off until the rancher turns it on in Settings. Until then
// chat, voice, and assistant tool calls answer 403 "turned_off". Every answer
// and decline writes a "what I did" record to the activity log.
import { sourcesFooter, type Citation } from "../agents/citations";
import { toolSpecs } from "../agents/runner";
import { recordGuardEvent } from "../agents/audit";
import { assistantKilled } from "../agents/killswitch";
import { AgentError, type AuthContext } from "../agents/types";
import { classifyConversation } from "../guardrails/classifier";
import { checkOutput } from "../guardrails/output-check";
import { ASSISTANT_NOTICE, CAN_HELP_WITH, DISCLAIMER, refusalText } from "../guardrails/policy";
import { DATA_NOTICE } from "../guardrails/sanitize";
import { handleAgentRoutes } from "./agents-service";
import { ownNames, runRancherTurn, type TurnEvent } from "./assistant";
import { describeArgs, issueRules, recordActivity, sourcesOf, type ActivityRecord } from "../agents/activity";
import { assistantOn } from "./prefs";
import { handleRanch } from "./ranch-routes";

/** Spoken turns older than this are not joined with a new question. */
const VOICE_TURN_WINDOW_MS = 10 * 60 * 1000;
import { RANCHER_INSTRUCTIONS, RANCHER_VOICE_INSTRUCTIONS } from "./prompt";
import type { RancherService } from "./service";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof AgentError) return json({ error: e.code, message: e.message }, e.status);
  console.error("assistant error", e);
  return json({ error: "internal", message: "Something went wrong." }, 500);
}

const MAX_BODY = 32_000;

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new AgentError("invalid_input", "Request body is too large.", 413);
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new AgentError("invalid_input", "Body must be a JSON object.", 400);
  }
}

function parseMessages(body: Record<string, unknown>) {
  const raw = body.messages;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20)
    throw new AgentError("invalid_input", "messages must be a list of 1 to 20 items.", 400);
  return raw.map((m) => {
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || !content.trim() || content.length > 4000)
      throw new AgentError("invalid_input", "Each message needs role user|assistant and 1-4000 characters of content.", 400);
    return { role, content } as { role: "user" | "assistant"; content: string };
  });
}

async function requireEntitled(svc: RancherService, ctx: AuthContext) {
  if (!(await svc.entitlements.has(ctx, "rancher_assistant")))
    throw new AgentError("not_entitled", "This needs the private rancher plan.", 402);
}

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Split an answer into small chunks for progressive display. */
function chunks(text: string, size = 24): string[] {
  const out: string[] = [];
  const words = text.split(/(\s+)/);
  let cur = "";
  for (const w of words) {
    cur += w;
    if (cur.length >= size) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
}

const TURNED_OFF = "The assistant is off for your account. Turn it on in Ranch tools, Settings. Everything it looks up also works by hand there.";

async function requireAssistantOn(svc: RancherService, ctx: AuthContext) {
  if (!(await assistantOn(svc.store, ctx.tenantId))) throw new AgentError("turned_off", TURNED_OFF, 403);
}

const CATEGORY_WORDS: Record<string, string> = {
  legal: "legal advice",
  compensation: "compensation claim strategy",
  veterinary: "veterinary advice",
  financial: "financial advice",
  lethal: "instructions for killing animals",
  evasion: "getting around rules",
  harm_location: "finding animals or dens",
  precise_location: "exact locations",
  personal_data: "other people's information",
  injection: "changing the assistant's rules",
  contested: "an opinion on a contested topic",
  off_topic: "something outside ranch data",
};

/** Build the "what I did" record for one chat turn from its events. */
async function answerRecord(svc: RancherService, ctx: AuthContext, question: string, events: TurnEvent[], channel: "chat" | "voice"): Promise<ActivityRecord> {
  const t = await svc.deps.data(ctx).data.tenant();
  const names = Object.fromEntries((t?.ranches ?? []).flatMap((r) => [[r.id, r.name], ...r.allotments.map((a) => [a.id, a.name])]));
  const answer = events.find((e): e is Extract<TurnEvent, { type: "answer" }> => e.type === "answer");
  const guard = events.find((e): e is Extract<TurnEvent, { type: "guard" }> => e.type === "guard");
  const calls = events.filter((e): e is Extract<TurnEvent, { type: "tool_call" }> => e.type === "tool_call");
  const refused = !!answer?.refused || !!guard;
  const category = answer?.category ?? guard?.category;
  const q = question.replace(/\s+/g, " ").trim();
  const rules = [
    "Checked the question against what the assistant helps with: ranch data, alerts, contacts, reporting, and general nonlethal practice.",
    ...(calls.length ? ["Read only the data your access key allows, through the same lookups you can run by hand."] : []),
    ...(refused ? [] : ["Every fact in the answer needs a source from this turn; exact coordinates not from your own records are held back; links are removed."]),
    ...issueRules(answer?.issues),
    ...(answer?.blocked ? [`Stopped the answer because it read as ${CATEGORY_WORDS[answer.blocked] ?? answer.blocked}.`] : []),
    ...(answer?.replaced ? ["Said \"I don't know\" because no source backed the answer."] : []),
    ...(answer?.limit ? [`Stopped at the ${answer.limit === "tool_calls" ? "lookup" : answer.limit === "rounds" ? "step" : "time"} limit for one question.`] : []),
  ];
  return recordActivity(svc.store, {
    tenant_id: ctx.tenantId,
    at: svc.now().toISOString(),
    kind: refused ? "decline" : "answer",
    actor: "assistant",
    title: `${channel === "voice" ? "Voice" : "Question"}: ${q.slice(0, 80)}${q.length > 80 ? "..." : ""}`,
    outcome: refused
      ? `Declined: the question asked for ${CATEGORY_WORDS[category ?? ""] ?? "something the assistant does not help with"}.`
      : answer?.replaced
        ? "Answered \"I don't know\" because no source backed an answer."
        : `Answered with ${answer?.citations.length ?? 0} source${answer?.citations.length === 1 ? "" : "s"}.`,
    read: calls.map((c) => ({ tool: c.name, title: svc.registry.get(c.name)?.title ?? c.name, detail: describeArgs((c.arguments ?? {}) as Record<string, unknown>, names) })),
    sources: sourcesOf(answer?.citations),
    rules,
    skipped: refused ? [{ what: "Your question", why: `It asked for ${CATEGORY_WORDS[category ?? ""] ?? "something outside what the assistant helps with"}, which the assistant does not give.` }] : [],
  });
}

export async function handleRanchRequest(request: Request, url: URL, svc: RancherService | null): Promise<Response> {
  try {
    return await handleRanch(request, url, svc, json, () => readJson(request));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function handleAssistant(request: Request, url: URL, svc: RancherService | null): Promise<Response> {
  if (!svc) return json({ error: "not_configured", message: "The private rancher plan is not set up on this server." }, 503);
  const path = url.pathname.replace(/\/+$/, "");
  try {
    const ctx = await svc.authenticate(request, path.includes("/voice") || path.startsWith("/api/assistant/tools/") ? "web-voice" : "web");
    if (!ctx) throw new AgentError("unauthenticated", "Sign in with your rancher access key.", 401);
    const killed = await assistantKilled(svc.store, svc.env, ctx.tenantId);
    if (killed) throw new AgentError("disabled", killed, 503);

    // Chat, voice, and assistant tool calls need the assistant turned on.
    if (path === "/api/assistant/chat" || path.startsWith("/api/assistant/voice/") || path.startsWith("/api/assistant/tools/")) {
      await requireEntitled(svc, ctx);
      await requireAssistantOn(svc, ctx);
    }

    if (path.startsWith("/api/assistant/agents") || path.startsWith("/api/assistant/outbox")) {
      await requireEntitled(svc, ctx);
      return (await handleAgentRoutes(request, path, svc, ctx, () => readJson(request), json))!;
    }

    if (request.method === "GET" && path === "/api/assistant/me") {
      const entitled = await svc.entitlements.has(ctx, "rancher_assistant");
      const data = svc.deps.data(ctx).data;
      const t = entitled ? await data.tenant() : null;
      return json({
        tenant: t ? { id: t.id, name: t.name } : { id: ctx.tenantId },
        plan: ctx.plan,
        entitled,
        scopes: ctx.scopes,
        ranches: t?.ranches.map((r) => ({ id: r.id, name: r.name, allotments: r.allotments.map((a) => ({ id: a.id, name: a.name })) })) ?? [],
        voice_available: !!svc.provider,
        chat_available: !!svc.provider,
        mock: svc.mock,
        disclaimer: DISCLAIMER,
        notice: ASSISTANT_NOTICE,
        can_help_with: CAN_HELP_WITH,
        assistant_on: await assistantOn(svc.store, ctx.tenantId),
        turned_off_message: TURNED_OFF,
      });
    }

    if (request.method === "GET" && path === "/api/assistant/tools") {
      return json({
        tools: svc.registry.listFor(ctx).map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          scope: t.scope,
          read_only: t.readOnly,
          input_schema: t.inputSchema,
          output_schema: svc.registry.resultSchema(t),
        })),
      });
    }

    if (request.method === "GET" && path === "/api/assistant/audit") {
      await requireEntitled(svc, ctx);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      return json({ entries: await svc.audit.list(ctx, limit) });
    }

    const toolMatch = path.match(/^\/api\/assistant\/tools\/([a-z][a-z0-9_]{2,63})$/);
    if (request.method === "POST" && toolMatch) {
      const body = await readJson(request);
      const result = await svc.registry.execute(toolMatch[1]!, body.arguments ?? {}, ctx, svc.deps);
      const citations: Citation[] = result.sources.map((s, i) => ({ ...s, cite: `S${i + 1}` }));
      const t = await svc.deps.data(ctx).data.tenant();
      const names = Object.fromEntries((t?.ranches ?? []).flatMap((r) => [[r.id, r.name], ...r.allotments.map((a) => [a.id, a.name])]));
      const title = svc.registry.get(toolMatch[1]!)?.title ?? toolMatch[1]!;
      const rec = await recordActivity(svc.store, {
        tenant_id: ctx.tenantId,
        at: svc.now().toISOString(),
        kind: "answer",
        actor: "assistant",
        title: `Voice lookup: ${title}`,
        outcome: result.unknown ? `No data: ${result.unknown}` : `Read ${citations.length} source${citations.length === 1 ? "" : "s"} for a spoken answer.`,
        read: [{ tool: toolMatch[1]!, title, detail: describeArgs((body.arguments ?? {}) as Record<string, unknown>, names) }],
        sources: sourcesOf(citations),
        rules: ["Read only the data your access key allows.", "The spoken answer is checked again before it is played: blocked content is stopped and exact coordinates are held back."],
        skipped: [],
      });
      // The voice client wraps the result in the same <untrusted_data> fence the server uses.
      return json({ ...result, citations, notice: DATA_NOTICE, activity_id: rec.id });
    }

    if (request.method === "POST" && path === "/api/assistant/voice/session") {
      await requireEntitled(svc, ctx);
      if (!svc.provider) return json({ error: "not_configured", message: "Voice is not set up on this server." }, 503);
      if (!(await svc.rateLimiter.hit(`voice:${ctx.tenantId}`, svc.limits.voiceSessionsPerHour, 3600, svc.now().getTime())))
        throw new AgentError("rate_limited", "Too many voice sessions this hour.", 429);
      const session = await svc.provider.createSession({ instructions: RANCHER_VOICE_INSTRUCTIONS, tools: toolSpecs(svc.registry, ctx) });
      // The browser must send each final transcript to /voice/guard; tool calls go through the registry.
      return json({ ...session, guard: { endpoint: "/api/assistant/voice/guard" }, mock: svc.mock, disclaimer: DISCLAIMER });
    }

    if (request.method === "POST" && path === "/api/assistant/voice/guard") {
      await requireEntitled(svc, ctx);
      const body = await readJson(request);
      const stage = body.stage;
      const text = body.text;
      if ((stage !== "input" && stage !== "output") || typeof text !== "string" || text.length > 8000)
        throw new AgentError("invalid_input", "stage must be input or output, and text a string up to 8000 characters.", 400);
      if (!(await svc.rateLimiter.hit(`voiceguard:${ctx.tenantId}`, svc.guard.voiceGuardPerMinute, 60, svc.now().getTime())))
        throw new AgentError("rate_limited", "Too many voice requests. Try again in a minute.", 429);
      if (stage === "input") {
        // Voice questions are checked with the last few spoken turns, held on
        // the server (not sent by the client), so a split ask is caught.
        const turnsKey = `voice_turns:${ctx.tenantId}:${ctx.userId}`;
        const nowMs = svc.now().getTime();
        const held = ((await svc.store.get<{ at: number; text: string }[]>(turnsKey)) ?? []).filter((t) => nowMs - t.at < VOICE_TURN_WINDOW_MS);
        await svc.store.put(turnsKey, [...held, { at: nowMs, text: text.slice(0, 2000) }].slice(-4), { expirationTtl: 1800 });
        const d = classifyConversation([...held.map((t) => t.text), text], { ownNames: await ownNames(svc, ctx) });
        if (d.action === "decline" && d.category) {
          await recordGuardEvent(svc.audit, ctx, { tool: "assistant.voice", outcome: "refused", category: d.category, rule: d.rule, text, at: svc.now() });
          const rec = await answerRecord(svc, ctx, text, [{ type: "guard", stage: "input", category: d.category, rule: d.rule, emergency: !!d.emergency }], "voice");
          return json({ action: "decline", category: d.category, say: refusalText(d.category, { emergency: d.emergency }), activity_id: rec.id });
        }
        return json({ action: "allow" });
      }
      const c = checkOutput({ text, catalog: [], grounding: false });
      if (c.blocked) {
        await recordGuardEvent(svc.audit, ctx, { tool: "assistant.voice", outcome: "blocked", category: c.blocked, flags: c.issues, text, at: svc.now() });
        return json({ action: "block", category: c.blocked, text: c.text });
      }
      if (c.issues.includes("coordinates")) {
        await recordGuardEvent(svc.audit, ctx, { tool: "assistant.voice", outcome: "blocked", category: "precise_location", flags: ["redacted"], text, at: svc.now() });
        return json({ action: "redact", category: "precise_location", text: c.text });
      }
      return json({ action: "allow" });
    }

    if (request.method === "POST" && path === "/api/assistant/chat") {
      await requireEntitled(svc, ctx);
      if (!svc.provider) return json({ error: "not_configured", message: "Chat is not set up on this server." }, 503);
      const messages = parseMessages(await readJson(request));
      if (!(await svc.rateLimiter.hit(`chat:${ctx.tenantId}`, svc.limits.chatTurnsPerMinute, 60, svc.now().getTime())))
        throw new AgentError("rate_limited", "Too many questions in a minute. Try again shortly.", 429);
      if (!(await svc.rateLimiter.hit(`chatday:${ctx.tenantId}`, svc.guard.chatTurnsPerDay, 86400, svc.now().getTime()))) {
        await recordGuardEvent(svc.audit, ctx, { tool: "assistant.chat", outcome: "rate_limited", flags: ["daily"], at: svc.now() });
        throw new AgentError("rate_limited", "You've reached today's question limit. It resets tomorrow.", 429);
      }
      const provider = svc.provider;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            controller.enqueue(sse("status", { state: "thinking" }));
            const seen: TurnEvent[] = [];
            for await (const ev of runRancherTurn(svc, ctx, messages, { provider, instructions: RANCHER_INSTRUCTIONS })) {
              seen.push(ev);
              if (ev.type === "answer") {
                const record = await answerRecord(svc, ctx, messages.at(-1)!.content, seen, "chat");
                // The answer is released only after the guardrail checks pass.
                for (const c of chunks(ev.text)) controller.enqueue(sse("delta", { text: c }));
                controller.enqueue(sse("citations", { citations: ev.citations, replaced: ev.replaced }));
                controller.enqueue(
                  sse("done", {
                    text: ev.text,
                    footer: sourcesFooter(ev.citations),
                    refused: !!ev.refused,
                    category: ev.category ?? null,
                    general: !!ev.general,
                    blocked: ev.blocked ?? null,
                    issues: ev.issues ?? [],
                    limit: ev.limit ?? null,
                    what_i_did: record,
                  }),
                );
              } else {
                controller.enqueue(sse(ev.type, ev));
              }
            }
          } catch (e) {
            const err = e instanceof AgentError ? e : new AgentError("provider_error", "The assistant could not answer right now.", 502);
            if (!(e instanceof AgentError)) console.error("chat error", e);
            controller.enqueue(sse("error", { error: err.code, message: err.message }));
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
    }

    return json({ error: "not_found" }, 404);
  } catch (e) {
    return errorResponse(e);
  }
}
