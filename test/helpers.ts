import { readFileSync } from "node:fs";
import { join } from "node:path";

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));

export interface Route {
  match: (url: URL, init?: RequestInit) => boolean;
  respond: (url: URL, init?: RequestInit) => Response | Promise<Response>;
}

/** A fetch stub that serves fixtures by URL and records every request. */
export function stubFetch(routes: Route[]) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init });
    const r = routes.find((x) => x.match(url, init));
    if (!r) return new Response(JSON.stringify({ error: { code: 404, message: "no route" } }), { status: 404 });
    return r.respond(url, init);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export const jsonResponse = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });

/** Minimal in-memory KVNamespace for tests. */
export function memoryKV() {
  const store = new Map<string, string>();
  const kv = {
    store,
    async get(key: string, type?: string | { type?: string }) {
      const v = store.get(key);
      if (v === undefined) return null;
      const t = typeof type === "object" ? type.type : type;
      return t === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
  return kv as unknown as KVNamespace & { store: Map<string, string> };
}
