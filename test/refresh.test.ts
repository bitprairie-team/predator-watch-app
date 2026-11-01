import { describe, expect, it } from "vitest";
import {
  appendRunLog, KeepLastGood, readData, readRunLog, readStatus, refreshDue, refreshSource,
  RUN_LOG_SIZE, validateResult, withTimeout, type Env, type RunLogEntry,
} from "../src/cache";
import type { AdapterResult, SourceAdapter } from "../src/adapters/types";
import { statusReport } from "../src/index";
import { HttpError } from "../src/lib/http";
import { Registry } from "../src/registry";
import { SOURCES } from "../src/config/sources";
import type { NormalizedFeature } from "../src/schema";
import { memoryKV } from "./helpers";

const base = new Registry().get("wdfw-wolf-packs-current")!;
const feature = (id: string): NormalizedFeature =>
  ({ type: "Feature", id, geometry: { type: "Point", coordinates: [-117, 47] }, properties: { label: id } }) as unknown as NormalizedFeature;
const ok = (n: number): AdapterResult => ({ changed: true, features: Array.from({ length: n }, (_, i) => feature(`f${i}`)), sourceUpdatedMs: null, validator: null });

/** An adapter whose answers are scripted, one per call. */
function scripted(answers: (AdapterResult | Error | "hang")[], config: Partial<SourceAdapter["config"]> = {}) {
  let calls = 0;
  const adapter: SourceAdapter = {
    config: { ...base.config, ...config } as SourceAdapter["config"],
    endpoint: base.endpoint,
    async load() {
      const a = answers[Math.min(calls++, answers.length - 1)]!;
      if (a === "hang") return new Promise<AdapterResult>(() => {});
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return { adapter, calls: () => calls };
}
const fast = { force: true, retryDelayMs: 1 } as const;
const env = (): Env => ({ LAYER_CACHE: memoryKV() });

describe("keep last good", () => {
  it("keeps the stored copy and records the error when the source fails", async () => {
    const e = env();
    const { adapter } = scripted([ok(3), new HttpError("HTTP 503 from x", 503)]);
    await refreshSource(adapter, e, fast);
    const s = await refreshSource(adapter, e, { ...fast, attempts: 1 });
    expect(s.state).toBe("error");
    expect(s.error).toMatch(/503/);
    expect(s.feature_count).toBe(3);
    expect(s.last_success_at).toBeTruthy();
    expect(s.attempted_at).toBe(s.last_error_at);
    expect(s.failures).toBe(1);
    expect(await readData(e.LAYER_CACHE, adapter.config.id)).toHaveLength(3);
  });

  it("keeps the stored copy when a source that had data suddenly returns nothing", async () => {
    const e = env();
    const { adapter } = scripted([ok(4), ok(0)]);
    await refreshSource(adapter, e, fast);
    const s = await refreshSource(adapter, e, fast);
    expect(s.state).toBe("error");
    expect(s.error).toMatch(/no features; keeping the last good copy/);
    expect(await readData(e.LAYER_CACHE, adapter.config.id)).toHaveLength(4);
  });

  it("accepts zero when the source legitimately reports zero", async () => {
    const e = env();
    const { adapter } = scripted([ok(2), ok(0)], { allowEmpty: true });
    await refreshSource(adapter, e, fast);
    const s = await refreshSource(adapter, e, fast);
    expect(s.state).toBe("ok");
    expect(s.feature_count).toBe(0);
    expect(await readData(e.LAYER_CACHE, adapter.config.id)).toEqual([]);
  });

  it("accepts zero from a source that has never had features", async () => {
    const e = env();
    const { adapter } = scripted([ok(0)]);
    expect((await refreshSource(adapter, e, fast)).state).toBe("ok");
  });

  it("keeps the stored copy when the result is invalid", async () => {
    const e = env();
    const bad = { changed: true, features: [{ type: "Feature", geometry: null, properties: {} }], sourceUpdatedMs: null, validator: null } as unknown as AdapterResult;
    const junk = { changed: true, features: { error: "oops" }, sourceUpdatedMs: null, validator: null } as unknown as AdapterResult;
    const { adapter } = scripted([ok(5), bad, junk]);
    await refreshSource(adapter, e, fast);
    const s1 = await refreshSource(adapter, e, fast);
    expect(s1.error).toMatch(/without usable geometry/);
    const s2 = await refreshSource(adapter, e, fast);
    expect(s2.error).toMatch(/invalid result/);
    expect(await readData(e.LAYER_CACHE, adapter.config.id)).toHaveLength(5);
  });

  it("recovers on the next good answer and clears the error", async () => {
    const e = env();
    const { adapter } = scripted([ok(2), new Error("boom"), ok(6)]);
    await refreshSource(adapter, e, fast);
    await refreshSource(adapter, e, { ...fast, attempts: 1 });
    const s = await refreshSource(adapter, e, fast);
    expect(s.state).toBe("ok");
    expect(s.error).toBeUndefined();
    expect(s.failures).toBe(0);
    expect(s.feature_count).toBe(6);
  });
});

describe("timeouts and retries", () => {
  it("retries a failed source once with backoff, then succeeds", async () => {
    const e = env();
    const { adapter, calls } = scripted([new HttpError("Request timed out: x", null), ok(2)]);
    const s = await refreshSource(adapter, e, fast);
    expect(s.state).toBe("ok");
    expect(calls()).toBe(2);
  });

  it("does not retry bad data or a 4xx", async () => {
    const e = env();
    const bad = scripted([new HttpError("HTTP 400 from x", 400), ok(1)]);
    await refreshSource(bad.adapter, e, fast);
    expect(bad.calls()).toBe(1);
  });

  it("does not retry when the request budget is low", async () => {
    const e = env();
    const { adapter, calls } = scripted([new Error("network"), ok(1)]);
    await refreshSource(adapter, e, { ...fast, canRetry: () => false });
    expect(calls()).toBe(1);
  });

  it("gives up on a hung source after its time limit and keeps the last good copy", async () => {
    const e = env();
    const { adapter } = scripted([ok(3), "hang"]);
    await refreshSource(adapter, e, fast);
    const s = await refreshSource(adapter, e, { ...fast, attempts: 1, timeoutMs: 20 });
    expect(s.error).toMatch(/timed out/);
    expect(s.feature_count).toBe(3);
    expect(await readData(e.LAYER_CACHE, adapter.config.id)).toHaveLength(3);
  });

  it("withTimeout passes through results that arrive in time", async () => {
    await expect(withTimeout(Promise.resolve(7), 50, "x")).resolves.toBe(7);
  });

  it("validateResult throws KeepLastGood for suspicious answers only", () => {
    expect(() => validateResult([], 3, false)).toThrow(KeepLastGood);
    expect(() => validateResult([], 3, true)).not.toThrow();
    expect(() => validateResult([feature("a")], 3, false)).not.toThrow();
  });
});

describe("run log", () => {
  it("keeps the last runs, newest first, capped", async () => {
    const kv = memoryKV();
    for (let i = 0; i < RUN_LOG_SIZE + 5; i++) {
      const entry: RunLogEntry = { started_at: `t${i}`, finished_at: `t${i}`, duration_ms: 1, requests: 0, sources: {} };
      await appendRunLog(kv, entry);
    }
    const log = await readRunLog(kv);
    expect(log).toHaveLength(RUN_LOG_SIZE);
    expect(log[0]!.started_at).toBe(`t${RUN_LOG_SIZE + 4}`);
  });

  it("records each source's state, count and error for a run, and shows it on /api/status", async () => {
    const e = env();
    const down = (async () => { throw new TypeError("network down"); }) as unknown as typeof fetch;
    const one = SOURCES.find((s) => s.id === "wdfw-wolf-packs-current")!;
    const reg = new Registry([{ ...one, http: { minIntervalMs: 0, retries: 0 } } as typeof one]);
    await refreshDue(reg, e, { fetchImpl: down, retryDelayMs: 1, staggerMs: 0 });
    const log = await readRunLog(e.LAYER_CACHE);
    expect(log).toHaveLength(1);
    const run = log[0]!;
    expect(run.requests).toBeGreaterThan(0);
    expect(run.sources[one.id]!.state).toMatch(/error|fixture/);
    expect(run.sources[one.id]!.error).toMatch(/network error/);
    const st = await readStatus(e.LAYER_CACHE, one.id);
    expect(st.attempted_at).toBeTruthy();

    const report = await statusReport(e);
    expect(report.runs).toHaveLength(1);
    expect(report.last_cron_run).toBe(run.finished_at);
    const src = report.sources.find((s) => s.id === one.id)!;
    expect(src).toMatchObject({ last_error: expect.stringMatching(/network error/), feature_count: 0 });
    expect(src.last_attempt_at).toBeTruthy();
  });
});
