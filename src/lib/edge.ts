// Edge cache in front of the public API. Every public response is built from
// KV only; this keeps even KV reads off the hot path during a traffic spike.
// The cache key is the normalized URL, never the client's headers, and the
// conditional request (If-None-Match) is answered after the lookup so one
// cached copy serves every client.

export function edgeCache(): Cache | undefined {
  return typeof caches !== "undefined" ? (caches as unknown as { default?: Cache }).default : undefined;
}

function etagMatches(ifNoneMatch: string | null, etag: string | null): boolean {
  if (!ifNoneMatch || !etag) return false;
  if (ifNoneMatch.trim() === "*") return true;
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  return ifNoneMatch.split(",").some((t) => strip(t) === strip(etag));
}

/** Turn a full 200 response into what this request should get (304, HEAD, or the body). */
export function finish(request: Request, res: Response, cacheState: "HIT" | "MISS" | "BYPASS"): Response {
  const headers = new Headers(res.headers);
  headers.set("x-edge-cache", cacheState);
  if (res.status === 200 && etagMatches(request.headers.get("if-none-match"), res.headers.get("etag"))) {
    headers.delete("content-type");
    headers.delete("content-disposition");
    headers.delete("content-length");
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") return new Response(null, { status: res.status, headers });
  return new Response(res.body, { status: res.status, headers });
}

/**
 * Serve from the edge cache, or build the response with `compute` and store
 * it. `compute` always gets a plain GET with no conditional headers, so the
 * stored copy is the full body.
 */
export async function cached(
  request: Request,
  ctx: ExecutionContext,
  key: string,
  compute: (plain: Request) => Promise<Response>,
): Promise<Response> {
  const cache = edgeCache();
  const keyReq = new Request(key, { method: "GET" });
  if (cache) {
    const hit = await cache.match(keyReq);
    if (hit) return finish(request, hit, "HIT");
  }
  const res = await compute(new Request(request.url, { method: "GET" }));
  const cc = res.headers.get("cache-control") ?? "";
  if (cache && res.status === 200 && /public/.test(cc) && !/no-store/.test(cc)) {
    ctx.waitUntil(cache.put(keyReq, res.clone()).catch(() => undefined));
  }
  return finish(request, res, cache ? "MISS" : "BYPASS");
}
