// Model provider interface. The agent runner speaks this neutral format; each
// provider maps it onto its own API. xAI Grok is the default (providers/xai.ts).
import type { JsonSchema } from "../types";

export interface FunctionToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export type InputItem =
  | { type: "message"; role: "user" | "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  /** Opaque provider items (for example encrypted reasoning) passed back unchanged. */
  | { type: "opaque"; provider: string; item: unknown };

export interface ModelRequest {
  instructions: string;
  input: InputItem[];
  tools: FunctionToolSpec[];
  /** Stable, hashed end-user id for provider abuse attribution. */
  safetyIdentifier?: string;
  /** Cap on generated tokens for this round. */
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface ModelResponse {
  /** Output items to append to the conversation, in order. */
  output: InputItem[];
  /** Final assistant text, if the model produced any this round. */
  text: string;
  functionCalls: { call_id: string; name: string; arguments: string }[];
}

export interface ModelProvider {
  readonly id: string;
  respond(req: ModelRequest): Promise<ModelResponse>;
}

/** Browser voice session: a short-lived credential plus the settings the page sends. */
export interface VoiceSession {
  provider: string;
  /** WebSocket URL the browser connects to. */
  url: string;
  /** WebSocket subprotocols carrying the short-lived credential. */
  protocols: string[];
  expires_at: number | null;
  /** Sent by the browser as the first session.update. */
  session: Record<string, unknown>;
  /** True when the instructions and tools were also bound to the short-lived credential server-side. */
  bound?: boolean;
}

export interface VoiceProvider {
  readonly id: string;
  createSession(opts: { instructions: string; tools: FunctionToolSpec[] }): Promise<VoiceSession>;
}
