// Output check. Runs on every model answer before the rancher sees it.
//   1. Strips citation markers that don't match a source returned this turn.
//   2. Blocks answers that make legal determinations, give drug doses, give
//      lethal-removal instructions, or leak the system prompt. A blocked
//      answer is replaced with the matching polite decline.
//   3. Redacts coordinates that are not from the rancher's own records.
//   4. Grounding: drops sentences that state facts about the data without a
//      valid citation. If nothing sourced is left, the answer becomes
//      "I don't know". An answer with no data claims at all is general
//      information and is labelled as such.
import { FALLBACK_ANSWER, isIdk, type Citation } from "../agents/citations";
import { normalize } from "./classifier";
import { GENERAL_LABEL, PROMPT_CANARY, refusalText, type GuardCategory } from "./policy";

export type OutputIssue =
  | "legal_determination"
  | "dosage"
  | "lethal_instructions"
  | "prompt_leak"
  | "coordinates"
  | "ungrounded"
  | "opinion"
  | "invented_number"
  | "link";

export interface OutputCheckInput {
  text: string;
  catalog: Citation[];
  /** Coordinates the rancher is allowed to see (their own records), as [lat, lon]. */
  allowedCoords?: [number, number][];
  /** Sentence-level citation check. Off for spoken voice transcripts, which carry no markers. Default true. */
  grounding?: boolean;
  /** Redact coordinates not in allowedCoords. Default true. */
  redactCoords?: boolean;
  /**
   * Numbers the answer may state as data: every number in this turn's tool
   * data and arguments, list lengths, and numbers in the question. When set,
   * a data claim with any other number is dropped as invented.
   */
  knownNumbers?: number[];
}

export interface CheckedOutput {
  text: string;
  citations: Citation[];
  /** True if the answer was replaced (blocked, or nothing grounded was left). */
  replaced: boolean;
  /** Set when the answer was blocked and replaced with a decline. */
  blocked?: GuardCategory;
  issues: OutputIssue[];
  /** True if the answer used no Predator Watch data and was labelled general information. */
  general: boolean;
}

const BLOCKERS: { issue: OutputIssue; category: GuardCategory; patterns: RegExp[] }[] = [
  {
    issue: "prompt_leak",
    category: "injection",
    patterns: [new RegExp(PROMPT_CANARY), /\b(rules you must follow|decline these politely|scope\. you help with two things)\b/],
  },
  {
    issue: "legal_determination",
    category: "legal",
    patterns: [
      /\b(it is|it's|that is|that's|this is|which is)\s+(perfectly |completely |probably |likely |generally |usually |definitely |not )?(legal|illegal|lawful|unlawful|against the law|permitted|allowed)\b/,
      /\byou (can|may|could|are allowed to|have the right to|are permitted to|are within your rights to|have every right to)\s+(legally\s+|lawfully\s+)?(shoot|kill|trap|take|poison|hunt|remove|harass)\b/,
      /\byou (will|would|should|are likely to) (win|qualify for|be entitled to|be eligible for|receive|get) (full |the |a )?(compensation|reimbursement|payment|damages|settlement)\b/,
      /\b(under|per|according to) (the )?(law|statute|endangered species act|esa|section \d+|code|regulations?)\b.{0,60}\b(you|allowed|permitted|legal|illegal)\b/,
      /\byou (are|would be|will be|won't be|will not be|are not) (liable|prosecuted|fined|charged|in trouble)\b/,
      /\byou (can|could|should) sue\b/,
    ],
  },
  {
    issue: "dosage",
    category: "veterinary",
    patterns: [
      /\b\d+(\.\d+)?\s?(mg|mcg|µg|ml|cc|iu)\b/,
      /\b\d+(\.\d+)?\s?(mg|ml|cc|units?)\s?(\/|per)\s?(kg|lb|lbs|pound|head|cwt|100 ?lbs?)\b/,
      /\b(dose|dosage|administer|inject)\b.{0,40}\d/,
      /\b(give|inject|administer) (her|him|it|the (calf|cow|ewe|lamb|animal))\b.{0,30}\b(antibiotic|penicillin|oxytetracycline|la-?200|banamine|flunixin|ivermectin|meloxicam)\b/,
    ],
  },
  {
    issue: "lethal_instructions",
    category: "lethal",
    patterns: [
      /\b(snares?|leg-?hold|foot-?hold|conibear|body-?grip|m-?44s?|cyanide|strychnine|compound 1080|poison(ed)? (bait|meat|carcass))\b/,
      /\b(caliber|calibre|\.(223|243|270|308)|ammo|ammunition|shot placement|kill shot|aim (for|at) the|predator calls?|e-?calls?|thermal scope)\b/,
      /\b(set|place|bait|anchor)\b.{0,25}\b(traps?|snares?)\b/,
      /\bhow to (kill|shoot|trap|poison|hunt)\b/,
      /\b(step \d|first,? |then,? |next,? ).{0,40}\b(shoot|kill|trap|poison)\b/,
    ],
  },
];

/** Sentences like these state facts about the data and need a citation. */
const DATA_CLAIM: RegExp[] = [
  /\b(your|the) (own )?(records?|data|layers?|map|reports?|cells?|alerts?|logs?|allotment|ranch records)\b.{0,40}\b(shows?|showed|indicates?|lists?|has|have|had|contains?|recorded|includes?|reports?|reported)\b/,
  /\b\d+\s+(sightings?|reports?|records?|depredations?|cells?|alerts?|wolves|detections?|items?|kills?|losses|warnings?|perimeters?|incidents?)\b/,
  /\bwithin \d+(\.\d+)? miles?\b/,
  /\b(about |roughly |around )?\d+(\.\d+)? miles? (from|of|away|north|south|east|west)\b/,
  /\b(observed|reported|recorded|received|detected|confirmed|seen|spotted|logged)\b.{0,20}\b(on|at|near|within|yesterday|today|last|this|ago|\d)\b/,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d+ (days?|hours?|weeks?) ago\b/,
  /\b(red flag warning|fire perimeter|wildfire|watch|warning|advisory)\b.{0,30}\b(is|are) (active|in effect|current|near|over|covering)\b/,
  /\b(there (is|are|was|were)|i see|i found)\b.{0,30}\b(wolf|wolves|activity|sightings?|alerts?|fires?|warnings?|reports?|cells?|records?)\b/,
  /\b(wolf|wolves|pack|collared|activity|sightings?|reports?|alerts?|fires?|warnings?|predators?|coyotes?)\b.{0,40}\b(near|around|close to|in|on|by) (you|your|the) (ranch|allotment|home place|pasture|property)\b/,
  /\b(contact on file|phone number)\b.{0,30}\b(is|are)\b|\b\d{3}-\d{4}\b/,
];

const OPINION = /\b(in my (opinion|view)|i (personally )?(think|believe|feel)|i (support|oppose)|personally,)\b/;

/** A decimal coordinate with at least three decimals: enough to point at a spot. */
const COORD = /-?\d{1,3}\.\d{3,}/g;

function splitSentences(line: string): string[] {
  return line
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"(\[*-])/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** "If there is wolf activity, ..." is advice, not a claim about the data. */
const CONDITIONAL = /^[\s*\-\d.)]*(if|when|whenever|once|should|in case|where)\b/;

const MARKER = /\[(S\d{1,3})\]/g;

function nearAllowed(v: number, allowed: number[]): boolean {
  return allowed.some((a) => Math.abs(a - v) < 0.00051);
}

/** The policy category an answer would be blocked for, if any. Used to vet earlier turns sent by the client. */
export function blockedCategory(text: string): GuardCategory | null {
  const lower = normalize(text);
  return BLOCKERS.find((b) => b.patterns.some((p) => p.test(lower)))?.category ?? null;
}

/** Every number found in a value: numeric fields, numbers inside strings, and array lengths. */
export function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number" && Number.isFinite(value)) out.push(value);
  else if (typeof value === "string") for (const m of value.matchAll(/\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
  else if (Array.isArray(value)) {
    out.push(value.length);
    value.forEach((v) => numbersIn(v, out));
  } else if (value && typeof value === "object") Object.values(value).forEach((v) => numbersIn(v, out));
  return out;
}

/** Numbers stated in a sentence, ignoring dates (checked as claims) and citation markers. */
function statedNumbers(s: string): number[] {
  return [...s.replace(MARKER, "").replace(/\b\d{4}-\d{2}-\d{2}(t[\d:.]+z?)?\b/gi, "").replace(/\b\d{3}-\d{4}\b/g, "").matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w])/g)].map((m) => Number(m[0]));
}

function numberKnown(n: number, known: number[]): boolean {
  // Allow rounding to a whole number or one decimal, and small words-as-numbers like "1 report".
  return known.some((raw) => {
    const k = Math.abs(raw);
    return k === n || Math.round(k) === n || Math.round(k * 10) / 10 === n || Math.abs(k - n) < 1e-9;
  });
}

/** Links in an answer must point at a source returned this turn. */
const LINK = /!\[[^\]]*\]\([^)]*\)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s)\]]+/g;

export function checkOutput(o: OutputCheckInput): CheckedOutput {
  const issues: OutputIssue[] = [];
  const byCite = new Map(o.catalog.map((c) => [c.cite, c]));
  const used: Citation[] = [];

  // 1. Strip invented markers, remember valid ones.
  let text = o.text
    .replace(MARKER, (m, id: string) => {
      const c = byCite.get(id);
      if (!c) return "";
      if (!used.includes(c)) used.push(c);
      return m;
    })
    .replace(/[ \t]+([.,;:])/g, "$1")
    .trim();

  // 2. Blockers.
  const lower = normalize(text);
  for (const b of BLOCKERS) {
    if (b.patterns.some((p) => p.test(lower))) {
      return { text: refusalText(b.category), citations: [], replaced: true, blocked: b.category, issues: [b.issue], general: false };
    }
  }

  // 2b. Links and images that don't point at a returned source are removed.
  // Images never render (they can leak data through the URL).
  const sourceUrls = o.catalog.map((c) => c.url).filter((u): u is string => !!u);
  const urlOk = (u: string) => sourceUrls.some((s) => u === s || u.startsWith(s.replace(/[#?].*$/, "")));
  text = text.replace(LINK, (m, label?: string, url?: string) => {
    if (m.startsWith("![")) {
      if (!issues.includes("link")) issues.push("link");
      return "";
    }
    const u = url ?? m;
    if (urlOk(u)) return m;
    if (!issues.includes("link")) issues.push("link");
    return label ? label : "[link removed]";
  });

  // 3. Coordinates not from the rancher's own records.
  const allowed = (o.allowedCoords ?? []).flat();
  if (o.redactCoords !== false) text = text.replace(COORD, (m) => {
    if (nearAllowed(Number(m), allowed)) return m;
    if (!issues.includes("coordinates")) issues.push("coordinates");
    return "[location withheld]";
  });

  // 4. Grounding, sentence by sentence, keeping line breaks.
  if (o.grounding === false) return { text, citations: used, replaced: false, issues, general: false };
  if (isIdk(text)) return { text, citations: [], replaced: false, issues, general: false };
  const keptLines: string[] = [];
  const keptCites = new Set<string>();
  let dropped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      if (keptLines.length && keptLines[keptLines.length - 1] !== "") keptLines.push("");
      continue;
    }
    const kept: string[] = [];
    for (const s of splitSentences(line)) {
      const n = normalize(s);
      if (OPINION.test(n)) {
        if (!issues.includes("opinion")) issues.push("opinion");
        continue;
      }
      const cites = [...s.matchAll(MARKER)].map((m) => m[1]!);
      // A lead-in that ends with a colon introduces cited list items; it is not a claim by itself.
      const leadIn = /:\s*$/.test(s);
      const claim = !CONDITIONAL.test(n) && !leadIn && DATA_CLAIM.some((p) => p.test(n));
      if (claim && cites.length === 0 && !/\bi don['’]t know\b/i.test(s)) {
        if (!issues.includes("ungrounded")) issues.push("ungrounded");
        dropped++;
        continue;
      }
      // A cited claim may only use numbers that are in the data it cites.
      if (claim && o.knownNumbers && statedNumbers(s).some((n) => !numberKnown(n, o.knownNumbers!))) {
        if (!issues.includes("invented_number")) issues.push("invented_number");
        dropped++;
        continue;
      }
      cites.forEach((c) => keptCites.add(c));
      kept.push(s);
    }
    if (kept.length) keptLines.push((line.match(/^\s*([-*]|\d+\.)\s/) && !/^\s*([-*]|\d+\.)\s/.test(kept[0]!) ? line.match(/^\s*([-*]|\d+\.)\s/)![0] : "") + kept.join(" "));
  }
  const citations = used.filter((c) => keptCites.has(c.cite));
  const out = keptLines.join("\n").replace(/[ \t]+/g, " ").trim();
  const meaningful = out.replace(MARKER, "").replace(/[^a-z]/gi, "").length >= 12;

  if (!out || !meaningful) {
    return { text: FALLBACK_ANSWER, citations: [], replaced: true, issues, general: false };
  }
  if (citations.length === 0) {
    const note = dropped ? " I left out details I couldn't source from your Predator Watch data." : "";
    const labelled = out.startsWith(GENERAL_LABEL) ? out : `${GENERAL_LABEL} ${out}`;
    return { text: labelled + note, citations: [], replaced: false, issues, general: true };
  }
  return { text: out, citations, replaced: false, issues, general: false };
}
