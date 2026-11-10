// Text size: small is the new default, medium is the old default, and the
// panel scales with it on mouse screens while touch keeps 44 px targets.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(join(__dirname, "..", "public", f), "utf8");

/** Runs prefs.js against a fake page with the given saved values. */
function runPrefs(saved: Record<string, string>) {
  const store = new Map(Object.entries(saved));
  const attrs = new Map<string, string>();
  const root = { setAttribute: (k: string, v: string) => attrs.set(k, v), getAttribute: (k: string) => attrs.get(k) ?? null, removeAttribute: (k: string) => attrs.delete(k) };
  const sandbox = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, String(v)), removeItem: (k: string) => store.delete(k) },
    document: { documentElement: root, readyState: "complete", querySelectorAll: () => [], addEventListener: () => {} },
    window: { matchMedia: () => ({ matches: false }), addEventListener: () => {} },
    location: { hash: "" },
    history: { replaceState: () => {} },
  };
  (sandbox as Record<string, unknown>).window = { ...sandbox.window };
  runInNewContext(read("prefs.js"), sandbox);
  return { text: attrs.get("data-text"), store };
}

describe("text size: small is the default", () => {
  it("defines four steps: small 87.5%, medium 100% (the old default), large, largest", () => {
    const brand = read("brand.css");
    expect(brand).toMatch(/:root\[data-text="0"\] \{ font-size: 87\.5%; \}/);
    expect(brand).not.toMatch(/:root\[data-text="1"\] \{ font-size/);
    const prefs = read("prefs.js");
    expect(prefs).toMatch(/"0": \["S", "Default"\], "1": \["M", "Medium text"\], "2": \["L", "Large text"\], "3": \["XL", "Largest text"\]/);
  });
  it("new visitors get small; an old saved A maps to the new default; old A+ and A++ keep their size", () => {
    expect(runPrefs({}).text).toBe("0");
    const old = runPrefs({ "pw-text": "1" });
    expect(old.text).toBe("0");
    expect(old.store.get("pw-text")).toBeUndefined();
    expect(old.store.get("pw-text-v")).toBe("2");
    expect(runPrefs({ "pw-text": "2" }).text).toBe("2");
    expect(runPrefs({ "pw-text": "3" }).text).toBe("3");
    // After the move, medium (1) is a real choice and stays.
    expect(runPrefs({ "pw-text": "1", "pw-text-v": "2" }).text).toBe("1");
  });
  it("scales the panel in rem on mouse screens and keeps 44 px targets on touch screens", () => {
    const css = read("styles.css");
    const block = css;
    // Control heights are in rem on mouse screens, so they follow the text size...
    expect(block).toMatch(/--ctl: calc\(2rem \+ 4px\);/);
    expect(block).toMatch(/\.group-toggle \{[^}]*min-height: var\(--ctl\);/);
    // ...and a fixed 44 px on touch screens.
    expect(block).toMatch(/@media \(pointer: coarse\) \{\n\s+:root \{ --ctl: 44px;/);
    expect(block).toMatch(/@media \(pointer: coarse\) \{[\s\S]*\.panel-prefs \.pref-btn \{ min-height: 44px; min-width: 44px; \}/);
    expect(block).toMatch(/font-size: max\(1rem, 16px\)/);
    expect(css).toMatch(/--panel-w: min\(22\.5rem, 50vw\)/);
  });
  it("makes 'View and text size' a small quiet control", () => {
    const css = read("styles.css");
    expect(css).toMatch(/\.panel-prefs > summary, :root\[data-mode="simple"\] \.panel-prefs > summary \{[^}]*font: 500 var\(--t-body\)/);
    expect(css).toMatch(/\.fold > summary:focus-visible \{ outline: 2px solid var\(--focus\)/);
  });
});
