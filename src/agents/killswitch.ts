// Kill switches. Any one of them stops work immediately, checked at the start
// of every chat turn, voice step, MCP request, and background agent run.
//
//   env ASSISTANT_DISABLED=1          whole assistant off (chat, voice, MCP, agents)
//   env AGENTS_DISABLED=1             all background agents off
//   store killswitch:global           { assistant?: true, agents?: true, reason? }
//   store killswitch:tenant:<id>      same fields, one tenant
//   store killswitch:agent:<agentId>  { agents: true, reason? }, one agent for everyone
//   store agentpause:<tenant>:<agent> set by the rancher: their own agent paused
//
// The store switches are set by the owner with wrangler (see docs).
import type { PrivateStore } from "./store";

export interface KillEnv {
  ASSISTANT_DISABLED?: string;
  AGENTS_DISABLED?: string;
}

interface Switch {
  assistant?: boolean;
  agents?: boolean;
  reason?: string;
}

const on = (v: string | undefined) => v === "1" || v === "true";

/** Returns a plain reason if the assistant is switched off for this tenant, else null. */
export async function assistantKilled(store: PrivateStore, env: KillEnv, tenantId: string): Promise<string | null> {
  if (on(env.ASSISTANT_DISABLED)) return "The assistant is turned off on this server.";
  const g = await store.get<Switch>("killswitch:global");
  if (g?.assistant) return g.reason ?? "The assistant is turned off for now.";
  const t = await store.get<Switch>(`killswitch:tenant:${tenantId}`);
  if (t?.assistant) return t.reason ?? "The assistant is turned off for your account for now.";
  return null;
}

/** Returns a plain reason if this background agent may not run for this tenant, else null. */
export async function agentKilled(store: PrivateStore, env: KillEnv, tenantId: string, agentId: string): Promise<string | null> {
  const a = await assistantKilled(store, env, tenantId);
  if (a) return a;
  if (on(env.AGENTS_DISABLED)) return "Background agents are turned off on this server.";
  const g = await store.get<Switch>("killswitch:global");
  if (g?.agents) return g.reason ?? "Background agents are turned off for now.";
  const t = await store.get<Switch>(`killswitch:tenant:${tenantId}`);
  if (t?.agents) return t.reason ?? "Background agents are turned off for your account for now.";
  const one = await store.get<Switch>(`killswitch:agent:${agentId}`);
  if (one?.agents) return one.reason ?? "This agent is turned off for now.";
  if (await store.get<{ at: string }>(`agentpause:${tenantId}:${agentId}`)) return "You paused this agent.";
  return null;
}
