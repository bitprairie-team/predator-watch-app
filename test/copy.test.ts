import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function files(dir: string, exts: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "vendor" || n === "node_modules" || n === "data" ? [] : files(p, exts);
    return exts.test(n) ? [p] : [];
  });
}

const ROOTS = ["src", "public", "docs", "schemas"];
const EXTS = /\.(ts|js|html|css|md|json)$/;
const BANNED_PHRASE = /intelligence and realtime systems/i;
const BANNED_AI = /\bA\.I\.\b|\bartificial intelligence\b/;
// Standalone "AI" as a product word, not a letter pair inside another word.
const BANNED_AI_WORD = /(^|[^A-Za-z])AI([^A-Za-z]|$)/;

describe("copy rules (Nov 9, 2026)", () => {
  it("does not use the old 'intelligence and realtime systems' phrase, or AI wording", () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(root, EXTS)) {
        const text = readFileSync(f, "utf8");
        if (BANNED_PHRASE.test(text)) hits.push(`${f}: old phrase`);
        if (BANNED_AI.test(text)) hits.push(`${f}: A.I. / artificial intelligence`);
        // The test file itself may mention the ban.
        if (f.endsWith("copy.test.ts")) continue;
        if (BANNED_AI_WORD.test(text) && !f.includes("copy.test")) hits.push(`${f}: standalone AI`);
      }
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });

  it("names the allowed phrase where the private docs describe that kind of system", () => {
    const text = readFileSync("docs/private-version.md", "utf8");
    expect(text).toMatch(/realtime intelligence systems/);
    expect(text).not.toMatch(/intelligence and realtime systems/);
  });
});
