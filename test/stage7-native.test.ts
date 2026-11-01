// Stage 7: the iOS and Android apps (Capacitor), the Trusted Web Activity
// option for Google Play, and the native web bundle.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../capacitor.config";
import { APP_ID, APP_NAME, APP_SHORT_NAME } from "../src/config/app";
import { APP_COLORS } from "../src/config/palette";
// @ts-expect-error plain .mjs build script, no types
import { nativeCsp, nativeHtml } from "../scripts/build-native.mjs";

const root = join(__dirname, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

describe("Capacitor config", () => {
  it("uses the store name, the app id and the palette colors", () => {
    expect(config.appId).toBe(APP_ID);
    expect(config.appName).toBe(APP_NAME);
    expect(config.webDir).toBe("dist/native");
    expect(config.backgroundColor).toBe(APP_COLORS.background);
    expect(config.ios?.backgroundColor).toBe(APP_COLORS.background);
    expect(config.android?.backgroundColor).toBe(APP_COLORS.background);
    expect((config.plugins?.SplashScreen as { backgroundColor: string }).backgroundColor).toBe(APP_COLORS.background);
  });
  it("native projects carry the same id and name", () => {
    expect(read("android/app/build.gradle")).toContain(`applicationId "${APP_ID}"`);
    expect(read("android/app/src/main/res/values/strings.xml")).toContain(`<string name="app_name">${APP_NAME}</string>`);
    expect(read("ios/App/App.xcodeproj/project.pbxproj")).toContain(`PRODUCT_BUNDLE_IDENTIFIER = ${APP_ID};`);
    expect(read("ios/App/App/Info.plist")).toContain(`<string>${APP_NAME}</string>`);
  });
  it("asks for location in plain words, and only while in use", () => {
    const plist = read("ios/App/App/Info.plist");
    expect(plist).toMatch(/<key>NSLocationWhenInUseUsageDescription<\/key>\s*<string>Predator Watch uses your location only to center the map on where you are\. Your location stays on this device/);
    expect(plist).not.toMatch(/NSLocationAlways/);
    const manifest = read("android/app/src/main/AndroidManifest.xml");
    expect(manifest).toContain("android.permission.ACCESS_COARSE_LOCATION");
    expect(manifest).toContain("android.permission.ACCESS_FINE_LOCATION");
    expect(manifest).not.toContain("ACCESS_BACKGROUND_LOCATION");
  });
  it("has icons and launch screens made from the logo", () => {
    for (const f of ["assets/icon-only.png", "assets/icon-foreground.png", "assets/icon-background.png", "assets/splash.png", "assets/splash-dark.png"]) expect(existsSync(join(root, f)), f).toBe(true);
    expect(existsSync(join(root, "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"))).toBe(true);
    expect(readdirSync(join(root, "ios/App/App/Assets.xcassets/Splash.imageset")).some((f) => f.includes("dark"))).toBe(true);
    expect(existsSync(join(root, "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png"))).toBe(true);
    expect(existsSync(join(root, "android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml"))).toBe(true);
  });
  it("no signing keys or store credentials are in the repo", () => {
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(join(root, dir))) {
        const p = join(dir, f);
        if (["node_modules", ".git", "build", ".gradle", "dist", ".wrangler"].includes(f)) continue;
        if (statSync(join(root, p)).isDirectory()) walk(p);
        else if (/\.(jks|keystore|p12|p8|mobileprovision|pem|key)$|^key\.properties$|^google-services\.json$/.test(f)) bad.push(p);
      }
    };
    for (const d of ["android", "ios", "docs", "assets"]) walk(d);
    expect(bad).toEqual([]);
    const gi = read(".gitignore");
    for (const p of ["*.jks", "*.keystore", "*.p12", "*.p8", "key.properties"]) expect(gi).toContain(p);
  });
});

describe("native web bundle (scripts/build-native.mjs)", () => {
  const headers = read("public/_headers");
  const csp = nativeCsp(headers, "https://api.example") as string;
  it("keeps the site's CSP, adds the API origin, drops header-only directives", () => {
    expect(csp).toMatch(/script-src 'self';/);
    expect(csp).toMatch(/connect-src 'self' [^;]*https:\/\/api\.example/);
    expect(csp).not.toMatch(/frame-ancestors|upgrade-insecure-requests/);
  });
  it("points the pages at the public API, uses .html links and drops the API preload", () => {
    const out = nativeHtml(read("public/index.html"), csp, "https://api.example") as string;
    expect(out).toContain('<meta name="pw-api-base" content="https://api.example">');
    expect(out).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(out).not.toMatch(/rel="preload" href="\/api\//);
    expect(out).toContain('href="/about.html#sources"');
    expect(out).toContain('href="/status.html"');
    expect(out).not.toMatch(/href="\/(about|status|privacy)["#]/);
    expect(out).toContain('href="https://api.example/ogc"');
    const about = nativeHtml(read("public/about.html"), csp, "https://api.example") as string;
    expect(about).not.toMatch(/href="\/(api|ogc)[/"]/);
  });
  it("leaves the service worker and _headers out, and the apps share the public address", () => {
    const src = read("scripts/build-native.mjs");
    expect(src).toMatch(/SKIP = new Set\(\["_headers", "sw\.js"/);
    expect(read("public/app.js")).toMatch(/NATIVE \? `\$\{API_BASE\}\/\$\{location\.hash\}` : location\.href/);
  });
});

describe("Trusted Web Activity option (Google Play)", () => {
  const twa = JSON.parse(read("docs/app-store/twa/twa-manifest.json"));
  it("matches the app id, name, host and colors", () => {
    expect(twa.packageId).toBe(APP_ID);
    expect(twa.name).toBe(APP_NAME);
    expect(twa.launcherName).toBe(APP_SHORT_NAME);
    expect(twa.host).toBe("app.predatorwatch.org");
    expect(twa.themeColor).toBe(APP_COLORS.theme);
    expect(twa.backgroundColor).toBe(APP_COLORS.background);
    expect(twa.enableNotifications).toBe(false);
    expect(twa.signingKey.path).toMatch(/\.keystore$/);
  });
});
