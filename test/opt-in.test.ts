// The assistant and every agent are off until the rancher turns them on.
import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";
import { MockProvider, mockText } from "../src/agents/providers/mock";
import { runAgent } from "../src/agents/background";
import { agentDeps, runScheduledAgents } from "../src/rancher/agents-service";
import { morningDigest, newReportAlert } from "../src/rancher/background-agents";
import { getPrefs } from "../src/rancher/prefs";
import { ctxA, KEYS, NOW, seededStore, TENANT_A, testService } from "./rancher-fixtures";
import type { MemoryStore } from "../src/agents/store";

const execCtx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

/** A store where tenant-a has never touched Settings: no preferences at all. */
async function freshStore(): Promise<MemoryStore> {
  const store = await seededStore();
  await store.put("prefs:tenant-a", null);
  return store;
}

async function svcWith(store: MemoryStore, provider: MockProvider | null = null, now = () => NOW) {
  const t = await testService({ store, provider, now });
  const go = async (path: string, init: RequestInit & { key?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${init.key ?? KEYS.ops}`);
    headers.set("content-type", "application/json");
    const res = await handleRequest(new Request(`https://x.test${path}`, { ...init, headers }), t.env as never, execCtx, t.overrides);
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { res, body };
  };
  return { ...t, go };
}

const chat = { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "Any wolves near me this week?" }] }) };

describe("opt-in: the assistant is off by default", () => {
  it("a new account has nothing on", async () => {
    const store = await freshStore();
    const p = await getPrefs(store, "tenant-a");
    expect(p.assistant.on).toBe(false);
    expect(p.agents).toEqual({});
  });

  it("chat, voice, and assistant tool calls answer 403 turned_off with a pointer to Settings", async () => {
    const { go } = await svcWith(await freshStore(), new MockProvider([mockText("hi [S1]")]));
    for (const [path, init] of [
      ["/api/assistant/chat", chat],
      ["/api/assistant/voice/session", { method: "POST" }],
      ["/api/assistant/voice/guard", { method: "POST", body: JSON.stringify({ stage: "input", text: "hi" }) }],
      ["/api/assistant/tools/data_freshness", { method: "POST", body: "{}" }],
    ] as const) {
      const { res, body } = await go(path, { ...init, key: KEYS.a });
      expect(res.status, path).toBe(403);
      expect(body.error).toBe("turned_off");
      expect(body.message).toMatch(/Turn it on in Ranch tools, Settings/);
      expect(body.message).toMatch(/also works by hand/);
    }
  });

  it("/me still works and says the assistant is off", async () => {
    const { go } = await svcWith(await freshStore());
    const { res, body } = await go("/api/assistant/me", { key: KEYS.a });
    expect(res.status).toBe(200);
    expect(body.assistant_on).toBe(false);
  });

  it("a lapsed plan still gets 402 before the on/off check", async () => {
    const { go } = await svcWith(await freshStore(), new MockProvider());
    expect((await go("/api/assistant/chat", { ...chat, key: KEYS.lapsed })).res.status).toBe(402);
  });

  it("turning it on needs settings:write; then chat answers", async () => {
    const { go } = await svcWith(await freshStore(), new MockProvider([mockText("No wolf activity in the layers I can read [S1].")]));
    const denied = await go("/api/ranch/settings/assistant", { method: "PUT", key: KEYS.a, body: JSON.stringify({ on: true }) });
    expect(denied.res.status).toBe(403);
    expect(denied.body.message).toMatch(/settings:write/);
    const ok = await go("/api/ranch/settings/assistant", { method: "PUT", body: JSON.stringify({ on: true }) });
    expect(ok.res.status).toBe(200);
    expect(ok.body.assistant.on).toBe(true);
    expect((await go("/api/assistant/chat", { ...chat, key: KEYS.a })).res.status).toBe(200);
    // And off again.
    await go("/api/ranch/settings/assistant", { method: "PUT", body: JSON.stringify({ on: false }) });
    expect((await go("/api/assistant/chat", { ...chat, key: KEYS.a })).res.status).toBe(403);
  });

  it("on must be a boolean", async () => {
    const { go } = await svcWith(await freshStore());
    expect((await go("/api/ranch/settings/assistant", { method: "PUT", body: JSON.stringify({ on: "yes" }) })).res.status).toBe(400);
  });

  it("the kill switch still wins over a rancher's on", async () => {
    const store = await seededStore();
    await store.put("killswitch:global", { assistant: true, reason: "Down for maintenance." });
    const { go } = await svcWith(store, new MockProvider());
    expect((await go("/api/assistant/chat", { ...chat, key: KEYS.a })).res.status).toBe(503);
    const s = await go("/api/ranch/settings");
    expect(s.body.assistant).toMatchObject({ on: true, stopped: "Down for maintenance." });
  });
});

describe("opt-in: agents are off by default", () => {
  it("the owner's tenant defaults never turn an agent on", async () => {
    const store = await freshStore();
    await store.put("tenant:tenant-a", { ...TENANT_A, agents: { morning_digest: { enabled: true }, new_report_alert: { enabled: true } } });
    const { svc } = await svcWith(store);
    expect(await runScheduledAgents(svc)).toEqual([]);
    const r = await runAgent(morningDigest, ctxA, agentDeps(svc), "manual");
    expect(r.status).toBe("disabled");
    expect(r.reason).toMatch(/off\. Turn it on in Settings, or build it by hand/);
    expect(r.tool_calls).toBe(0);
  });

  it("settings lists each agent off, with its limits, what it reads, and its by-hand paths", async () => {
    const { go } = await svcWith(await freshStore());
    const { res, body } = await go("/api/ranch/settings");
    expect(res.status).toBe(200);
    expect(body.assistant.on).toBe(false);
    expect(body.agents.map((a: any) => [a.id, a.on])).toEqual([
      ["morning_digest", false],
      ["new_report_alert", false],
      ["meeting_prep", false],
    ]);
    for (const a of body.agents) {
      expect(a.by_hand.length).toBeGreaterThan(0);
      expect(a.reads.length).toBeGreaterThan(0);
      expect(a.limits.maxToolCalls).toBeGreaterThan(0);
    }
    expect(body.off_by_default).toMatch(/off until you turn it on/);
  });

  it("turning one agent on runs only that one, and the change is in the activity log", async () => {
    const { go, svc } = await svcWith(await freshStore());
    const on = await go("/api/ranch/settings/agents/morning_digest", { method: "PUT", body: JSON.stringify({ on: true }) });
    expect(on.res.status).toBe(200);
    expect((await runScheduledAgents(svc)).map((r) => r.agent)).toEqual(["morning_digest"]);
    const log = await go("/api/ranch/activity?kind=setting");
    expect(log.body.records[0].title).toBe("Morning activity digest: turned on");
    expect(log.body.records[0].actor).toBe("you");
  });

  it("changing settings needs settings:write and a web session", async () => {
    const { go } = await svcWith(await freshStore());
    expect((await go("/api/ranch/settings/agents/morning_digest", { method: "PUT", key: KEYS.a, body: JSON.stringify({ on: true }) })).res.status).toBe(403);
  });

  it("validates thresholds and alert areas, and refuses unknown settings", async () => {
    const { go } = await svcWith(await freshStore());
    const put = (settings: unknown) => go("/api/ranch/settings/agents/new_report_alert", { method: "PUT", body: JSON.stringify({ settings }) });
    expect((await put({ radius_miles: 0 })).res.status).toBe(400);
    expect((await put({ radius_miles: 51 })).res.status).toBe(400);
    expect((await put({ radius_miles: 2.5 })).res.status).toBe(400);
    expect((await put({ interval_minutes: 5 })).res.status).toBe(400);
    expect((await put({ hour_utc: 3 })).res.status).toBe(400); // not a setting for this agent
    expect((await put({ areas: ["ranch-b1"] })).res.status).toBe(400); // another tenant's ranch
    expect((await put({ deliver_to: { channel: "email", to: "not an email" } })).res.status).toBe(400);
    const ok = await put({ radius_miles: 5, areas: ["allot-a1"] });
    expect(ok.res.status).toBe(200);
    expect(ok.body.agent.settings).toMatchObject({ radius_miles: 5, areas: ["allot-a1"] });
    // null clears back to the default
    const cleared = await put({ radius_miles: null });
    expect(cleared.body.agent.settings.radius_miles).toBeUndefined();
  });

  it("a changed alert distance and areas are respected on the next run", async () => {
    const { go, svc } = await svcWith(await freshStore());
    await go("/api/ranch/settings/agents/new_report_alert", { method: "PUT", body: JSON.stringify({ on: true, settings: { radius_miles: 7 } }) });
    const r = await runAgent(newReportAlert, ctxA, agentDeps(svc), "manual");
    expect(r.status === "ok" || r.status === "skipped").toBe(true);
    const rec = (await go(`/api/ranch/activity/${r.activity_id}`)).body.record;
    expect(rec.read.find((x: any) => x.tool === "recent_predator_activity").detail).toMatch(/within 7 miles/);
    expect(rec.rules.join(" ")).toMatch(/Used your settings: within 7 miles/);
    // Only the allotment as the alert area: no ranch radius lookups at all.
    await go("/api/ranch/settings/agents/new_report_alert", { method: "PUT", body: JSON.stringify({ settings: { areas: ["allot-a1"] } }) });
    const r2 = await runAgent(newReportAlert, ctxA, agentDeps(svc), "manual");
    const rec2 = (await go(`/api/ranch/activity/${r2.activity_id}`)).body.record;
    expect(rec2.read.map((x: any) => x.tool)).toEqual(["allotment_wolf_activity"]);
    expect(rec2.read[0].detail).toMatch(/allotment North Bench/);
  });

  it("snooze: the scheduler skips a snoozed agent until the date, and 0 ends it", async () => {
    let t = NOW.getTime();
    const { go, svc } = await svcWith(await freshStore(), null, () => new Date(t));
    await go("/api/ranch/settings/agents/morning_digest", { method: "PUT", body: JSON.stringify({ on: true }) });
    const sn = await go("/api/ranch/settings/agents/morning_digest/snooze", { method: "POST", body: JSON.stringify({ days: 2 }) });
    expect(sn.res.status).toBe(200);
    expect(sn.body.agent.snooze_until).toBe(new Date(t + 2 * 86400_000).toISOString());
    expect(await runScheduledAgents(svc)).toEqual([]);
    t += 3 * 86400_000;
    expect((await runScheduledAgents(svc)).map((r) => r.agent)).toEqual(["morning_digest"]);
    await go("/api/ranch/settings/agents/morning_digest/snooze", { method: "POST", body: JSON.stringify({ days: 5 }) });
    await go("/api/ranch/settings/agents/morning_digest/snooze", { method: "POST", body: JSON.stringify({ days: 0 }) });
    expect((await getPrefs(svc.store, "tenant-a")).agents.morning_digest!.snooze_until).toBeNull();
    expect((await go("/api/ranch/settings/agents/morning_digest/snooze", { method: "POST", body: JSON.stringify({ days: 99 }) })).res.status).toBe(400);
  });

  it("kill switches still stop an agent the rancher turned on", async () => {
    const { go, svc, store } = await svcWith(await freshStore());
    await go("/api/ranch/settings/agents/morning_digest", { method: "PUT", body: JSON.stringify({ on: true }) });
    await store.put("killswitch:agent:morning_digest", { agents: true, reason: "Fixing a bug." });
    const [r] = await runScheduledAgents(svc);
    expect(r!.status).toBe("killed");
    const s = await go("/api/ranch/settings");
    expect(s.body.agents[0]).toMatchObject({ on: true, stopped: "Fixing a bug." });
  });

  it("preferences are per account", async () => {
    const { go, svc } = await svcWith(await freshStore());
    await go("/api/ranch/settings/agents/morning_digest", { method: "PUT", body: JSON.stringify({ on: true }) });
    expect((await getPrefs(svc.store, "tenant-b")).agents).toEqual({});
  });
});

describe("setting changes are logged in plain words", () => {
  it("names what changed, with units and area names", async () => {
    const { settingWords } = await import("../src/rancher/ranch-routes");
    const profile = { ranches: [{ id: "r1", name: "Home place", allotments: [{ id: "a1", name: "North Bench" }] }] };
    expect(settingWords("new_report_alert", { radius_miles: 10 }, { radius_miles: 5, areas: ["a1"] }, profile)).toEqual([
      "Alert distance from each ranch: 5 miles",
      "Alert areas: North Bench",
    ]);
    expect(settingWords("new_report_alert", { radius_miles: 5 }, {}, profile)).toEqual(["Alert distance from each ranch: back to the default (10 miles)"]);
    expect(settingWords("morning_digest", { days: 2 }, { days: 2 }, profile)).toEqual([]);
    expect(settingWords("morning_digest", {}, { deliver_to: { channel: "email", to: "me@example.invalid" } }, profile)).toEqual(["Also send it to: me@example.invalid"]);
  });
});
