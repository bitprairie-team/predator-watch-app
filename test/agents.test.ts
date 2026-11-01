import { describe, expect, it } from "vitest";
import { enforceCitations, FALLBACK_ANSWER, type Citation } from "../src/agents/citations";
import { validate } from "../src/agents/json-schema";
import { MockProvider, mockCall, mockText } from "../src/agents/providers/mock";
import { XaiProvider } from "../src/agents/providers/xai";
import { runAgent, type RunEvent } from "../src/agents/runner";
import { AgentError } from "../src/agents/types";
import { RANCHER_INSTRUCTIONS } from "../src/rancher/prompt";
import { RANCHER_TOOLS } from "../src/rancher/tools";
import { cellFor, sharedCells } from "../src/rancher/tiers";
import { ctxA, ctxB, ctxPublic, GROUP, NOW, OBS_B, sharedRecords, testService } from "./rancher-fixtures";
import { parseFenced } from "../src/guardrails/sanitize";

const collect = async (g: AsyncGenerator<RunEvent>) => {
  const out: RunEvent[] = [];
  for await (const e of g) out.push(e);
  return out;
};

describe("tool schemas", () => {
  it("every tool has an object input schema, a result schema, a scope, and is read-only", async () => {
    const { svc } = await testService();
    expect(svc.registry.list().map((t) => t.name).sort()).toEqual(RANCHER_TOOLS.map((t) => t.name).sort());
    for (const t of svc.registry.list()) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.readOnly).toBe(true);
      expect(t.scope).toMatch(/:read$/);
      expect(svc.registry.resultSchema(t).required).toEqual(["data", "sources"]);
    }
  });

  it("every tool's real output validates against its declared schema", async () => {
    const { svc } = await testService();
    for (const t of svc.registry.list()) {
      const r = await svc.registry.execute(t.name, {}, ctxA, svc.deps);
      expect(validate(svc.registry.resultSchema(t), r), t.name).toEqual([]);
    }
  });

  it("rejects input outside the schema before running the tool", async () => {
    const { svc } = await testService();
    await expect(svc.registry.execute("recent_predator_activity", { radius_miles: 5000 }, ctxA, svc.deps)).rejects.toMatchObject({ code: "invalid_input", status: 400 });
    await expect(svc.registry.execute("recent_predator_activity", { tenant_id: "tenant-b" }, ctxA, svc.deps)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(svc.registry.execute("nope_tool", {}, ctxA, svc.deps)).rejects.toMatchObject({ code: "unknown_tool" });
  });

  it("enforces scopes per tool", async () => {
    const { svc } = await testService();
    const narrow = { ...ctxA, scopes: ["alerts:read" as const] };
    expect(svc.registry.listFor(narrow).map((t) => t.name)).toEqual(["fire_weather_alerts"]);
    await expect(svc.registry.execute("recent_predator_activity", {}, narrow, svc.deps)).rejects.toMatchObject({ code: "forbidden", status: 403 });
    await expect(svc.registry.execute("fire_weather_alerts", {}, narrow, svc.deps)).resolves.toBeTruthy();
  });
});

describe("tenant isolation", () => {
  it("tenant A sees its own record exactly and never B's record, id, or notes", async () => {
    const { svc } = await testService();
    const r = await svc.registry.execute("recent_predator_activity", {}, ctxA, svc.deps);
    const d = r.data as { your_records: { id: string; lat: number }[]; shared_cells: { center: { lat: number; lon: number } }[] };
    expect(d.your_records.map((o) => o.id)).toEqual(["a-obs-1"]);
    expect(d.your_records[0]!.lat).toBe(41.8012);
    const text = JSON.stringify(r);
    expect(text).not.toContain("b-obs-1");
    expect(text).not.toContain("B private note");
    expect(text).not.toContain("tenant-b");
    expect(text).not.toContain(String(OBS_B.lat));
    // B's record is visible to A only as a generalized cell.
    expect(d.shared_cells).toHaveLength(1);
    expect(d.shared_cells[0]!.center.lat).not.toBe(OBS_B.lat);
  });

  it("a tool cannot be pointed at another tenant's ranch", async () => {
    const { svc } = await testService();
    const r = await svc.registry.execute("recent_predator_activity", { ranch_id: "ranch-b1" }, ctxA, svc.deps);
    expect(r.unknown).toMatch(/No ranch with id ranch-b1/);
    expect(r.sources).toEqual([]);
  });

  it("the audit log only lists the caller's tenant", async () => {
    const { svc } = await testService();
    await svc.registry.execute("fire_weather_alerts", {}, ctxA, svc.deps);
    await svc.registry.execute("fire_weather_alerts", {}, ctxB, svc.deps);
    await svc.registry.execute("weekly_summary", {}, ctxB, svc.deps);
    const a = await svc.audit.list(ctxA);
    const b = await svc.audit.list(ctxB);
    expect(a.map((e) => e.tenant_id)).toEqual(["tenant-a"]);
    expect(b.every((e) => e.tenant_id === "tenant-b")).toBe(true);
    expect(b).toHaveLength(2);
    const r = await svc.registry.execute("my_audit_log", {}, ctxA, svc.deps);
    expect(JSON.stringify(r)).not.toContain("tenant-b");
  });

  it("a tenant's own shared copies are not shown back to it as shared cells", async () => {
    const { svc } = await testService();
    const r = await svc.registry.execute("recent_predator_activity", {}, ctxB, svc.deps);
    const d = r.data as { shared_cells: unknown[]; your_records: { id: string }[] };
    expect(d.your_records.map((o) => o.id)).toEqual(["b-obs-1"]);
    // A's contribution (s4, 4 days old) is visible to B as a cell; B's own are not.
    expect(d.shared_cells).toHaveLength(1);
  });
});

describe("location tiers", () => {
  it("snaps shared records to a fixed 1-2 mile grid", () => {
    const a = cellFor(41.8123, -120.8877, 1.5);
    const b = cellFor(41.8124, -120.8876, 1.5);
    expect(a.cell_id).toBe(b.cell_id);
    const [w, s] = a.geometry.coordinates[0]![0]!;
    const [e, n] = a.geometry.coordinates[0]![2]!;
    expect((n! - s!) * 69.172).toBeCloseTo(1.5, 1);
    expect((e! - w!) * 69.172 * Math.cos((41.81 * Math.PI) / 180)).toBeCloseTo(1.5, 1);
  });

  it("clamps cell size and delay to the allowed ranges", async () => {
    const recs = await sharedRecords();
    const cells = sharedCells(recs, { ...GROUP, cell_miles: 0.01, delay_hours: 1 }, NOW);
    expect(cells.every((c) => c.cell_id.startsWith("c1:"))).toBe(true);
    // delay clamps to at least 48h: the 1-day-old record stays hidden.
    expect(cells.some((c) => c.report_count > 0 && c.latest_observed_on === NOW.toISOString().slice(0, 10))).toBe(false);
  });

  it("hides records newer than the delay and never shares den-flagged records", async () => {
    const cells = sharedCells(await sharedRecords(), GROUP, NOW);
    const days = cells.map((c) => c.latest_observed_on).sort();
    expect(days).toEqual(["2026-10-26", "2026-10-27"]); // s1 (5d) and s4 (4d); s2 (1d) delayed; s3 den
    expect(JSON.stringify(cells)).not.toContain("origin");
  });

  it("den season drops held-back cells silently, with no marker", async () => {
    const may = new Date("2026-05-15T12:00:00Z");
    const recs = (await sharedRecords()).map((r) => ({ ...r, observed_at: new Date(may.getTime() - 5 * 86400_000).toISOString() }));
    const hold = cellFor(recs[0]!.lat, recs[0]!.lon, 1.5).cell_id;
    const off = sharedCells(recs, { ...GROUP, holdback_cells: [hold] }, new Date("2026-10-15T12:00:00Z"));
    const on = sharedCells(recs, { ...GROUP, holdback_cells: [hold] }, may);
    const noHold = sharedCells(recs, GROUP, may);
    expect(noHold.find((c) => c.cell_id === hold)).toBeDefined();
    expect(off.find((c) => c.cell_id === hold)).toBeDefined();
    expect(on.find((c) => c.cell_id === hold)).toBeUndefined();
    expect(on).toHaveLength(noHold.length - 1);
    expect(JSON.stringify(on)).not.toMatch(/hold|den|hidden|withheld/i);
  });

  it("the public tier gets nothing private", async () => {
    const { svc } = await testService();
    const data = svc.deps.data(ctxPublic).data;
    await expect(data.ownObservations()).rejects.toMatchObject({ code: "not_entitled" });
    await expect(data.tenant()).rejects.toMatchObject({ code: "not_entitled" });
  });
});

describe("citations required", () => {
  const cat: Citation[] = [{ cite: "S1", id: "x", kind: "public-layer", title: "T", publisher: "P", url: null, observed_at: "2026-10-30", received_at: "2026-10-31" }];

  it("keeps answers with valid markers and strips invented ones", () => {
    const r = enforceCitations("Wolves were reported nearby [S1] and elsewhere [S9].", cat);
    expect(r.replaced).toBe(false);
    expect(r.text).toBe("Wolves were reported nearby [S1] and elsewhere.");
    expect(r.citations.map((c) => c.cite)).toEqual(["S1"]);
  });

  it("replaces an uncited answer with I don't know", () => {
    expect(enforceCitations("There are 4 wolves near you.", cat)).toEqual({ text: FALLBACK_ANSWER, citations: [], replaced: true });
    expect(enforceCitations("Probably fine [S2].", cat).replaced).toBe(true);
  });

  it("allows an honest I don't know without citations", () => {
    expect(enforceCitations("I don't know. No layer covers that area.", []).replaced).toBe(false);
  });

  it("the runner labels tool sources and enforces the rule on the final answer", async () => {
    const { svc } = await testService();
    const provider = new MockProvider([mockCall("fire_weather_alerts", {}), (req) => {
      const out = req.input.find((i) => i.type === "function_call_output") as { output: string };
      expect((parseFenced(out.output)!.payload as { sources: { cite: string }[] }).sources[0]!.cite).toBe("S1");
      return mockText("A Red Flag Warning covers your ranch [S1].");
    }]);
    const ev = await collect(runAgent({ provider, registry: svc.registry, deps: svc.deps, ctx: ctxA, instructions: RANCHER_INSTRUCTIONS, messages: [{ role: "user", content: "Any alerts?" }] }));
    const answer = ev.at(-1) as Extract<RunEvent, { type: "answer" }>;
    expect(answer.replaced).toBe(false);
    expect(answer.citations[0]!.title).toBe("Test weather alerts");
    expect(answer.citations[0]!.received_at).toBeTruthy();
    expect(provider.requests[0]!.instructions).toContain("I don't know");
    expect(provider.requests[0]!.tools.length).toBe(RANCHER_TOOLS.length);
  });

  it("the runner replaces an answer that cites nothing", async () => {
    const { svc } = await testService();
    const provider = new MockProvider([mockText("Wolves are definitely near your ranch.")]);
    const ev = await collect(runAgent({ provider, registry: svc.registry, deps: svc.deps, ctx: ctxA, instructions: "", messages: [{ role: "user", content: "wolves?" }] }));
    expect(ev.at(-1)).toMatchObject({ type: "answer", text: FALLBACK_ANSWER, replaced: true });
  });
});

describe("entitlement gate", () => {
  it("blocks the public plan and lapsed billing, and audits the denial", async () => {
    const { svc } = await testService();
    await expect(svc.registry.execute("fire_weather_alerts", {}, ctxPublic, svc.deps)).rejects.toMatchObject({ code: "not_entitled", status: 402 });
    const lapsed = { ...ctxA, tenantId: "tenant-l", userId: "user-l" };
    await expect(svc.registry.execute("fire_weather_alerts", {}, lapsed, svc.deps)).rejects.toMatchObject({ status: 402 });
    const log = await svc.audit.list(ctxPublic);
    expect(log[0]).toMatchObject({ outcome: "not_entitled", tool: "fire_weather_alerts" });
  });

  it("rate limits tool calls per tenant", async () => {
    const { svc } = await testService({ limits: { toolCallsPerMinute: 2, chatTurnsPerMinute: 1, voiceSessionsPerHour: 1 } });
    await svc.registry.execute("fire_weather_alerts", {}, ctxA, svc.deps);
    await svc.registry.execute("fire_weather_alerts", {}, ctxA, svc.deps);
    await expect(svc.registry.execute("fire_weather_alerts", {}, ctxA, svc.deps)).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    await expect(svc.registry.execute("fire_weather_alerts", {}, ctxB, svc.deps)).resolves.toBeTruthy();
  });
});

describe("rancher tools answer from data only", () => {
  it("reports wolf activity in the allotment with the boundary cited", async () => {
    const { svc } = await testService();
    const r = await svc.registry.execute("allotment_wolf_activity", {}, ctxA, svc.deps);
    expect(r.sources.map((s) => s.id)).toEqual(["allotment:allot-a1", "layer:test-wolf-cells", "tenant:observations", "shared:grp1"]);
    expect((r.data as { public_layers: { label: string }[] }).public_layers.map((f) => f.label)).toEqual(["Collar cell near home"]);
  });

  it("says unknown and Planned when no allotment, contacts, or documents are on file", async () => {
    const { svc } = await testService();
    const a = await svc.registry.execute("allotment_wolf_activity", {}, ctxB, svc.deps);
    expect(a.unknown).toBeTruthy();
    expect(a.planned).toBeTruthy();
    const c = await svc.registry.execute("agency_contacts_and_reporting", {}, ctxB, svc.deps);
    expect(c.unknown).toMatch(/won't guess/);
    const d = await svc.registry.execute("nonlethal_deterrents", { query: "guard dogs llamas" }, ctxA, svc.deps);
    expect(d.unknown).toBeTruthy();
    expect(d.sources).toEqual([]);
  });

  it("returns document passages with the document cited", async () => {
    const { svc } = await testService();
    const d = await svc.registry.execute("nonlethal_deterrents", { query: "fladry" }, ctxA, svc.deps);
    expect(d.sources[0]).toMatchObject({ kind: "document", publisher: "Example Extension Service", url: "https://example.invalid/fladry.pdf" });
  });

  it("explains freshness with observed and received times", async () => {
    const { svc } = await testService();
    const r = await svc.registry.execute("data_freshness", {}, ctxA, svc.deps);
    for (const s of r.sources) expect(s.received_at).toBeTruthy();
    expect((r.data as { private_tiers: string[] }).private_tiers.join(" ")).toMatch(/48 to 72 hour/);
  });
});

describe("xAI provider (no network)", () => {
  it("builds a Responses API request and parses function calls", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ output: [{ type: "function_call", call_id: "c1", name: "fire_weather_alerts", arguments: "{}" }] }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const p = new XaiProvider({ apiKey: "test-key", fetchImpl });
    const r = await p.respond({ instructions: "x", input: [{ type: "message", role: "user", content: "hi" }], tools: [{ name: "fire_weather_alerts", description: "d", parameters: { type: "object" } }] });
    expect(calls[0]!.url).toBe("https://api.x.ai/v1/responses");
    expect(calls[0]!.body).toMatchObject({ model: "grok-4.7", store: false, instructions: "x" });
    expect(r.functionCalls).toEqual([{ call_id: "c1", name: "fire_weather_alerts", arguments: "{}" }]);
  });

  it("mints a short-lived voice credential and never returns the API key", async () => {
    const fetchImpl = (async (url: string) => {
      expect(url).toBe("https://api.x.ai/v1/realtime/client_secrets");
      return new Response(JSON.stringify({ value: "ephemeral-123", expires_at: 1900000000 }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const s = await new XaiProvider({ apiKey: "secret-key", fetchImpl }).createSession({ instructions: "i", tools: [] });
    expect(s.protocols).toEqual(["xai-client-secret.ephemeral-123"]);
    expect(s.url).toContain("wss://api.x.ai/v1/realtime");
    expect(JSON.stringify(s)).not.toContain("secret-key");
  });

  it("refuses to start without a key", () => {
    expect(() => new XaiProvider({ apiKey: "" })).toThrow(AgentError);
  });
});
