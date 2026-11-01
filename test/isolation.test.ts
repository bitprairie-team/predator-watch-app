// Data isolation per data-sharing agreement: who may read a sharing group,
// whose reports it includes, and that ids from storage can't cross tenants.
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/agents/auth";
import type { MemoryStore } from "../src/agents/store";
import { originHash } from "../src/rancher/data";
import type { GroupMember, SharingGroupPolicy } from "../src/rancher/model";
import { handleRequest } from "../src/index";
import { ctxA, ctxB, daysAgo, groupWithMembers, KEYS, OBS_A, seededStore, TENANT_A, testService } from "./rancher-fixtures";

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const ARGS = { radius_miles: 25, days: 14, include_shared: true };

async function sharedFor(edit?: (g: SharingGroupPolicy, s: MemoryStore) => Promise<void> | void, ctx = ctxA) {
  const store = await seededStore();
  const g = await groupWithMembers();
  if (edit) await edit(g, store);
  await store.put("group:grp1", g);
  const { svc } = await testService({ store });
  const r = await svc.registry.execute("recent_predator_activity", ARGS, ctx, svc.deps);
  const data = r.data as { shared_cells: unknown[]; gaps: string[] };
  return { cells: data.shared_cells, gaps: data.gaps, sources: r.sources };
}
async function setMember(g: SharingGroupPolicy, tenant: string, patch: Partial<GroupMember>) {
  const o = await originHash(tenant);
  g.members = g.members!.map((m) => (m.origin === o ? { ...m, ...patch } : m));
}

describe("isolation: sharing agreement", () => {
  it("an active member sees other members' generalized cells", async () => {
    const r = await sharedFor();
    expect(r.cells.length).toBeGreaterThan(0);
    expect(r.sources.some((s) => s.kind === "shared-data")).toBe(true);
  });
  it("no member list on file: nothing shared, and the gap is stated", async () => {
    const r = await sharedFor((g) => { delete g.members; });
    expect(r.cells).toEqual([]);
    expect(r.gaps.join(" ")).toMatch(/no data-sharing agreement or member list/);
  });
  it("no agreement on file: nothing shared", async () => {
    const r = await sharedFor((g) => { delete g.agreement; });
    expect(r.cells).toEqual([]);
  });
  it("expired agreement: nothing shared", async () => {
    const r = await sharedFor((g) => { g.agreement = { ...g.agreement!, expires_at: daysAgo(1) }; });
    expect(r.cells).toEqual([]);
    expect(r.gaps.join(" ")).toMatch(/agreement expired/);
  });
  it.each([
    ["suspended", { status: "suspended" as const }],
    ["left", { status: "left" as const }],
    ["ended", { ends_at: daysAgo(1) }],
    ["not started", { joined_at: daysAgo(-2) }],
    ["no read right", { can_read: false }],
  ])("reader %s: nothing shared", async (_n, patch) => {
    const r = await sharedFor((g) => setMember(g, "tenant-a", patch));
    expect(r.cells).toEqual([]);
    expect(r.gaps.join(" ")).toMatch(/membership is not active/);
  });
  it("reader not on the member list: nothing shared", async () => {
    const r = await sharedFor(async (g) => { const o = await originHash("tenant-a"); g.members = g.members!.filter((m) => m.origin !== o); });
    expect(r.cells).toEqual([]);
  });
  it.each([
    ["left", { status: "left" as const }],
    ["suspended", { status: "suspended" as const }],
    ["no contribute right", { can_contribute: false }],
    ["joined after the reports", { joined_at: daysAgo(2) }],
  ])("contributor %s: their reports are dropped", async (_n, patch) => {
    const r = await sharedFor((g) => setMember(g, "tenant-b", patch));
    expect(r.cells).toEqual([]);
  });
  it("reports from a tenant who is not a member are dropped", async () => {
    const r = await sharedFor(async (g, s) => {
      await setMember(g, "tenant-b", { status: "left" });
      await s.put("shared:grp1:x1", { id: "x1", group: "grp1", origin: await originHash("tenant-x"), species: "Gray wolf", kind: "depredation", lat: 41.81, lon: -120.9, observed_at: daysAgo(5), received_at: daysAgo(5) });
    });
    expect(r.cells).toEqual([]);
  });
  it("a record filed under one group but naming another is dropped", async () => {
    const r = await sharedFor(async (g, s) => {
      await setMember(g, "tenant-b", { status: "left" });
      await s.put("shared:grp1:x2", { id: "x2", group: "grp2", origin: await originHash("tenant-b"), species: "Gray wolf", kind: "depredation", lat: 41.81, lon: -120.9, observed_at: daysAgo(5), received_at: daysAgo(5) });
    });
    expect(r.cells).toEqual([]);
  });
  it("a group policy stored under the wrong id is ignored", async () => {
    const r = await sharedFor((g) => { g.id = "grp2"; });
    expect(r.cells).toEqual([]);
  });
  it("unsafe group ids in a tenant record are ignored", async () => {
    const store = await seededStore();
    await store.put("tenant:tenant-a", { ...TENANT_A, sharing_groups: ["grp1:x", "../grp1", "GRP1 "] });
    const { svc } = await testService({ store });
    const r = await svc.registry.execute("recent_predator_activity", ARGS, ctxA, svc.deps);
    expect((r.data as { shared_cells: unknown[] }).shared_cells).toEqual([]);
  });
  it("a member never sees their own reports as shared", async () => {
    const r = await sharedFor();
    // s4 is tenant A's own report at OBS_A; A sees it only in your_records.
    expect(JSON.stringify(r.cells)).not.toContain(String(OBS_A.lat));
  });
  it("the HTTP tool route enforces the agreement too", async () => {
    const store = await seededStore();
    const g = await groupWithMembers();
    await setMember(g, "tenant-a", { status: "suspended" });
    await store.put("group:grp1", g);
    const t = await testService({ store });
    const headers = new Headers({ authorization: `Bearer ${KEYS.a}`, host: "localhost", "content-type": "application/json" });
    const res = await handleRequest(new Request("http://localhost/api/assistant/tools/recent_predator_activity", { method: "POST", headers, body: JSON.stringify({ arguments: ARGS }) }), t.env as never, execCtx, t.overrides);
    const body = (await res.json()) as { data: { shared_cells: unknown[]; gaps: string[] } };
    expect(body.data.shared_cells).toEqual([]);
    expect(body.data.gaps.join(" ")).toMatch(/membership is not active/);
  });
});

describe("isolation: tenant data", () => {
  it("another tenant's ranch id returns nothing of theirs", async () => {
    const { svc } = await testService();
    const r = await svc.registry.execute("recent_predator_activity", { ...ARGS, ranch_id: "ranch-b1" }, ctxA, svc.deps);
    expect(JSON.stringify(r)).not.toMatch(/B private note|41\.8123/);
  });
  it("another tenant's uploaded documents are not visible", async () => {
    const store = await seededStore();
    await store.put("tdoc:tenant-b:secret", { id: "secret", title: "B private plan", publisher: "B", url: "https://example.invalid/b", published_at: "2026-01-01", retrieved_at: daysAgo(1), topics: ["nonlethal-deterrents"], excerpts: ["B private plan text about fladry."] });
    const { svc } = await testService({ store });
    const a = await svc.registry.execute("nonlethal_deterrents", { query: "fladry" }, ctxA, svc.deps);
    expect(JSON.stringify(a)).not.toContain("B private plan");
    const b = await svc.registry.execute("nonlethal_deterrents", { query: "fladry" }, ctxB, svc.deps);
    expect(JSON.stringify(b)).toContain("B private plan");
  });
  it("audit entries are per tenant", async () => {
    const { svc } = await testService();
    await svc.registry.execute("agency_contacts_and_reporting", {}, ctxB, svc.deps);
    const a = await svc.registry.execute("my_audit_log", {}, ctxA, svc.deps);
    expect(JSON.stringify(a.data)).not.toContain("tenant-b");
  });
  it("access keys pointing at an unsafe tenant id are refused", async () => {
    const store = await seededStore();
    const key = "pwk_badTenantKey_xxxxxxxxxxxxxxxx";
    await store.put(`accesskey:${await sha256Hex(key)}`, { tenant_id: "tenant-a:obs", user_id: "u", scopes: ["rancher:read"], created_at: daysAgo(1) });
    await store.put("tenant:tenant-a:obs", { ...TENANT_A, id: "tenant-a:obs" });
    const t = await testService({ store });
    const headers = new Headers({ authorization: `Bearer ${key}`, host: "localhost" });
    const res = await handleRequest(new Request("http://localhost/api/assistant/me", { headers }), t.env as never, execCtx, t.overrides);
    expect(res.status).toBe(401);
  });
});
