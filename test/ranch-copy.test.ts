// Copy rules for the rancher-facing pages and messages: plain words, no "AI",
// "rancher" not "producer", no em dashes, sentence case, and the BitPrairie
// style (Plex Sans 400/500/600, paper, ink, leather, light by default).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RANCHER_AGENTS } from "../src/rancher/background-agents";
import { MANUAL_PATHS, MANUAL_TOOL_VIEWS } from "../src/rancher/manual";
import { SETTING_RULES } from "../src/rancher/prefs";

const root = resolve(__dirname, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");
const UI = ["public/ranch.html", "public/ranch.js", "public/rancher.js", "public/index.html"];
const SERVER = ["src/rancher/ranch-routes.ts", "src/rancher/prefs.ts", "src/rancher/manual.ts", "src/agents/activity.ts", "src/agents/overrides.ts", "src/agents/background.ts", "src/rancher/background-agents.ts", "src/rancher/routes.ts", "src/rancher/agents-service.ts"];
const PROPER = new Set(["I", "Predator", "Watch", "Planned", "UTC", "Settings", "Ranch", "By", "CSV"]);

function sentenceCase(s: string): boolean {
  const words = s.replace(/<[^>]+>|\$\{[^}]*\}/g, " ").split(/\s+/).filter(Boolean);
  return words.every((w, i) => i === 0 || /[.?!]$/.test(words[i - 1]!) || !/^[A-Z][a-z]/.test(w) || PROPER.has(w.replace(/[^A-Za-z]/g, "")));
}

describe("ranch tools copy", () => {
  it.each([...UI, ...SERVER])("%s: no AI, no producer, no em dash", (f) => {
    const s = read(f);
    expect(s).not.toMatch(/\bAI\b|\bA\.I\./);
    expect(s).not.toMatch(/\bproducers?\b/i);
    expect(s).not.toMatch(/\u2014/);
  });

  it("headings, buttons, and labels on the Ranch tools page are in sentence case", () => {
    const js = read("public/ranch.js") + read("public/ranch.html");
    const found = [
      ...[...js.matchAll(/<h[1-3][^>]*>([^<$]+)<\/h[1-3]>/g)].map((m) => m[1]!),
      ...[...js.matchAll(/<button[^>]*>([^<$]+)<\/button>/g)].map((m) => m[1]!),
      ...[...js.matchAll(/\b(?:label|title): "([^"]+)"/g)].map((m) => m[1]!),
      ...[...js.matchAll(/data-screen="[^"]+">([^<]+)</g)].map((m) => m[1]!),
    ];
    expect(found.length).toBeGreaterThan(30);
    for (const s of found) expect(sentenceCase(s), s).toBe(true);
  });

  it("agent titles, setting labels, and by-hand labels are in sentence case and plain", () => {
    const all = [
      ...RANCHER_AGENTS.flatMap((a) => [a.title, a.description]),
      ...Object.values(SETTING_RULES).flatMap((r) => Object.values(r).map((x) => x.label)),
      ...Object.values(MANUAL_PATHS).flatMap((ps) => ps.flatMap((p) => [p.ui, p.job])),
      ...Object.values(MANUAL_TOOL_VIEWS),
    ];
    for (const s of all) {
      expect(sentenceCase(s), s).toBe(true);
      expect(s).not.toMatch(/\bAI\b|\u2014|producer|revolution|seamless|powerful|smart\b/i);
    }
  });

  it("unbuilt features are marked Planned", () => {
    const js = read("public/ranch.js");
    expect(js).toMatch(/Sending is Planned/);
    expect(js).toMatch(/Account sign-in is Planned/);
  });

  it("the page uses the BitPrairie style", () => {
    const css = read("public/ranch.css");
    expect(css).toMatch(/font-family: "IBM Plex Sans"/);
    for (const hex of ["#f2ede4", "#141416", "#6b4a2e"]) expect(css.toLowerCase()).toContain(hex);
    expect(css).toMatch(/color-scheme: light/);
    // Only weights 400, 500, and 600; no mono caps labels or pill badges.
    for (const m of css.matchAll(/font-weight:\s*(\d+)(?:\s+(\d+))?/g)) for (const w of [m[1], m[2]].filter(Boolean)) expect(["400", "500", "600"]).toContain(w);
    expect(css).not.toMatch(/text-transform:\s*uppercase|monospace|border-radius:\s*(999|9999)px/);
    expect(read("public/ranch.html")).not.toMatch(/googleapis|gstatic|cdn/);
    expect(readFileSync(join(root, "public/fonts/ibm-plex-sans-latin-var.woff2")).length).toBeGreaterThan(20000);
    expect(read("public/fonts/OFL-IBM-Plex-Sans.txt")).toMatch(/SIL OPEN FONT LICENSE Version 1.1/);
  });

  it("each screen has at most one main action", () => {
    const js = read("public/ranch.js");
    // Every screen function renders its own main.innerHTML; count filled buttons per screen.
    const screens = js.split(/\nasync function show|\nfunction showSignIn/).slice(1);
    expect(screens.length).toBeGreaterThan(8);
    for (const s of screens) expect((s.match(/class="main-action"/g) ?? []).length, s.slice(0, 40)).toBeLessThanOrEqual(1);
  });

  it("the public panel points to Ranch tools and shows what each answer did", () => {
    const js = read("public/rancher.js");
    expect(js).toMatch(/assistant_on === false/);
    expect(js).toMatch(/What I did/);
    expect(read("public/index.html")).toMatch(/href="\/ranch.html"/);
  });
});

describe("ranch tools page reads the fields the server sends", () => {
  it("agent limits use the server's field names", () => {
    const js = readFileSync(join(root, "public/ranch.js"), "utf8");
    const bg = readFileSync(join(root, "src/agents/background.ts"), "utf8");
    for (const m of js.matchAll(/limits\.([a-zA-Z_]+)/g)) expect(bg, m[1]).toMatch(new RegExp(`\\b${m[1]}:`));
  });
});
