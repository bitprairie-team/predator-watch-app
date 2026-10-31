// Response helpers for the Worker: security headers, cache-control, ETags and
// conditional requests, HEAD support.
import { fnv1a } from "../lib/hash";

export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "permissions-policy": "camera=(), microphone=(), payment=(), usb=(), interest-cohort=()",
  "x-frame-options": "DENY",
  // API responses are data, never documents.
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cross-origin-resource-policy": "cross-origin",
};

export interface RespondOptions {
  status?: number;
  /** Browser/CDN max-age in seconds. 0 means no-store. */
  maxAge?: number;
  contentType?: string;
  /** Suggest a download filename. */
  filename?: string;
  headers?: Record<string, string>;
}

export function etagFor(body: string): string {
  return `W/"${fnv1a(body)}-${body.length.toString(36)}"`;
}

function matches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  return ifNoneMatch.split(",").some((t) => strip(t) === strip(etag));
}

export function respond(request: Request, body: string, opts: RespondOptions = {}): Response {
  const status = opts.status ?? 200;
  const maxAge = opts.maxAge ?? 60;
  const headers = new Headers({
    ...SECURITY_HEADERS,
    "content-type": opts.contentType ?? "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "ETag",
    "cache-control": maxAge > 0 ? `public, max-age=${maxAge}, stale-while-revalidate=${maxAge * 5}` : "no-store",
    vary: "Accept-Encoding",
    ...opts.headers,
  });
  if (opts.filename) headers.set("content-disposition", `attachment; filename="${opts.filename.replace(/[^\w.-]/g, "_")}"`);
  if (status === 200) {
    const etag = etagFor(body);
    headers.set("etag", etag);
    if (matches(request.headers.get("if-none-match"), etag)) {
      headers.delete("content-type");
      headers.delete("content-disposition");
      return new Response(null, { status: 304, headers });
    }
  }
  return new Response(request.method === "HEAD" ? null : body, { status, headers });
}

export function json(request: Request, value: unknown, opts: RespondOptions = {}): Response {
  return respond(request, JSON.stringify(value), opts);
}

export function problem(request: Request, status: number, message: string, extra: Record<string, string> = {}): Response {
  return json(request, { error: message, status }, { status, maxAge: 0, headers: extra });
}
