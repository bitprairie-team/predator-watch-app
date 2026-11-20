// Manual parity: every agent job can be done by hand, with the assistant and
// every agent off (and even with the kill switches thrown). No feature is
// reachable only through the assistant.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";
import { RANCHER_AGENTS } from "../src/rancher/background-agents";
import { MANUAL_PATHS, MANUAL_TOOL_VIEWS } from "../src/rancher/manual";
import { KEYS, NOW, seededStore, testService } from "./rancher-fixtures";

const execCtx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const root = resolve(__dirname, "..");
const ranchJs = readFileSync(join(root, "public", "ranch.js"), "utf8");
const ranchHtml = readFileSync(join(root, "public", "ranch.html"), "utf8");

async function allOff() {
  const store = await seededStore();
  await store.put("prefs:tenant-a", null);
  await store.put("killswitch:global", { assistant: true, agents: true, reason: "Everything automated is off." });
  const t = await testService({ store, now: () => NOW });
  const go = async (method: string, path: string, body?: unknown, key = KEYS.ops) => {
    const res = await handleRequest(
      new Request(`https://x.test${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
      t.env as never,
      execCtx,
      t.overrides,
    );
    const text = await res.text();
    let json: any = text;
    try {
      json = JSON.parse(text);
    } catch {}
    return { res, body: json, text };
  };
  return { ...t, go };
}

const bodyFor = (method: string, path: string) =>
  method === "GET" ? undefined : path.includes("/settings/agents/") ? { settings: { radius_miles: 5, areas: ["allot-a1"] } } : path.includes("/data/") ? { arguments: {} } : { settings: {} };

describe("manual parity", () => {
  it("every agent has a by-hand path list", () => {
    expect(Object.keys(MANUAL_PATHS).sort()).toEqual(RANCHER_AGENTS.map((a) => a.id).sort());
  });

  it.each(RANCHER_AGENTS.map((a) => [a.id, a] as const))("%s: every tool it reads has a by-hand view", (id, def) => {
    const paths = MANUAL_PATHS[id]!.map((p) => p.path);
    for (const tool of def.tools) expect(paths, `${id} reads ${tool}`).toContain(`/api/ranch/data/${tool}`);
    expect(paths).toContain(`/api/ranch/manual/${id}`);
  });

  const all = Object.entries(MANUAL_PATHS).flatMap(([agent, ps]) => ps.map((p) => [agent, p.method, p.path, p.ui] as const));
  it.each(all)("%s: %s %s works with the assistant and every agent off", async (_agent, method, path) => {
    const s = await allOff();
    const r = await s.go(method, path, bodyFor(method, path));
    expect(r.res.status, r.text.slice(0, 300)).toBe(200);
    // The assistant really is off.
    expect((await s.go("POST", "/api/assistant/tools/data_freshness", {}, KEYS.a)).res.status).toBe(503);
  });

  it("the by-hand jobs need only read access (no settings, run, or approve scopes)", async () => {
    const s = await allOff();
    for (const def of RANCHER_AGENTS) expect((await s.go("POST", `/api/ranch/manual/${def.id}`, { settings: {} }, KEYS.a)).res.status).toBe(200);
  });

  it("every lookup the assistant can make has a by-hand view that works", async () => {
    const s = await allOff();
    const tools = (await s.go("GET", "/api/assistant/me", undefined, KEYS.a)).res.status; // killed: 503
    expect(tools).toBe(503);
    const registry = s.svc.registry.listFor({ tenantId: "tenant-a", userId: "user-a", plan: "rancher", scopes: ["rancher:read"], client: "web" });
    expect(registry.length).toBeGreaterThan(0);
    for (const t of registry) {
      expect(MANUAL_TOOL_VIEWS[t.name], `${t.name} has a by-hand view`).toBeTruthy();
      const r = await s.go("POST", `/api/ranch/data/${t.name}`, { arguments: {} }, KEYS.a);
      expect(r.res.status, t.name).toBe(200);
    }
  });

  it("the Ranch tools page has a control for every by-hand path and lookup", () => {
    for (const ps of Object.values(MANUAL_PATHS))
      for (const p of ps) {
        expect(ranchJs + ranchHtml, `label "${p.ui}"`).toContain(p.ui);
        const route = p.path.replace(/\?.*$/, "");
        const m = route.match(/^(\/api\/ranch\/(?:data|manual)\/)([a-z_]+)$/);
        if (m) {
          expect(ranchJs, `route ${route}`).toContain(m[1]);
          expect(ranchJs, `route ${route}`).toContain(`"${m[2]}"`);
        } else expect(ranchJs, `route ${route}`).toContain(route);
      }
    for (const label of Object.values(MANUAL_TOOL_VIEWS)) expect(ranchJs + ranchHtml, `label "${label}"`).toContain(label);
    for (const tool of Object.keys(MANUAL_TOOL_VIEWS)) expect(ranchJs, tool).toContain(`lookup("${tool}"`);
  });

  it("a by-hand job is logged as yours, with the same checks", async () => {
    const s = await allOff();
    const r = await s.go("POST", "/api/ranch/manual/morning_digest", { settings: { days: 7 } }, KEYS.a);
    expect(r.body.run.status).toBe("ok");
    expect(r.body.run.trigger).toBe("by_hand");
    expect(r.body.run.footer).toMatch(/Sources:/);
    const rec = (await s.go("GET", `/api/ranch/activity/${r.body.run.activity_id}`, undefined, KEYS.a)).body.record;
    expect(rec.kind).toBe("manual");
    expect(rec.actor).toBe("you");
    expect(rec.rules[0]).toMatch(/You started this by hand/);
    // Not in the agent run list: it was not an agent.
    expect((await s.go("GET", "/api/ranch/agents/runs", undefined, KEYS.a)).body.runs).toEqual([]);
  });

  it("a by-hand alert check does not change what the agent has already told you", async () => {
    const s = await allOff();
    await s.go("POST", "/api/ranch/manual/new_report_alert", { settings: {} }, KEYS.a);
    expect(await s.store.get("agentstate:tenant-a:new_report_alert")).toBeNull();
    const again = await s.go("POST", "/api/ranch/manual/new_report_alert", { settings: {} }, KEYS.a);
    expect(again.body.run.status).toBe("ok");
  });

  it("by-hand settings are validated the same way", async () => {
    const s = await allOff();
    expect((await s.go("POST", "/api/ranch/manual/new_report_alert", { settings: { radius_miles: 500 } }, KEYS.a)).res.status).toBe(400);
  });

  it("the packet downloads as text with its sources", async () => {
    const s = await allOff();
    const r = await s.go("POST", "/api/ranch/manual/meeting_prep?format=txt", { settings: { topics: ["Spring turnout dates"] } }, KEYS.a);
    expect(r.res.headers.get("content-disposition")).toMatch(/attachment; filename="meeting_prep-2026-10-31.txt"/);
    expect(r.text).toMatch(/^Meeting packet for Pat Example, 2026-10-31/);
    expect(r.text).toMatch(/Topics you want to raise \(your words\):\n- Spring turnout dates/);
    expect(r.text).toMatch(/Sources:/);
  });

  it("exports: CSV cells that look like formulas are made safe", async () => {
    const { csvCell } = await import("../src/rancher/ranch-routes");
    expect(csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
    expect(csvCell('say "hi"')).toBe(`"say ""hi"""`);
    const s = await allOff();
    const r = await s.go("GET", "/api/ranch/export/records.csv", undefined, KEYS.a);
    expect(r.text.split("\r\n")[0]).toBe('"id","ranch_id","species","kind","observed_at","received_at","lat","lon","notes","shared"');
    expect(r.text).toMatch(/Two animals at the east gate/);
    expect(r.text).not.toMatch(/b-obs-1/);
  });

  it("ranch tools need an access key and the rancher plan", async () => {
    const s = await allOff();
    expect((await s.go("GET", "/api/ranch/settings", undefined, "pwk_doesnotexist_000000000000")).res.status).toBe(401);
    expect((await s.go("GET", "/api/ranch/settings", undefined, KEYS.pub)).res.status).toBe(402);
    expect((await s.go("GET", "/api/ranch/me", undefined, KEYS.pub)).body.entitled).toBe(false);
  });
});
