// Provider factory. xAI Grok is the default; other providers plug in by
// implementing ModelProvider / VoiceProvider and adding a case here.
import type { ModelProvider, VoiceProvider } from "./types";
import { XaiProvider } from "./xai";
import { createXaiMockFetch } from "./xai-mock";

export interface ProviderEnv {
  MODEL_PROVIDER?: string;
  XAI_API_KEY?: string;
  XAI_MODEL?: string;
  XAI_VOICE_MODEL?: string;
  XAI_VOICE?: string;
  /** "1" runs the real xAI client against an offline mock of the API (tests and local dev). */
  XAI_MOCK?: string;
}

export function isMockProvider(env: ProviderEnv): boolean {
  return env.XAI_MOCK === "1" || env.XAI_MOCK === "true" || (env.MODEL_PROVIDER ?? "").toLowerCase() === "mock";
}

/** Returns null when the chosen provider is not configured (no key). */
export function createProvider(env: ProviderEnv): (ModelProvider & VoiceProvider) | null {
  if (isMockProvider(env)) {
    // Same client code as production; only fetch is swapped. Never uses a real key.
    return new XaiProvider({ apiKey: "mock-key", model: env.XAI_MODEL, voiceModel: env.XAI_VOICE_MODEL, voice: env.XAI_VOICE, fetchImpl: createXaiMockFetch() });
  }
  const id = (env.MODEL_PROVIDER || "xai").toLowerCase();
  switch (id) {
    case "xai":
      if (!env.XAI_API_KEY) return null;
      return new XaiProvider({ apiKey: env.XAI_API_KEY, model: env.XAI_MODEL, voiceModel: env.XAI_VOICE_MODEL, voice: env.XAI_VOICE });
    default:
      return null;
  }
}
