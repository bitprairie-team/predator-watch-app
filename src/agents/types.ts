// Core types for the agent framework. Everything here is runtime-neutral and
// Workers-friendly: no Node APIs, no global state.

/** A JSON Schema (the subset our validator understands; see json-schema.ts). */
export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null" | Array<string>;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  format?: string;
  default?: unknown;
}

/**
 * Permission scopes. Tools declare one; an auth context carries a list.
 * `rancher:read` is the umbrella read scope granted to MCP clients by default.
 */
export type Scope =
  | "rancher:read"
  | "activity:read"
  | "alerts:read"
  | "directory:read"
  | "docs:read"
  | "summary:read"
  | "audit:read";

export const READ_SCOPES: Scope[] = [
  "activity:read",
  "alerts:read",
  "directory:read",
  "docs:read",
  "summary:read",
  "audit:read",
];

export type Plan = "public" | "rancher";

/** Who is calling. Built only by the auth layer, never from request input. */
export interface AuthContext {
  tenantId: string;
  userId: string;
  plan: Plan;
  scopes: Scope[];
  /** Channel the call came from, for the audit log. */
  client: string;
}

/** Where a fact came from. Every tool result carries these. */
export interface SourceRef {
  /** Stable id, unique within one tool result. */
  id: string;
  kind: "public-layer" | "tenant-data" | "shared-data" | "tenant-config" | "document";
  title: string;
  publisher: string;
  url: string | null;
  /** When the publisher says the fact was observed or last valid. */
  observed_at: string | null;
  /** When this system received it. */
  received_at: string | null;
}

export interface ToolResult<T = unknown> {
  data: T;
  sources: SourceRef[];
  /** Set when the tool has no data to answer with; the assistant must say it does not know. */
  unknown?: string;
  /** Set when the answer depends on a feature that is not built yet. */
  planned?: string;
}

export interface ToolDefinition<I = any, O = any, D = unknown> {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  /** Entitlement needed on the tenant's plan. */
  entitlement: Entitlement;
  inputSchema: JsonSchema;
  /** Schema of ToolResult.data. */
  outputSchema: JsonSchema;
  readOnly: true;
  handler: (input: I, deps: D, ctx: AuthContext) => Promise<ToolResult<O>>;
}

export type Entitlement = "rancher_assistant";

export class AgentError extends Error {
  constructor(
    public readonly code:
      | "unauthenticated"
      | "forbidden"
      | "not_entitled"
      | "rate_limited"
      | "invalid_input"
      | "invalid_output"
      | "unknown_tool"
      | "provider_error",
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
