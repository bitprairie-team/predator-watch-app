// Provider factory. xAI Grok is the default; other providers plug in by
// implementing ModelProvider / VoiceProvider and adding a case here.
import type { ModelProvider, VoiceProvider } from "./types";
import { XaiProvider } from "./xai";

export interface ProviderEnv {
  MODEL_PROVIDER?: string;
  XAI_API_KEY?: string;
  XAI_MODEL?: string;
  XAI_VOICE_MODEL?: string;
  XAI_VOICE?: string;
}

/** Returns null when the chosen provider is not configured (no key). */
export function createProvider(env: ProviderEnv): (ModelProvider & VoiceProvider) | null {
  const id = (env.MODEL_PROVIDER || "xai").toLowerCase();
  switch (id) {
    case "xai":
      if (!env.XAI_API_KEY) return null;
      return new XaiProvider({ apiKey: env.XAI_API_KEY, model: env.XAI_MODEL, voiceModel: env.XAI_VOICE_MODEL, voice: env.XAI_VOICE });
    default:
      return null;
  }
}
