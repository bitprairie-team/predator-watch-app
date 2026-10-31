// Scripted provider for tests and offline development (MODEL_PROVIDER=mock).
// No network calls.
import type { FunctionToolSpec, ModelProvider, ModelRequest, ModelResponse, VoiceProvider, VoiceSession } from "./types";

export type MockStep = (req: ModelRequest) => ModelResponse;

export const mockText = (text: string): ModelResponse => ({
  output: [{ type: "message", role: "assistant", content: text }],
  text,
  functionCalls: [],
});

export const mockCall = (name: string, args: unknown, call_id = `call_${name}`): ModelResponse => {
  const a = JSON.stringify(args);
  return { output: [{ type: "function_call", call_id, name, arguments: a }], text: "", functionCalls: [{ call_id, name, arguments: a }] };
};

export class MockProvider implements ModelProvider, VoiceProvider {
  readonly id = "mock";
  readonly requests: ModelRequest[] = [];
  private i = 0;
  constructor(private readonly steps: (MockStep | ModelResponse)[] = []) {}

  async respond(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone({ ...req, signal: undefined }));
    const s = this.steps[this.i++];
    if (!s) return mockText("I don't know. (mock provider has no scripted reply)");
    return typeof s === "function" ? s(req) : s;
  }

  async createSession(opts: { instructions: string; tools: FunctionToolSpec[] }): Promise<VoiceSession> {
    return { provider: this.id, url: "wss://mock.invalid/realtime", protocols: ["mock"], expires_at: null, session: { instructions: opts.instructions, tools: opts.tools } };
  }
}
