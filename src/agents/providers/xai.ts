// xAI Grok provider.
//
// Text: the Responses API, POST https://api.x.ai/v1/responses, with function
// tools and a client-side tool loop. We send the whole conversation every
// round with store:false so nothing is kept server-side, and pass back
// reasoning.encrypted_content as the docs describe for stateless loops.
//   https://docs.x.ai/developers/rest-api-reference/inference/responses
//   https://docs.x.ai/developers/tools/function-calling
//   https://docs.x.ai/developers/tools/advanced-usage
//
// Voice: the realtime Speech to Speech API over WebSocket,
// wss://api.x.ai/v1/realtime?model=grok-voice-latest. The Worker mints a
// short-lived client secret with POST https://api.x.ai/v1/realtime/client_secrets
// and the browser connects with the subprotocol `xai-client-secret.<token>`.
//   https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech
//   https://docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens
//   https://docs.x.ai/developers/rest-api-reference/inference/voice
//
// The key comes only from the XAI_API_KEY secret.
import { AgentError } from "../types";
import type { FunctionToolSpec, InputItem, ModelProvider, ModelRequest, ModelResponse, VoiceProvider, VoiceSession } from "./types";

export const XAI_BASE = "https://api.x.ai/v1";
export const XAI_DEFAULT_MODEL = "grok-4.7";
export const XAI_DEFAULT_VOICE_MODEL = "grok-voice-latest";

export interface XaiOptions {
  apiKey: string;
  model?: string;
  voiceModel?: string;
  voice?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type XaiOutputItem =
  | { type: "message"; role: "assistant"; content: { type: string; text?: string }[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: string; [k: string]: unknown };

export class XaiProvider implements ModelProvider, VoiceProvider {
  readonly id = "xai";
  private readonly f: typeof fetch;
  constructor(private readonly opts: XaiOptions) {
    if (!opts.apiKey) throw new AgentError("provider_error", "XAI_API_KEY is not set", 503);
    this.f = opts.fetchImpl ?? fetch;
  }

  /** Map neutral input items onto Responses API input items. */
  static toXaiInput(items: InputItem[]): unknown[] {
    return items.map((i) => {
      switch (i.type) {
        case "message":
          return { role: i.role, content: i.content };
        case "function_call":
          return { type: "function_call", call_id: i.call_id, name: i.name, arguments: i.arguments };
        case "function_call_output":
          return { type: "function_call_output", call_id: i.call_id, output: i.output };
        case "opaque":
          return i.item;
      }
    });
  }

  static toXaiTools(tools: FunctionToolSpec[]) {
    return tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
  }

  async respond(req: ModelRequest): Promise<ModelResponse> {
    const body = {
      model: this.opts.model ?? XAI_DEFAULT_MODEL,
      instructions: req.instructions,
      input: XaiProvider.toXaiInput(req.input),
      tools: XaiProvider.toXaiTools(req.tools),
      tool_choice: "auto",
      store: false,
      include: ["reasoning.encrypted_content"],
      ...(req.safetyIdentifier ? { safety_identifier: req.safetyIdentifier } : {}),
      ...(req.maxOutputTokens ? { max_output_tokens: req.maxOutputTokens } : {}),
    };
    const signal = req.signal ?? AbortSignal.timeout(this.opts.timeoutMs ?? 120_000);
    const r = await this.f(`${XAI_BASE}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!r.ok) throw new AgentError("provider_error", `xAI responses error ${r.status}`, 502);
    const json = (await r.json()) as { output?: XaiOutputItem[] };
    return XaiProvider.parseOutput(json.output ?? []);
  }

  static parseOutput(output: XaiOutputItem[]): ModelResponse {
    const out: InputItem[] = [];
    const calls: ModelResponse["functionCalls"] = [];
    let text = "";
    for (const item of output) {
      if (item.type === "function_call") {
        const fc = item as { call_id: string; name: string; arguments: string };
        calls.push({ call_id: fc.call_id, name: fc.name, arguments: fc.arguments });
        out.push({ type: "function_call", call_id: fc.call_id, name: fc.name, arguments: fc.arguments });
      } else if (item.type === "message") {
        const m = item as { content: { type: string; text?: string }[] };
        const t = m.content.filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("");
        text += t;
        out.push({ type: "message", role: "assistant", content: t });
      } else {
        // Reasoning and other items go back unchanged on the next round.
        out.push({ type: "opaque", provider: "xai", item });
      }
    }
    return { output: out, text, functionCalls: calls };
  }

  async createSession(opts: { instructions: string; tools: FunctionToolSpec[] }): Promise<VoiceSession> {
    const model = this.opts.voiceModel ?? XAI_DEFAULT_VOICE_MODEL;
    const session = {
      voice: this.opts.voice ?? "eve",
      instructions: opts.instructions,
      turn_detection: { type: "server_vad" },
      audio: {
        input: { format: { type: "audio/pcm", rate: 24000 } },
        output: { format: { type: "audio/pcm", rate: 24000 } },
      },
      tools: opts.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters })),
    };
    const mint = (body: unknown) =>
      this.f(`${XAI_BASE}/realtime/client_secrets`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    // A token opens one session and only has to last until the browser connects.
    // Bind the guarded instructions and tools to the token so the browser can't
    // start a session without them. The REST reference lists `session` as
    // optional initial config; if the API rejects it, mint a plain token and
    // rely on the browser's session.update plus the server-side voice guard.
    let bound = true;
    let r = await mint({ expires_after: { seconds: 60 }, session: { model, ...session } });
    if (r.status === 400 || r.status === 422) {
      bound = false;
      r = await mint({ expires_after: { seconds: 60 } });
    }
    if (!r.ok) throw new AgentError("provider_error", `xAI client secret error ${r.status}`, 502);
    const secret = (await r.json()) as { value?: string; expires_at?: number; client_secret?: { value?: string; expires_at?: number } };
    const value = secret.value ?? secret.client_secret?.value;
    if (!value) throw new AgentError("provider_error", "xAI returned no client secret", 502);
    return {
      provider: this.id,
      url: `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(model)}`,
      protocols: [`xai-client-secret.${value}`],
      expires_at: secret.expires_at ?? secret.client_secret?.expires_at ?? null,
      session,
      bound,
    };
  }
}
