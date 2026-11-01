// Stage 7: installable app (manifest, service worker, offline state),
// privacy page and Android app links.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_COLORS } from "../src/config/palette";
import { ANDROID_CERT_FINGERPRINTS, APP_ID, APP_NAME, APP_SHORT_NAME, PLACEHOLDER_FINGERPRINT } from "../src/config/app";
import { handleRequest } from "../src/index";
import type { Env } from "../src/cache";
import { memoryKV } from "./helpers";

const pub = (f: string) => join(__dirname, "..", "public", f);
const read = (f: string) => readFileSync(pub(f), "utf8");
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

describe("web app manifest", () => {
  const m = JSON.parse(read("manifest.webmanifest"));
  it("has the store name, the short name and standalone display", () => {
    expect(m.name).toBe(APP_NAME);
    expect(m.name).toBe("Predator Watch by BitPrairie");
    expect(m.short_name).toBe(APP_SHORT_NAME);
    expect(m.short_name.length).toBeLessThanOrEqual(15);
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
    expect(m.id).toBe("/");
  });
  it("takes its colors from the palette", () => {
    expect(m.theme_color).toBe(APP_COLORS.theme);
    expect(m.background_color).toBe(APP_COLORS.background);
  });
  it("lists 192 and 512 icons, maskable ones too, and every file exists", () => {
    const sizes = (purpose: string) => m.icons.filter((i: { purpose?: string }) => (i.purpose ?? "any").includes(purpose)).map((i: { sizes: string }) => i.sizes);
    expect(sizes("any")).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(sizes("maskable")).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    for (const i of [...m.icons, ...(m.screenshots ?? [])]) expect(existsSync(pub(i.src.slice(1))), i.src).toBe(true);
    for (const s of m.shortcuts ?? []) expect(["/status", "/about"]).toContain(s.url);
  });
  it("every page links the manifest, the touch icon and the iOS app tags", () => {
    for (const f of ["index.html", "about.html", "status.html", "privacy.html", "offline.html"]) {
      const h = read(f);
      expect(h, f).toContain('<link rel="manifest" href="/manifest.webmanifest">');
      expect(h, f).toContain('rel="apple-touch-icon"');
      expect(h, f).toContain('<meta name="apple-mobile-web-app-capable" content="yes">');
      expect(h, f).toContain('<meta name="apple-mobile-web-app-title" content="Predator Watch">');
      expect(h, f).toMatch(/viewport-fit=cover/);
    }
  });
});

describe("service worker", () => {
  const sw = read("sw.js");
  const shell = JSON.parse(`[${/const SHELL_FILES = \[([\s\S]*?)\];/.exec(sw)![1]!.replace(/\.\.\.PAGES,|OFFLINE_PAGE,/g, "").replace(/,\s*$/, "")}]`) as string[];
  it("caches the app shell, every listed file exists, and the offline page is saved", () => {
    expect(sw).toMatch(/const PAGES = \["\/", "\/about", "\/status", "\/privacy"\]/);
    expect(sw).toContain('const OFFLINE_PAGE = "/offline"');
    for (const f of shell) expect(existsSync(pub(f.slice(1))), f).toBe(true);
    expect(shell).toEqual(expect.arrayContaining(["/app.js", "/net.js", "/styles.css", "/page.css", "/prefs.js", "/status.js", "/credits.js"]));
  });
  it("never serves saved data silently: saved copies carry x-pw-saved-at", () => {
    expect(sw).toMatch(/headers\.set\("x-pw-saved-at"/);
    expect(read("app.js")).toMatch(/x-pw-saved-at/);
    expect(read("status.js")).toMatch(/x-pw-saved-at[\s\S]*Saved copy/);
    expect(read("credits.js")).toMatch(/x-pw-saved-at[\s\S]*saved on this device/);
    expect(read("about.html")).toContain('id="sources-saved"');
  });
  it("is network first for pages, data and app files, with timeouts, and same-origin only", () => {
    expect(sw).toMatch(/req\.mode === "navigate"[\s\S]*networkFirstShell/);
    expect(sw).toMatch(/DATA_RE\.test[\s\S]*networkFirstData/);
    expect(sw).toMatch(/url\.origin !== self\.location\.origin\) return/);
    expect(sw).toMatch(/NET_TIMEOUT_MS = \d+/);
    expect(sw).toMatch(/caches\.keys\(\)[\s\S]*caches\.delete/);
  });
  it("the offline page says what works offline and links back to the map", () => {
    const h = read("offline.html");
    expect(h).toMatch(/You are offline/);
    expect(h).toMatch(/Saved copy/);
    expect(h).toContain('href="/"');
    expect(h).not.toMatch(/<script(?![^>]*src=)/);
  });
  it("is not registered inside the store apps (they bundle the files)", () => {
    expect(read("app.js")).toMatch(/"serviceWorker" in navigator && window\.isSecureContext && !NATIVE/);
  });
});

describe("net.js", () => {
  const net = read("net.js");
  it("uses the page's API base only inside the apps", () => {
    expect(net).toContain('meta[name="pw-api-base"]');
    expect(net).toMatch(/export const NATIVE = Boolean\(API_BASE\)/);
    expect(net).toMatch(/\^\\\/\(api\|ogc\)/);
  });
  it("all API calls in the pages go through it", () => {
    for (const f of ["app.js", "credits.js", "status.js", "search.js"]) {
      const s = read(f);
      expect(s, f).not.toMatch(/fetch\(\s*["'`]\/api\//);
    }
  });
});

describe("privacy page", () => {
  const h = read("privacy.html");
  it("is served by the static assets at /privacy and linked from every page footer", async () => {
    let seen = "";
    const env = { LAYER_CACHE: memoryKV(), ASSETS: { fetch: async (r: Request) => { seen = new URL(r.url).pathname; return new Response("ok"); } } } as unknown as Env;
    const res = await handleRequest(new Request("https://app.predatorwatch.org/privacy"), env, ctx);
    expect(res.status).toBe(200);
    expect(seen).toBe("/privacy");
    for (const f of ["index.html", "about.html", "status.html", "privacy.html"]) expect(read(f), f).toContain('href="/privacy"');
  });
  it("makes the claims the code supports", () => {
    expect(h).toMatch(/No accounts/);
    expect(h).toMatch(/No rancher data/);
    expect(h).toMatch(/not sent to Predator Watch/);
    expect(h).toMatch(/up to 7 days/);
    expect(h).toMatch(/U\.S\. Census Bureau Geocoder/);
    // The claims above hold in the code:
    const app = read("app.js");
    expect(app).not.toMatch(/fetch\([^)]*coords/);
    expect(read("search.js")).toMatch(/looksLikeAddress|address/);
    expect(readFileSync(join(__dirname, "..", "src", "index.ts"), "utf8")).toMatch(/sMaxAge: 7 \* 86400/);
    for (const f of ["index.html", "about.html", "status.html", "privacy.html"]) {
      expect(read(f)).not.toMatch(/googletagmanager|google-analytics|plausible|segment\.com|hotjar|doubleclick/i);
    }
  });
  it("follows the copy rules", () => {
    const text = h.replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/\bproducers?\b/i);
    expect(text).not.toMatch(/\bAI\b/);
    expect(text).toMatch(/Planned/);
  });
});

describe("Android app links", () => {
  it("serves /.well-known/assetlinks.json for the app id with a marked placeholder fingerprint", async () => {
    const env = { LAYER_CACHE: memoryKV() } as unknown as Env;
    const res = await handleRequest(new Request("https://app.predatorwatch.org/.well-known/assetlinks.json"), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("cache-control")).toMatch(/max-age=\d+/);
    const body = await res.json() as { relation: string[]; target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] } }[];
    const link = body[0]!;
    expect(link.relation).toEqual(["delegate_permission/common.handle_all_urls"]);
    expect(link.target.namespace).toBe("android_app");
    expect(link.target.package_name).toBe(APP_ID);
    expect(APP_ID).toBe("org.predatorwatch.app");
    expect(link.target.sha256_cert_fingerprints).toEqual([...ANDROID_CERT_FINGERPRINTS]);
    for (const f of ANDROID_CERT_FINGERPRINTS) expect(f).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    const src = readFileSync(join(__dirname, "..", "src", "config", "app.ts"), "utf8");
    expect(src).toMatch(/PLACEHOLDER: replace/);
    expect(PLACEHOLDER_FINGERPRINT).toMatch(/^(00:){31}00$/);
  });
});

describe("offline map", () => {
  it("draws saved agency layers over a plain background when the basemap cannot load", () => {
    const js = readFileSync(join(process.cwd(), "public/app.js"), "utf8");
    expect(js).toMatch(/let plainBasemap = navigator\.onLine === false;/);
    expect(js).toMatch(/type: "background"/);
    expect(js).toMatch(/map\.on\("error"[\s\S]{0,200}map\.setStyle\(plainStyle\(\)/);
    expect(js).toMatch(/map\.once\("style\.load", startOnce\)/);
  });
});
