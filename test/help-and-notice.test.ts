// Plain declines with a short list of what the assistant can help with, and a
// notice that is always visible in the app.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MockProvider } from "../src/agents/providers/mock";
import { ASSISTANT_NOTICE, CAN_HELP_WITH, POLICY, GUARD_CATEGORIES } from "../src/guardrails/policy";
import { handleRequest } from "../src/index";
import { KEYS, testService } from "./rancher-fixtures";

const execCtx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

async function req(path: string, init: RequestInit = {}, key = KEYS.a) {
  const { env, overrides } = await testService({ provider: new MockProvider() });
  return handleRequest(new Request(`http://localhost${path}`, { ...init, headers: { authorization: `Bearer ${key}`, host: "localhost" } }), env as never, execCtx, overrides);
}
async function chatDone(q: string) {
  const res = await req("/api/assistant/chat", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: q }] }) });
  const done = (await res.text()).split("\n\n").find((b) => b.startsWith("event: done"))!;
  return JSON.parse(done.match(/^data: (.+)$/m)![1]!) as { text: string; refused: boolean };
}

describe("what I can help with", () => {
  it("/me returns the list and the notice", async () => {
    const me = (await (await req("/api/assistant/me")).json()) as { notice: string; can_help_with: string[] };
    expect(me.notice).toBe(ASSISTANT_NOTICE);
    expect(me.can_help_with).toEqual([...CAN_HELP_WITH]);
  });
  it.each([
    ["Is it legal for me to shoot a wolf that is chasing my calves?", "legal"],
    ["What dose of penicillin should I give a bitten heifer?", "vet"],
    ["Should I buy more livestock insurance this year?", "financial"],
  ])("a chat decline names the right professional and lists what I can help with: %s", async (q) => {
    const d = await chatDone(q);
    expect(d.refused).toBe(true);
    expect(d.text).toMatch(/I can help with:\n- Wolf activity near your ranch/);
    expect(d.text).toMatch(/General ranching and livestock-protection questions/);
  });
  it("an ordinary question gets no decline list", async () => {
    const d = await chatDone("Any wolf activity near my ranch this week?");
    expect(d.refused).toBe(false);
    expect(d.text).not.toMatch(/I can help with:/);
  });
  it("every decline points somewhere: an authority or an offer", () => {
    for (const c of GUARD_CATEGORIES) expect(`${POLICY[c].authority ?? ""}${POLICY[c].offer}`.length).toBeGreaterThan(10);
  });
});

describe("copy rules for the help list and notice", () => {
  const copy = [...CAN_HELP_WITH, ASSISTANT_NOTICE].join("\n");
  it("says rancher, not producer, and doesn't say AI", () => {
    expect(copy).not.toMatch(/\bproducers?\b/i);
    expect(copy).not.toMatch(/\bA\.?I\b/);
    expect(copy).toMatch(/intelligence and realtime systems/);
  });
  it("names no states or competitors and no numbers", () => {
    expect(copy).not.toMatch(/\b(Oregon|Washington|Idaho|Montana|Wyoming|California|Colorado|Nevada|Utah|Arizona|New Mexico)\b/);
    expect(copy).not.toMatch(/\d/);
  });
  it("the page shows the same notice before the script loads", () => {
    const html = readFileSync(join(resolve(__dirname, ".."), "public/index.html"), "utf8");
    expect(html).toContain(ASSISTANT_NOTICE);
    expect(html).toMatch(/id="rancher-can-help"/);
  });
});
