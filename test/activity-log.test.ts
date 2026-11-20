// "What I did" records, the activity log, rancher overrides, and outbox edits.
import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";
import { MockProvider, mockCall, mockText } from "../src/agents/providers/mock";
import { listOutbox, outboxKey, runAgent, type OutboxItem } from "../src/agents/background";
import { agentDeps } from "../src/rancher/agents-service";
import { meetingPrep, morningDigest, newReportAlert } from "../src/rancher/background-agents";
import { ctxA, KEYS, NOW, seededStore, TENANT_A, testService, turnOn } from "./rancher-fixtures";
import type { MemoryStore } from "../src/agents/store";

const execCtx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const COORD = /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/;

async function setup(o: { provider?: MockProvider | null; now?: () => Date; store?: MemoryStore; agents?: Record<string, Record<string, unknown>> } = {}) {
  const store = o.store ?? (await seededStore());
  await turnOn(store, "tenant-a", o.agents ?? { morning_digest: { days: 7 }, new_report_alert: {}, meeting_prep: {} });
  const t = await testService({ store, provider: o.provider ?? null, now: o.now ?? (() => NOW) });
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
  return { ...t, go, deps: agentDeps(t.svc) };
}

function sse(text: string) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((b) => ({ event: b.match(/^event: (.+)$/m)?.[1], data: JSON.parse(b.match(/^data: (.+)$/m)?.[1] ?? "null") }));
}

describe("what I did: agent runs", () => {
  it("each run writes a record: data read with names, sources with received times, rules, outcome", async () => {
    const { deps, go } = await setup();
    const r = await runAgent(morningDigest, ctxA, deps, "manual");
    expect(r.activity_id).toBeTruthy();
    const { body } = await go(`/api/ranch/activity/${r.activity_id}`);
    const rec = body.record;
    expect(rec.kind).toBe("agent_run");
    expect(rec.actor).toBe("agent:morning_digest");
    expect(rec.title).toMatch(/^Morning digest, 2026-10-31/);
    expect(rec.outcome).toMatch(/^Wrote it from \d+ sources?, with \d+ items?\.$/);
    expect(rec.read.map((x: any) => x.tool)).toEqual(["allotment_wolf_activity", "fire_weather_alerts", "data_freshness"]);
    expect(rec.read[0].title).toBe("Wolf activity in my allotment");
    expect(rec.read[0].detail).toBe("allotment North Bench, last 7 days");
    expect(rec.read[1].detail).toBe("ranch Home place, within 50 miles");
    expect(rec.sources.length).toBeGreaterThan(0);
    expect(rec.sources.every((s: any) => "received_at" in s && s.publisher)).toBe(true);
    expect(rec.rules.join("\n")).toMatch(/Ran because you pressed Run now/);
    expect(rec.rules.join("\n")).toMatch(/Read only the data this job is allowed to read: Wolf activity in my allotment, Fire and weather alerts near me/);
    expect(rec.rules.join("\n")).toMatch(/up to 12 lookups per run and 3 runs a day/);
    expect(rec.rules.join("\n")).toMatch(/facts need a source/);
    expect(JSON.stringify(rec)).not.toMatch(COORD);
  });

  it("a stopped run says why under skipped", async () => {
    const { deps, go, store } = await setup();
    await store.put("killswitch:tenant:tenant-a", { agents: true, reason: "Paused by the owner." });
    const r = await runAgent(morningDigest, ctxA, deps, "manual");
    const rec = (await go(`/api/ranch/activity/${r.activity_id}`)).body.record;
    expect(rec.outcome).toBe("Paused by the owner.");
    expect(rec.skipped).toEqual([{ what: "This run", why: "Paused by the owner." }]);
    expect(rec.read).toEqual([]);
  });

  it("a skipped alert says nothing was new", async () => {
    const { deps, go } = await setup();
    await runAgent(newReportAlert, ctxA, deps, "manual");
    const r = await runAgent(newReportAlert, ctxA, deps, "manual");
    expect(r.status).toBe("skipped");
    expect((await go(`/api/ranch/activity/${r.activity_id}`)).body.record.outcome).toBe("No new reports since the last check.");
  });

  it("output check changes show up as plain rules", async () => {
    const { deps, go } = await setup({ agents: { test_agent: {} } });
    const def = {
      ...morningDigest,
      id: "test_agent",
      tools: ["data_freshness"],
      async run(x: any) {
        const f = await x.tool("data_freshness", {});
        const cite = { ...f.sources[0], cite: "S1" };
        return { title: "t", body: `Layer note [S1]. The den is at 44.123456, -117.654321 [S1].`, citations: [cite] };
      },
    };
    const r = await runAgent(def as never, ctxA, deps, "manual");
    const rec = (await go(`/api/ranch/activity/${r.activity_id}`)).body.record;
    expect(rec.rules).toContain("Held back exact coordinates that were not from your own records.");
  });

  it("the log lists newest first, filters by kind, stays per account, and exports as CSV", async () => {
    const { deps, go } = await setup();
    await runAgent(morningDigest, ctxA, deps, "manual");
    await go("/api/ranch/settings/agents/meeting_prep", { method: "PUT", body: JSON.stringify({ on: false }) });
    const all = (await go("/api/ranch/activity")).body.records;
    expect(all.length).toBe(2);
    expect(all[0].at >= all[1].at).toBe(true);
    expect((await go("/api/ranch/activity?kind=agent_run")).body.records.map((r: any) => r.kind)).toEqual(["agent_run"]);
    expect((await go("/api/ranch/activity?kind=nope")).res.status).toBe(400);
    expect((await go("/api/ranch/activity", { key: KEYS.b })).body.records).toEqual([]);
    expect((await go(`/api/ranch/activity/${all[0].id}`, { key: KEYS.b })).res.status).toBe(404);
    const exp = await go("/api/ranch/export/activity.csv");
    expect(exp.res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(exp.res.headers.get("content-disposition")).toMatch(/attachment; filename="activity-2026-10-31.csv"/);
    expect(exp.body.split("\r\n")[0]).toBe('"at","kind","who","title","outcome","data read","sources","rules","skipped"');
    expect(exp.body).toMatch(/Wolf activity in my allotment \(allotment North Bench, last 7 days\)/);
  });
});

describe("what I did: assistant answers", () => {
  it("a chat answer carries its record in the done event and in the log", async () => {
    const provider = new MockProvider([mockCall("recent_predator_activity", { days: 7 }), mockText("Your records show a wolf sighting 2 days ago [S2].")]);
    const { go } = await setup({ provider });
    const { res, body } = await go("/api/assistant/chat", { method: "POST", key: KEYS.a, body: JSON.stringify({ messages: [{ role: "user", content: "Any wolves near me this week?" }] }) });
    expect(res.status).toBe(200);
    const done = sse(body).at(-1)!.data;
    const rec = done.what_i_did;
    expect(rec.kind).toBe("answer");
    expect(rec.title).toBe("Question: Any wolves near me this week?");
    expect(rec.outcome).toMatch(/^Answered with 1 source\.$/);
    expect(rec.read).toEqual([{ tool: "recent_predator_activity", title: "Recent predator activity near my ranch", detail: "last 7 days" }]);
    expect(rec.sources[0].title).toMatch(/Your ranch records/);
    expect(rec.rules[0]).toMatch(/Checked the question/);
    expect((await go(`/api/ranch/activity/${rec.id}`, { key: KEYS.a })).body.record.id).toBe(rec.id);
  });

  it("a decline says what was declined and why", async () => {
    const { go } = await setup({ provider: new MockProvider([mockText("unused")]) });
    const { body } = await go("/api/assistant/chat", { method: "POST", key: KEYS.a, body: JSON.stringify({ messages: [{ role: "user", content: "Is it legal for me to shoot a wolf that is chasing my cattle?" }] }) });
    const rec = sse(body).at(-1)!.data.what_i_did;
    expect(rec.kind).toBe("decline");
    expect(rec.outcome).toBe("Declined: the question asked for legal advice.");
    expect(rec.skipped[0]).toEqual({ what: "Your question", why: "It asked for legal advice, which the assistant does not give." });
  });

  it("voice declines and voice lookups are logged too", async () => {
    const { go } = await setup({ provider: new MockProvider() });
    const d = await go("/api/assistant/voice/guard", { method: "POST", key: KEYS.a, body: JSON.stringify({ stage: "input", text: "How many milligrams of penicillin for a calf?" }) });
    expect(d.body.action).toBe("decline");
    const rec = (await go(`/api/ranch/activity/${d.body.activity_id}`, { key: KEYS.a })).body.record;
    expect(rec.kind).toBe("decline");
    expect(rec.title).toMatch(/^Voice: /);
    const t = await go("/api/assistant/tools/data_freshness", { method: "POST", key: KEYS.a, body: "{}" });
    const rec2 = (await go(`/api/ranch/activity/${t.body.activity_id}`, { key: KEYS.a })).body.record;
    expect(rec2.title).toMatch(/^Voice lookup: What the data means/);
    expect(rec2.read[0].tool).toBe("data_freshness");
  });
});

describe("overrides: dismiss, mark wrong, correct, snooze", () => {
  async function digestItem(s: Awaited<ReturnType<typeof setup>>) {
    const r = await runAgent(morningDigest, ctxA, s.deps, "manual");
    const rec = (await s.go(`/api/ranch/activity/${r.activity_id}`)).body.record;
    const item = rec.items.find((i: any) => /Collar cell near home/.test(i.text));
    expect(item).toBeTruthy();
    return { r, rec, item };
  }
  const act = (s: Awaited<ReturnType<typeof setup>>, rec: any, item: any, b: Record<string, unknown>, key?: string) =>
    s.go(`/api/ranch/items/morning_digest/${item.id}`, { method: "POST", key, body: JSON.stringify({ activity_id: rec.id, ...b }) });

  it("dismissed items are left out of later runs and listed as skipped", async () => {
    const s = await setup();
    const { rec, item, r } = await digestItem(s);
    expect(r.body).toMatch(/Collar cell near home/);
    const res = await act(s, rec, item, { action: "dismiss" });
    expect(res.res.status).toBe(200);
    expect(res.body.item.status).toBe("dismiss");
    const r2 = await runAgent(morningDigest, ctxA, s.deps, "manual");
    expect(r2.body).not.toMatch(/Collar cell near home/);
    expect(r2.body).toMatch(/North Bench, last 7 days/);
    const rec2 = (await s.go(`/api/ranch/activity/${r2.activity_id}`)).body.record;
    expect(rec2.skipped[0].why).toBe("You dismissed this item.");
    expect(rec2.skipped[0].what).toMatch(/Collar cell near home/);
    expect(rec2.items.find((i: any) => i.id === item.id).status).toBe("dismiss");
    // The override itself is in the log.
    expect((await s.go("/api/ranch/activity?kind=override")).body.records[0].title).toBe("You dismissed an item from Morning activity digest");
    // Restore brings it back.
    await act(s, rec, item, { action: "restore" });
    expect((await runAgent(morningDigest, ctxA, s.deps, "manual")).body).toMatch(/Collar cell near home/);
  });

  it("marked wrong is left out and remembered as wrong", async () => {
    const s = await setup();
    const { rec, item } = await digestItem(s);
    await act(s, rec, item, { action: "wrong", note: "That collar was removed in spring." });
    const r2 = await runAgent(morningDigest, ctxA, s.deps, "manual");
    expect(r2.body).not.toMatch(/Collar cell near home/);
    expect((await s.go("/api/ranch/overrides")).body.overrides[0]).toMatchObject({ action: "wrong", note: "That collar was removed in spring.", agent: "morning_digest" });
  });

  it("a correction stays with the item, in the rancher's words", async () => {
    const s = await setup();
    const { rec, item } = await digestItem(s);
    expect((await act(s, rec, item, { action: "correct" })).res.status).toBe(400); // needs a note
    await act(s, rec, item, { action: "correct", note: "This cell is the neighbor's pasture, not ours." });
    const r2 = await runAgent(morningDigest, ctxA, s.deps, "manual");
    expect(r2.body).toMatch(/Collar cell near home/);
    expect(r2.body).toMatch(/Your corrections:\n- This cell is the neighbor's pasture, not ours\. \(about: - Collar cell near home/);
  });

  it("a snoozed item comes back after the snooze ends", async () => {
    let t = NOW.getTime();
    const s = await setup({ now: () => new Date(t) });
    const { rec, item } = await digestItem(s);
    await act(s, rec, item, { action: "snooze", days: 1 });
    expect((await runAgent(morningDigest, ctxA, s.deps, "manual")).body).not.toMatch(/Collar cell near home/);
    t += 2 * 86400_000;
    const r3 = await runAgent(morningDigest, ctxA, s.deps, "manual");
    expect(r3.body).toMatch(/Collar cell near home/);
    expect(r3.items!.find((i) => i.id === item.id)!.status).toBe("shown");
  });

  it("overrides need settings:write, a known item from your own record, and a valid action", async () => {
    const s = await setup();
    const { rec, item } = await digestItem(s);
    expect((await act(s, rec, item, { action: "dismiss" }, KEYS.a)).res.status).toBe(403);
    expect((await act(s, rec, item, { action: "explode" })).res.status).toBe(400);
    expect((await act(s, rec, item, { action: "snooze", days: 500 })).res.status).toBe(400);
    expect((await s.go(`/api/ranch/items/morning_digest/${"0".repeat(16)}`, { method: "POST", body: JSON.stringify({ activity_id: rec.id, action: "dismiss" }) })).res.status).toBe(404);
    expect((await s.go(`/api/ranch/items/new_report_alert/${item.id}`, { method: "POST", body: JSON.stringify({ activity_id: rec.id, action: "dismiss" }) })).res.status).toBe(404);
  });

  it("an alert whose new items were all dismissed is skipped, with the reason", async () => {
    const s = await setup();
    const r = await runAgent(newReportAlert, ctxA, s.deps, "manual");
    expect(r.status).toBe("ok");
    const rec = (await s.go(`/api/ranch/activity/${r.activity_id}`)).body.record;
    for (const it of rec.items) await s.go(`/api/ranch/items/new_report_alert/${it.id}`, { method: "POST", body: JSON.stringify({ activity_id: rec.id, action: "dismiss" }) });
    // Forget what was seen so the same items come back as new.
    await s.store.put("agentstate:tenant-a:new_report_alert", null);
    const r2 = await runAgent(newReportAlert, ctxA, s.deps, "manual");
    expect(r2.status).toBe("skipped");
    expect(r2.reason).toMatch(/every new item matched something you dismissed/);
  });
});

describe("outbox: edit before approval", () => {
  async function pending() {
    const store = await seededStore();
    await store.put("tenant:tenant-a", { ...TENANT_A, contacts: [{ ...TENANT_A.contacts[0]!, email: "pat@example.invalid" }] });
    const s = await setup({ store });
    const r = await runAgent(meetingPrep, ctxA, s.deps, "manual");
    expect(r.outbox_id).toBeTruthy();
    return { ...s, id: r.outbox_id! };
  }
  const patch = (s: Awaited<ReturnType<typeof pending>>, b: unknown, key?: string) => s.go(`/api/ranch/outbox/${s.id}`, { method: "PATCH", key, body: JSON.stringify(b) });

  it("edits title, body, and recipient; keeps the original; approval uses the edit", async () => {
    const s = await pending();
    const res = await patch(s, { title: "Packet for Thursday", body: "Hi Pat, notes for Thursday attached below.", to: "pat.other@example.invalid" });
    expect(res.res.status).toBe(200);
    expect(res.body.item.original.to).toBe("pat@example.invalid");
    expect(res.body.item.edits[0].fields).toEqual(["title", "body", "to"]);
    const ok = await s.go(`/api/ranch/outbox/${s.id}/approve`, { method: "POST", body: JSON.stringify({ confirm: true }) });
    expect(ok.body.item).toMatchObject({ status: "approved", title: "Packet for Thursday", body: "Hi Pat, notes for Thursday attached below." });
    expect(ok.body.item.delivery.to).toBe("pat.other@example.invalid");
    const log = (await s.go("/api/ranch/activity?kind=outbox")).body.records.map((r: any) => r.title);
    // Both happen at the same test clock time, so their order in the log is not fixed.
    expect([...log].sort()).toEqual(['You approved "Packet for Thursday"', 'You edited "Packet for Thursday"']);
    expect((await s.svc.audit.list({ ...ctxA, client: "x" }, 50)).some((e) => e.tool === "outbox.edit")).toBe(true);
  });

  it("refuses blocked text and other people's exact coordinates, and saves nothing", async () => {
    const s = await pending();
    expect((await patch(s, { body: "You can legally shoot the wolf on your allotment." })).res.status).toBe(422);
    expect((await patch(s, { body: "Meet at 45.123456, -116.654321 tomorrow." })).res.status).toBe(422);
    const item = await s.store.get<OutboxItem>(outboxKey("tenant-a", s.id));
    expect(item!.edits).toBeUndefined();
  });

  it("allows the rancher's own record coordinates", async () => {
    const s = await pending();
    const obs = (await s.store.get<{ lat: number; lon: number }>((await s.store.list("obs:tenant-a:", 1))[0]!))!;
    expect((await patch(s, { body: `Our sighting was at ${obs.lat}, ${obs.lon}.` })).res.status).toBe(200);
  });

  it("needs outbox:approve, valid fields, and a pending item", async () => {
    const s = await pending();
    expect((await patch(s, { body: "x" }, KEYS.a)).res.status).toBe(403);
    expect((await patch(s, {})).res.status).toBe(400);
    expect((await patch(s, { to: "not-an-email" })).res.status).toBe(400);
    expect((await patch(s, { body: "x".repeat(9000) })).res.status).toBe(400);
    await s.go(`/api/ranch/outbox/${s.id}/reject`, { method: "POST", body: "{}" });
    expect((await patch(s, { body: "too late" })).res.status).toBe(409);
    expect((await listOutbox(s.store, ctxA, NOW))[0]!.status).toBe("rejected");
  });

  it("the outbox item downloads as text", async () => {
    const s = await pending();
    const r = await s.go(`/api/ranch/export/outbox/${s.id}.txt`);
    expect(r.res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(r.body).toMatch(/^To: Pat Example, State wildlife agency, district office <pat@example.invalid>\nSubject: Meeting packet for Pat Example/);
  });
});

describe("what I did: settings in plain words", () => {
  it("describes settings and lookups without raw keys or empty values", async () => {
    const { describeArgs } = await import("../src/agents/activity");
    const names = { r1: "Home place", a1: "North Bench" };
    expect(describeArgs({ days: 7, hour_utc: 14, areas: [] }, names)).toBe("last 7 days, written at 14:00 UTC");
    expect(describeArgs({ radius_miles: 5, areas: ["a1"], interval_minutes: 60 }, names)).toBe("within 5 miles, only North Bench, checks every 60 minutes");
    expect(describeArgs({ topics: ["a", "b"], contact_index: 0 }, names)).toBe("2 topics of yours, contact 1 on file");
    expect(describeArgs({}, names)).toBe("no filters");
  });
});
