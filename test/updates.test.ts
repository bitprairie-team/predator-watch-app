import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UPDATE_SOURCES } from "../src/config/updates";
import { dateFromText, parseUpdateSource } from "../src/updates/parse";
import { emptyUpdates, refreshUpdates, UPDATES_KEY } from "../src/updates/refresh";
import { memoryKV } from "./helpers";

const fx = (name: string) => readFileSync(join(__dirname, "fixtures/updates", name), "utf8");
const src = (id: string) => {
  const s = UPDATE_SOURCES.find((x) => x.id === id);
  if (!s) throw new Error(id);
  return s;
};

describe("update date parsing", () => {
  it("reads official month, day and year forms, and strips em dashes", () => {
    expect(dateFromText("October 2026")).toBe("2026-10-01");
    expect(dateFromText("November 9, 2026")).toBe("2026-11-09");
    expect(dateFromText("2026 Wolf Population Survey")).toBe("2026-01-01");
    expect(dateFromText("Title \u2014 an official notice (2024-02-07)")).toBe("2024-02-07");
  });
});

describe("official parsers (fixtures from agency pages, 2026-11-09)", () => {
  it("keeps Federal Register documents whose titles are about wolves, and drops information-collection notices", () => {
    const { items } = parseUpdateSource(src("fr-fws-wolf"), fx("federal-register.json"));
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.every((i) => /gray wolf|mexican wolf|canis lupus/i.test(i.title))).toBe(true);
    expect(items.some((i) => /information collection/i.test(i.title))).toBe(false);
    expect(items[0]?.agency).toBe("U.S. Fish and Wildlife Service");
    expect(items.every((i) => i.url.startsWith("https://www.federalregister.gov/"))).toBe(true);
    expect(items.every((i) => i.kind === "status-notice")).toBe(true);
  });

  it("reads WDFW monthly wolf report links", () => {
    const { items } = parseUpdateSource(src("wdfw-wolf-updates"), fx("wdfw-updates.html"));
    const monthly = items.filter((i) => /monthly wolf report/i.test(i.title));
    expect(monthly.length).toBeGreaterThanOrEqual(3);
    expect(items.every((i) => i.url.includes("/gray-wolf/updates/"))).toBe(true);
    expect(items.some((i) => i.date.startsWith("2026-10"))).toBe(true);
    expect(items.every((i) => !i.title.includes("\u2014"))).toBe(true);
  });

  it("reads CDFW wolf news update posts", () => {
    const { items } = parseUpdateSource(src("cdfw-wolf-updates"), fx("cdfw-updates.html"));
    expect(items.some((i) => /october 2026/i.test(i.title))).toBe(true);
    expect(items.every((i) => i.url.includes("/Gray-Wolf/Updates/"))).toBe(true);
  });

  it("reads Minnesota DNR population survey PDFs", () => {
    const { items } = parseUpdateSource(src("mn-dnr-wolf-surveys"), fx("mn-wolf.html"));
    expect(items.some((i) => /2026 Wolf Population Survey/i.test(i.title))).toBe(true);
    expect(items.every((i) => i.url.endsWith(".pdf"))).toBe(true);
  });

  it("reads Wisconsin DNR monitoring reports", () => {
    const { items } = parseUpdateSource(src("wi-dnr-wolf-reports"), fx("wi-wolf.html"));
    expect(items.some((i) => /2025 Wolf Monitoring Report/i.test(i.title))).toBe(true);
  });

  it("copies the official ODFW minimum count and does not invent a number", () => {
    const { facts, items } = parseUpdateSource(src("odfw-minimum-count"), fx("odfw-population.html"));
    expect(facts).toHaveLength(1);
    expect(facts[0]?.year).toBe(2025);
    expect(facts[0]?.value).toBe("230 wolves");
    expect(facts[0]?.attribution).toBe("as reported by Oregon Department of Fish and Wildlife, 2025");
    expect(items[0]?.kind).toBe("count");
    const none = parseUpdateSource(src("odfw-minimum-count"), "<html><p>No table here.</p></html>");
    expect(none.facts).toEqual([]);
  });

  it("copies the official National Park Service count sentence", () => {
    const { facts } = parseUpdateSource(src("nps-yellowstone-count"), fx("nps-yellowstone.html"));
    expect(facts[0]?.value).toBe("84 wolves");
    expect(facts[0]?.year).toBe(2026);
    expect(facts[0]?.attribution).toMatch(/as reported by National Park Service, January 2026/);
  });

  it("uses the latest non-empty year from the official Isle Royale CSV", () => {
    const { facts } = parseUpdateSource(src("nps-isro-count"), fx("nps-isro.csv"));
    expect(facts[0]?.year).toBe(2026);
    expect(facts[0]?.value).toBe("37 wolves");
    // 2025 is N/A in the file and must not be chosen
    expect(facts[0]?.year).not.toBe(2025);
  });
});

describe("refresh keeps the last good copy", () => {
  it("stores parsed items and, on a later failure, keeps them", async () => {
    const kv = memoryKV();
    const env = { LAYER_CACHE: kv, USER_AGENT: "test" };
    let ok = true;
    const fetchImpl: typeof fetch = async (url) => {
      const u = String(url);
      if (!ok) return new Response("nope", { status: 500 });
      if (u.includes("federalregister.gov")) return new Response(fx("federal-register.json"), { status: 200 });
      if (u.includes("wdfw.wa.gov")) return new Response(fx("wdfw-updates.html"), { status: 200 });
      if (u.includes("wildlife.ca.gov")) return new Response(fx("cdfw-updates.html"), { status: 200 });
      if (u.includes("dnr.state.mn.us")) return new Response(fx("mn-wolf.html"), { status: 200 });
      if (u.includes("dnr.wisconsin.gov")) return new Response(fx("wi-wolf.html"), { status: 200 });
      if (u.includes("dfw.state.or.us")) return new Response(fx("odfw-population.html"), { status: 200 });
      if (u.includes("nps.gov/yell")) return new Response(fx("nps-yellowstone.html"), { status: 200 });
      if (u.includes("sortable_dataset")) return new Response(fx("nps-isro.csv"), { status: 200 });
      return new Response("missing", { status: 404 });
    };
    const first = await refreshUpdates(env, { fetch: fetchImpl, now: () => new Date("2026-11-09T20:00:00Z") });
    expect(first.state).toBe("ok");
    expect(first.items.length).toBeGreaterThan(10);
    expect(first.facts.length).toBeGreaterThanOrEqual(3);
    const count = first.items.length;
    ok = false;
    const second = await refreshUpdates(env, { fetch: fetchImpl, now: () => new Date("2026-11-10T20:00:00Z") });
    expect(second.items.length).toBe(count);
    expect(second.sources.some((s) => s.state === "error")).toBe(true);
    const stored = JSON.parse(String(await kv.get(UPDATES_KEY)));
    expect(stored.items.length).toBe(count);
    expect(emptyUpdates().items).toEqual([]);
  });
});
