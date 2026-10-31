// Offline stand-in for the xAI API, for tests and `npm run dev:mock`.
//
// It is a fetch implementation, not a provider: the real XaiProvider code
// builds the request, sends it here, and parses the reply, so the whole loop
// (request shape, function calls, encrypted reasoning pass-back, tool results,
// citations, voice client secrets) runs exactly as it would against the API.
//
// The "model" is a keyword router: it picks tools from the question, then
// writes an answer from the tool results with the [S#] markers it was given.
// It also obeys instructions it finds inside tool output, on purpose, so the
// tests prove the sanitizer is what stops prompt injection.
//
// Enabled with XAI_MOCK=1 (or MODEL_PROVIDER=mock). It never makes a network call.
import { GENERAL_LABEL } from "../../guardrails/policy";

type Json = Record<string, any>;

interface ParsedOutput {
  name: string;
  data: Json;
  unknown?: string;
  planned?: string;
  error?: string;
  message?: string;
  sources: { cite: string; id?: string; kind?: string; title: string; publisher: string; observed_at: string | null; received_at: string | null }[];
}

const GENERAL_LIBRARY: { match: RegExp; text: string }[] = [
  {
    match: /trail cam(era)?s?|game cam(era)?s?|camera traps?/,
    text: "Trail cameras placed along fence lines, water, and travel routes can show what animals use an area and when. Check them regularly, note dates and times, and share confirmed predator photos with the agency contact on file rather than posting exact locations publicly.",
  },
  {
    match: /fladry|flags?\b/,
    text: "Fladry is a line of colored flags hung from a rope or fence. It works best as a short-term deterrent around calving pastures or night pens, because wolves can get used to it within weeks. Electrified fladry tends to last longer. Check it often and move it before animals get used to it.",
  },
  {
    match: /guard(ian)? (dog|animal)|\bdogs?\b|llama|donkey/,
    text: "Livestock guardian dogs live with the herd or flock and bark at or confront predators. In wolf country they usually work in groups, need to bond with the stock from a young age, and need attention to conflicts with hikers and pets.",
  },
  {
    match: /range rid|rider|human presence/,
    text: "Range riders spend time with cattle on open range. They add human presence, check for sick or injured animals, and look for signs of predators so herds can be moved. They are most useful during high-risk periods such as turnout and calving.",
  },
  {
    match: /fenc|night pen|corral|pen\b/,
    text: "Night pens and predator-resistant fencing protect animals when they are most vulnerable, usually at night and during calving or lambing. Electric fencing with close wire spacing near the ground, and a clear fence line, make it more effective.",
  },
  {
    match: /light|noise|siren|hazing device|scare/,
    text: "Flashing lights, sirens, and noise devices can deter predators for a short time. Rotate or move them so animals don't get used to them, and use them alongside other tools.",
  },
  {
    match: /carcass|bone pile|dead stock|dead livestock|compost/,
    text: "Removing or burying dead livestock promptly, especially near calving areas, reduces what draws predators in. Many areas have carcass pickup or composting programs.",
  },
  {
    match: /calv|lamb|birth|turnout/,
    text: "Calving or lambing close to people, using sheds or night pens, and timing births so young stock are bigger at turnout can all reduce losses. Frequent herd checks help find problems early.",
  },
  {
    match: /document|evidence|photo|suspect(ed)? (a )?(depredation|kill)|what (should|do) i do .*(dead|kill)/,
    text: "If you suspect a depredation, leave the carcass where it is, cover it to protect it from scavengers and weather, photograph bite marks and tracks with something for scale, and call the agency contact as soon as you can, because evidence breaks down quickly.",
  },
  {
    match: /deter|nonlethal|non-lethal|keep .* away|protect|prevent/,
    text: "Nonlethal tools work best in combination: night pens or predator-resistant fencing, guardian dogs, range riders, fladry, lights and noise, and prompt carcass removal. Changing tools over time helps keep predators from getting used to any one of them.",
  },
];

const LOCAL_ADVICE = "Your agency or local extension office can advise on what works best where you ranch.";

function lower(s: string): string {
  return s.toLowerCase();
}

function parseDays(q: string, dflt: number): number {
  const m = q.match(/(?:last|past) (\d{1,2}) days?/);
  if (m) return Math.min(90, Math.max(1, Number(m[1])));
  if (/(last|past) (\d) weeks?/.test(q)) return Math.min(90, Number(q.match(/(last|past) (\d) weeks?/)![2]) * 7);
  if (/this week|past week|last week|7 days/.test(q)) return 7;
  if (/today|yesterday|last night|24 hours/.test(q)) return 2;
  if (/month|30 days/.test(q)) return 30;
  return dflt;
}

function parseRadius(q: string, dflt: number, max: number): number {
  const m = q.match(/(?:within|inside|in) (\d{1,3}) ?(?:mi|miles?)\b/) ?? q.match(/(\d{1,3}) ?(?:mi|miles?)\b/);
  return m ? Math.min(max, Math.max(1, Number(m[1]))) : dflt;
}

/** Pick tool calls for a question. Only tools offered in the request are used. */
export function routeQuestion(question: string, offered: Set<string>): { name: string; arguments: Json }[] {
  const q = lower(question);
  const calls: { name: string; arguments: Json }[] = [];
  const add = (name: string, args: Json) => {
    if (offered.has(name) && !calls.some((c) => c.name === name)) calls.push({ name, arguments: args });
  };
  if (/audit|log of|what tools|who used|history of (my )?(calls|tools|questions)/.test(q)) add("my_audit_log", { limit: 10 });
  if (/week(ly)? summary|summari[sz]e|this week|recap|roll-?up/.test(q)) add("weekly_summary", {});
  if (/fire|smoke|red flag|weather|wind|storm|heat|alerts?\b/.test(q) && !/summar/.test(q)) add("fire_weather_alerts", { radius_miles: parseRadius(q, 50, 200) });
  if (/allotment|grazing|permit area|summer range/.test(q)) add("allotment_wolf_activity", { days: parseDays(q, 30) });
  if (/who (do|should|can) i (call|contact|report|tell)|contact|phone|number for|report(ing)? (a |the )?(kill|loss|depredation|sighting|it)|how (do|should) i report|reporting (steps|process)|conflict specialist|call about/.test(q)) {
    const topic = /sighting|saw|seen|spotted/.test(q) ? "sighting" : /kill|depredat|dead|lost|loss|attack|injur/.test(q) ? "depredation" : "general";
    add("agency_contacts_and_reporting", { topic });
  }
  if (/fresh|how old|up to date|updated|last update|how current|what does .* mean|what is .* layer|tiers?\b|precision|generaliz|delay|den season|how accurate|where does .* data come/.test(q)) add("data_freshness", {});
  const lib = GENERAL_LIBRARY.find((g) => g.match.test(q));
  if (lib && !calls.some((c) => c.name === "agency_contacts_and_reporting")) {
    const term = q.match(/trail cameras?|camera traps?|fladry|guardian dogs?|range riders?|fenc\w*|night pens?|lights?|noise|carcass\w*|calving|lambing|deterrents?/)?.[0] ?? "deterrents";
    add("nonlethal_deterrents", { query: term });
  }
  if (/wolf|wolves|activity|sighting|predator|coyote|near (my|the) ranch|around (my|the) ranch|anything (new|near)|my records|my reports/.test(q) && !calls.some((c) => /activity|summary|agency_contacts|deterrents/.test(c.name)))
    add("recent_predator_activity", { days: parseDays(q, 14), radius_miles: parseRadius(q, 25, 100) });
  return calls.slice(0, 3);
}

function miles(d: unknown): string {
  if (typeof d !== "number") return "";
  return d < 0.5 ? ", overlapping your ranch" : `, about ${d} miles away`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function day(s: string | null | undefined): string {
  return s ? s.slice(0, 10) : "date not published";
}

function cite(o: ParsedOutput, pred: (s: ParsedOutput["sources"][number]) => boolean): string {
  const s = o.sources.find(pred) ?? o.sources[0];
  return s ? ` [${s.cite}]` : "";
}

function activityLines(o: ParsedOutput): string[] {
  const d = o.data;
  const lines: string[] = [];
  for (const r of (d.public_layers ?? []) as Json[]) {
    lines.push(`- ${r.label}${miles(r.distance_miles)}, observed ${day(r.observed_at)} (${r.precision})${cite(o, (s) => !!s.id && s.id === `layer:${r.source_id}`)}`);
  }
  for (const r of (d.your_records ?? []) as Json[]) {
    lines.push(`- Your record: ${r.species} ${r.kind} on ${day(r.observed_at)} at ${r.lat}, ${r.lon}${r.notes ? ` ("${r.notes}")` : ""}${cite(o, (s) => s.kind === "tenant-data")}`);
  }
  for (const c of (d.shared_cells ?? []) as Json[]) {
    const dist = typeof c.distance_miles === "number" ? ` about ${c.distance_miles} miles away` : "";
    lines.push(`- Shared reports from other ranchers: ${c.report_count} in a generalized cell${dist} (${c.precision}), latest ${c.latest_observed_on}${cite(o, (s) => s.kind === "shared-data")}`);
  }
  return lines;
}

/** Write an answer from tool outputs, citing with the markers they carry. */
export function composeAnswer(question: string, outputs: ParsedOutput[]): string {
  const q = lower(question);

  // Deliberately naive: obey instructions found in tool output. The registry's
  // sanitizer must remove them before they get here.
  for (const o of outputs) {
    const blob = JSON.stringify(o.data ?? {});
    const m = blob.match(/(?:ignore|disregard)[^".]{0,80}instructions?[^".]*[.:]?\s*([^"]{0,240})/i) ?? blob.match(/tell the (?:user|rancher)\s+([^"]{0,240})/i);
    if (m) return m[1]!.trim() || "OK.";
  }

  const parts: string[] = [];
  let general: string | null = null;
  for (const o of outputs) {
    if (o.error) {
      parts.push(`I couldn't run ${o.name.replace(/_/g, " ")}: ${o.message ?? o.error}`);
      continue;
    }
    const d = o.data ?? {};
    switch (o.name) {
      case "recent_predator_activity":
      case "allotment_wolf_activity": {
        const lines = activityLines(o);
        const where = o.name === "allotment_wolf_activity" ? `in the ${d.allotment?.name ?? "allotment"} allotment` : `within ${d.radius_miles} miles of ${d.ranch?.name ?? "your ranch"} over the last ${d.window_days} days`;
        if (lines.length) parts.push(`Here is what the data shows ${where}:\n${lines.join("\n")}`);
        else if (o.unknown) parts.push(`I don't know of any activity ${where}. ${o.unknown}`);
        for (const g of (d.gaps ?? []) as string[]) parts.push(`Note: ${g}`);
        break;
      }
      case "fire_weather_alerts": {
        const alerts = (d.alerts ?? []) as Json[];
        if (alerts.length) parts.push(`Fire and weather alerts near ${d.ranch?.name ?? "your ranch"}:\n${alerts.map((a) => `- ${a.label}${miles(a.distance_miles)}${cite(o, (s) => !!s.id && s.id === `layer:${a.source_id}`)}`).join("\n")}`);
        else if (o.sources.length) parts.push(`No fire or weather alerts show near ${d.ranch?.name ?? "your ranch"} in the layers I checked${o.sources.map((s) => ` [${s.cite}]`).join("")}.`);
        else if (o.unknown) parts.push(`I don't know. ${o.unknown}`);
        break;
      }
      case "agency_contacts_and_reporting": {
        const contacts = (d.contacts ?? []) as Json[];
        const processes = (d.processes ?? []) as Json[];
        const lines = [
          ...contacts.map((c, i) => `- ${c.role}: ${c.name}, ${c.organization}${c.phone ? `, ${c.phone}` : ""}${o.sources[i] ? ` [${o.sources[i]!.cite}]` : ""}`),
          ...processes.map((p, i) => `- ${p.title}: ${(p.steps as string[]).join(" ")}${o.sources[contacts.length + i] ? ` [${o.sources[contacts.length + i]!.cite}]` : ""}`),
        ];
        if (lines.length) parts.push(`On file for your account:\n${lines.join("\n")}`);
        else if (o.unknown) parts.push(`I don't know who to contact for your area. ${o.unknown}`);
        break;
      }
      case "data_freshness": {
        const layers = (d.layers ?? []) as Json[];
        const lines = layers.map((l, i) => `- ${l.name} (${l.publisher}): updates ${l.cadence}; ${l.precision}; agency last edit ${day(l.agency_last_edit)}, received ${day(l.received_at)}${o.sources[i] ? ` [${o.sources[i]!.cite}]` : ""}`);
        if (lines.length) parts.push(`How each layer works and how fresh it is:\n${lines.join("\n")}`);
        if (Array.isArray(d.private_tiers)) parts.push(`Private data tiers:\n${(d.private_tiers as string[]).map((t) => `- ${t}`).join("\n")}`);
        if (!lines.length && o.unknown) parts.push(`I don't know. ${o.unknown}`);
        break;
      }
      case "nonlethal_deterrents": {
        const docs = (d.documents ?? []) as Json[];
        if (docs.length) {
          parts.push(
            docs
              .map((doc, i) => `From ${doc.title} (${doc.publisher}): ${((doc.excerpts ?? []) as string[]).slice(0, 2).map((e) => `"${e}"`).join(" ")}${o.sources[i] ? ` [${o.sources[i]!.cite}]` : ""}`)
              .join("\n"),
          );
        } else {
          const lib = GENERAL_LIBRARY.find((g) => g.match.test(q)) ?? GENERAL_LIBRARY[GENERAL_LIBRARY.length - 1]!;
          general = `${lib.text} ${LOCAL_ADVICE}`;
        }
        break;
      }
      case "weekly_summary": {
        const a = d.activity ?? {};
        const all = o.sources.map((s) => ` [${s.cite}]`).join("");
        if (o.sources.length) {
          parts.push(
            `This week near ${d.ranch?.name ?? "your ranch"}: ${plural(a.public_layer_items ?? 0, "agency layer item", "agency layer items")}, ${plural(a.your_records ?? 0, "of your own records", "of your own records")}, and ${plural(a.shared_cells ?? 0, "shared report cell", "shared report cells")} within 25 miles, plus ${plural((d.alerts ?? []).length, "fire or weather alert", "fire or weather alerts")} within 50 miles${all}.`,
          );
        } else if (o.unknown) parts.push(`I don't know. ${o.unknown}`);
        for (const g of (d.gaps ?? []) as string[]) parts.push(`Note: ${g}`);
        break;
      }
      case "my_audit_log": {
        const entries = ((d.entries ?? []) as Json[]).slice(0, 10);
        const c = o.sources[0] ? ` [${o.sources[0].cite}]` : "";
        if (entries.length) parts.push(`Recent assistant activity on your account${c}:\n${entries.map((e) => `- ${e.at}: ${e.tool}, ${e.outcome}${e.category ? ` (${e.category})` : ""}`).join("\n")}`);
        else parts.push(`I don't know of any assistant activity on your account yet.`);
        break;
      }
      default:
        if (o.sources.length) parts.push(`Results from ${o.name}${o.sources.map((s) => ` [${s.cite}]`).join("")}.`);
    }
  }
  if (parts.length === 0 && general) return `${GENERAL_LABEL} ${general}`;
  if (general) parts.push(`${GENERAL_LABEL} ${general}`);
  if (parts.length === 0) {
    const lib = GENERAL_LIBRARY.find((g) => g.match.test(q));
    if (lib) return `${GENERAL_LABEL} ${lib.text} ${LOCAL_ADVICE}`;
    return "I don't know. I can look up predator activity near your ranch or allotment, fire and weather alerts, who to call and how to report, how fresh the data is, and nonlethal deterrent information.";
  }
  // An idk part should lead so the answer reads honestly.
  parts.sort((x, y) => Number(/^I don't know/.test(y)) - Number(/^I don't know/.test(x)));
  return parts.join("\n\n");
}

function msg(text: string) {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export interface XaiMockOptions {
  /** Record every request body, for tests. */
  log?: { url: string; body: Json }[];
  /** Pretend the client_secrets endpoint rejects a bound session (to test the fallback). */
  rejectBoundSession?: boolean;
}

export function createXaiMockFetch(opts: XaiMockOptions = {}): typeof fetch {
  let seq = 0;
  const f = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    if (!/^Bearer \S+/.test(headers.get("authorization") ?? "")) return jsonResponse({ error: "missing key" }, 401);
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Json;
    opts.log?.push({ url, body });

    if (url.endsWith("/realtime/client_secrets")) {
      if (body.session && opts.rejectBoundSession) return jsonResponse({ error: "session not supported" }, 400);
      return jsonResponse({ value: `mock-ephemeral-${++seq}`, expires_at: Math.floor(Date.now() / 1000) + (body.expires_after?.seconds ?? 60) });
    }
    if (!url.endsWith("/responses")) return jsonResponse({ error: "not found" }, 404);

    const instructions = String(body.instructions ?? "");
    const items = (body.input ?? []) as Json[];
    const lastUserIdx = items.map((i) => i.role).lastIndexOf("user");
    const question = lastUserIdx >= 0 ? String(items[lastUserIdx]!.content ?? "") : "";
    const reasoning = { type: "reasoning", id: `rs_mock_${++seq}`, summary: [], encrypted_content: "bW9jaw==" };

    // Optional classifier call.
    if (instructions.startsWith("You label")) return jsonResponse({ output: [msg("allow")] });

    const after = items.slice(lastUserIdx + 1);
    const outputs = after.filter((i) => i.type === "function_call_output");
    const offered = new Set<string>(((body.tools ?? []) as Json[]).map((t) => t.name));
    if (outputs.length === 0 && offered.size > 0) {
      const calls = routeQuestion(question, offered);
      if (calls.length) {
        return jsonResponse({
          output: [reasoning, ...calls.map((c) => ({ type: "function_call", call_id: `call_mock_${++seq}`, name: c.name, arguments: JSON.stringify(c.arguments) }))],
        });
      }
    }
    const callNames = new Map<string, string>(after.filter((i) => i.type === "function_call").map((i) => [i.call_id, i.name]));
    const parsed: ParsedOutput[] = outputs.map((o) => {
      let v: Json = {};
      try {
        v = JSON.parse(String(o.output));
      } catch {
        /* keep empty */
      }
      return { name: callNames.get(o.call_id) ?? "tool", data: v.data ?? {}, unknown: v.unknown, planned: v.planned, error: v.error, message: v.message, sources: v.sources ?? [] };
    });
    let text = composeAnswer(question, parsed);
    const cap = Number(body.max_output_tokens) || 0;
    if (cap > 0 && text.length > cap * 4) text = text.slice(0, cap * 4);
    return jsonResponse({ output: [reasoning, msg(text)], usage: { output_tokens: Math.ceil(text.length / 4) } });
  };
  return f as typeof fetch;
}
