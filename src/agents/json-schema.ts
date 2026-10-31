// A small JSON Schema validator for the subset used by tool schemas. Workers
// forbid eval/new Function, so code-generating validators are not an option.
import type { JsonSchema } from "./types";

export function validate(schema: JsonSchema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  const t = schema.type;
  if (t !== undefined) {
    const types = Array.isArray(t) ? t : [t];
    if (!types.some((x) => matchesType(x, value))) {
      errors.push(`${path}: expected ${types.join("|")}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) errors.push(`${path}: not one of ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) errors.push(`${path}: not a date-time`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items!, v, `${path}[${i}]`)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in obj)) errors.push(`${path}.${r}: required`);
    for (const [k, v] of Object.entries(obj)) {
      const ps = schema.properties?.[k];
      if (ps) errors.push(...validate(ps, v, `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${k}: not allowed`);
      else if (typeof schema.additionalProperties === "object") errors.push(...validate(schema.additionalProperties, v, `${path}.${k}`));
    }
  }
  return errors;
}

function matchesType(t: string, v: unknown): boolean {
  switch (t) {
    case "object":
      return v !== null && typeof v === "object" && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    default:
      return false;
  }
}

/** Apply top-level `default` values for missing properties. */
export function withDefaults(schema: JsonSchema, value: unknown): unknown {
  if (value === undefined || value === null) value = {};
  if (typeof value !== "object" || Array.isArray(value) || !schema.properties) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [k, ps] of Object.entries(schema.properties)) if (!(k in out) && ps.default !== undefined) out[k] = ps.default;
  return out;
}

/** Shared schema for SourceRef, reused by every tool's output schema. */
export const SOURCE_REF_SCHEMA: JsonSchema = {
  type: "object",
  required: ["id", "kind", "title", "publisher", "url", "observed_at", "received_at"],
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: ["public-layer", "tenant-data", "shared-data", "tenant-config", "document"] },
    title: { type: "string" },
    publisher: { type: "string" },
    url: { type: ["string", "null"] },
    observed_at: { type: ["string", "null"] },
    received_at: { type: ["string", "null"] },
  },
};
