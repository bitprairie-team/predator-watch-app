// Deterministic pre-classifier. Runs on every rancher question (text, voice
// transcripts, and free-text tool arguments, including over MCP) before any
// model sees it. Keyword and regex rules only: no network, no model call.
//
// It is tuned to decline clear gray-area requests and let normal ranching and
// data questions through. The model's system prompt and the output check are
// the second and third layers.
import type { GuardCategory } from "./policy";

export interface GuardDecision {
  action: "allow" | "decline";
  category?: GuardCategory;
  /** Rule id that matched, for the audit log and tests. */
  rule?: string;
  /** The question mentions an emergency in progress. */
  emergency?: boolean;
}

/** Lowercase, fold Unicode look-alikes, drop zero-width characters, collapse spaces. */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, "")
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const PREDATOR = String.raw`(?:wolf|wolves|pack|packs|coyotes?|(?:mountain )?lions?|cougars?|pumas?|bears?|grizzl(?:y|ies)|predators?|animals?|pups?)`;
/** Narrower target list for location rules, so "where should I put a night pen for my animals" passes. */
const LOC_TARGET = String.raw`(?:wolf|wolves|packs?|coyotes?|(?:mountain )?lions?|cougars?|pumas?|bears?|grizzl(?:y|ies)|predators?)`;
const LETHAL_VERB = String.raw`(?:shoot|shooting|kill|killing|trap|trapping|snare|snaring|poison|poisoning|hunt|hunting|cull|culling|take out|get rid of|eliminate|exterminate|destroy|wipe out|bait)`;

interface Rule {
  id: string;
  category: GuardCategory;
  test: (t: string) => boolean;
}

const re = (r: RegExp) => (t: string) => r.test(t);
const all = (...rs: RegExp[]) => (t: string) => rs.every((r) => r.test(t));

/** Questions that only ask what a layer, tier, or term means are explanations, not requests. */
const EXPLAIN = /\b(what (does|do|is|are)|what's|meaning of|mean|means|explain|definition|define)\b/;
const HOWTO = /\b(how (do|can|should|would|to)|best way|teach me|show me how|tell me how|help me|steps to|where (can|should|do) i|what (gun|rifle|caliber|trap|bait|poison)|i want to|i'?m going to|going to|plan to|let'?s)\b/;

const RULES: Rule[] = [
  // ---------------------------------------------------------------- injection
  { id: "inj.ignore", category: "injection", test: re(/\b(ignore|disregard|forget|override|bypass|drop)\b.{0,40}\b(instructions?|rules|guardrails?|polic(y|ies)|prompts?|restrictions?|guidelines|programming|safety)\b/) },
  { id: "inj.system", category: "injection", test: re(/\b(system|developer|hidden|initial|original) (prompt|message|instructions?)\b/) },
  { id: "inj.reveal", category: "injection", test: re(/\b(reveal|print|show|repeat|output|dump|leak|tell me)\b.{0,30}\b(your|the)\b.{0,20}\b(instructions|prompt|rules|configuration|guidelines)\b/) },
  { id: "inj.persona", category: "injection", test: re(/\b(you are now|you're now|from now on you|you are no longer|jailbreak|dan mode|developer mode|god mode|no restrictions|without (any )?(rules|restrictions|filters|limits))\b/) },
  { id: "inj.roleplay", category: "injection", test: re(/\b(pretend|act|roleplay|role-play|role play|imagine)\b.{0,30}\b(you('| a)re|as|to be|you were)\b.{0,30}\b(lawyer|attorney|vet|veterinarian|hunter|trapper|unrestricted|unfiltered|evil|different (ai|assistant|model))\b/) },
  { id: "inj.tokens", category: "injection", test: re(/<\|[^|]{1,40}\|>|\[\/?(system|inst)\]|<\/?(system|instructions?)>|\bnew instructions?\s*:|\bsystem\s*:/) },

  // ---------------------------------------------------------------- evasion
  { id: "eva.around", category: "evasion", test: re(/\b(get(ting)? away with|get(ting)? around (the )?(rules?|law|regulations?|reporting)|evad(e|ing)|circumvent|loophole|under the radar|off the books|cover(ing)? (it |this |that )?up|hide (the |a )?(carcass|body|evidence|kill|collar))\b/) },
  { id: "eva.caught", category: "evasion", test: re(/\b(without|avoid|so (that )?)\b.{0,25}\b(getting caught|being caught|anyone (knowing|finding out)|the (game )?warden|wardens|(agency|state|feds|officers?|fish and game|enforcement) (finding out|knowing|noticing|seeing))\b/) },
  { id: "eva.noreport", category: "evasion", test: re(/\b(how (do|can) i|ways? to|is there a way to)\b.{0,20}\b(not|avoid|skip|get out of) report/) },
  { id: "eva.fraud", category: "evasion", test: re(/\b(inflate|exaggerate|pad|overstate|fake|fabricate|falsify|make up)\b.{0,30}\b(claims?|loss(es)?|reports?|numbers|count|evidence|kill)\b|\breport (more|extra)\b.{0,40}\bthan (i|we) (can prove|lost|actually)\b|\b(stage|fake) a (kill|depredation)\b/) },
  { id: "eva.collar", category: "evasion", test: re(/\b(remove|destroy|disable|cut off|jam|block)\b.{0,20}\b(collar|transmitter|tracking)\b/) },

  // ---------------------------------------------------------------- locating animals
  {
    id: "loc.harm",
    category: "harm_location",
    test: (t) =>
      new RegExp(String.raw`\b(where|find|locate|track( down)?|hunt down|pinpoint|go to)\b.{0,60}\b(dens?|denning|rendezvous|${LOC_TARGET}|collar(ed)?)\b`).test(t) &&
      new RegExp(String.raw`\b${LETHAL_VERB}\b|\b(deal with|take care of|remove|get them|get it)\b`).test(t),
  },
  { id: "loc.trackdown", category: "harm_location", test: re(new RegExp(String.raw`\b(track|hunt|run) (down|after)\b.{0,30}\b${LOC_TARGET}`)) },
  {
    id: "loc.den",
    category: "precise_location",
    test: (t) =>
      /\b(dens?|denning|den site|rendezvous( sites?)?|whelping)\b/.test(t) &&
      /\b(where|location|located|locate|find|coordinates?|gps|exact|precise|pinpoint|address|directions?|lat(itude)?|long(itude)?|map it|show me)\b/.test(t) &&
      !(/\bden season\b/.test(t) && !/\b(where|coordinates?|gps|exact|precise|pinpoint|lat(itude)?|long(itude)?)\b/.test(t)),
  },
  {
    id: "loc.precise",
    category: "precise_location",
    test: (t) =>
      new RegExp(String.raw`\b(collar(ed)?|radio[- ]?collar|telemetry|${LOC_TARGET})\b`).test(t) &&
      /\b(exact(ly)?|precise(ly)?|pinpoint|coordinates?|gps|lat(itude)?\s*(\/|and|,)?\s*lon(g|gitude)?|real[- ]?time|live (location|position|feed|map)|current (location|position)|right now|tonight|frequenc(y|ies)|ping)\b/.test(t) &&
      /\b(where|locat\w*|find|position|coordinates?|gps|pinpoint|frequenc(y|ies)|ping|track\w*)\b/.test(t) &&
      !/\b(my|our) (own )?(records?|sightings?|reports?|observations?|entries|entry)\b/.test(t),
  },
  { id: "loc.unmask", category: "precise_location", test: re(/\b(un-?generaliz\w*|de-?generaliz\w*|reverse|undo|remove|bypass|turn off|skip|without)\b.{0,30}\b(generaliz\w*|delay|holdback|hold-back|cells?|blur\w*|precision|fuzz\w*)\b/) },
  { id: "loc.triangulate", category: "precise_location", test: re(/\b(triangulat\w*|narrow (it )?down|exact (cell|spot|point))\b/) },

  // ---------------------------------------------------------------- other people
  { id: "pii.who", category: "personal_data", test: (t) => /\b(who|which (rancher|neighbou?r|ranch|person|user|member|account|family))\b.{0,40}\b(reported|shared|submitted|posted|lost|saw|logged|contributed|made (the|that|this) report|is reporting)\b/.test(t) && !/\bwho (do|should|can|would|will) (i|we)\b/.test(t) && !/\b(agency|agencies|layer|publisher|published|source|service)\b/.test(t) },
  { id: "pii.contact", category: "personal_data", test: re(/\b(name|names|phone|number|email|address|contact info|identity|identities|location)\b.{0,30}\b(of|for)\b.{0,20}\b(the |that |this |other |another |my )?(rancher|ranchers|neighbou?rs?|person|owner|reporter|member|user|other ranch(es)?)\b/) },
  { id: "pii.others", category: "personal_data", test: re(/\b(neighbou?r'?s|neighbou?rs'|other ranchers?'?s?|another rancher'?s|other (people|users|members|accounts)'?s?|someone else'?s)\b.{0,30}\b(records?|data|loss(es)?|reports?|location|ranch|address|name|sightings?|notes|herd|account)\b/) },
  { id: "pii.origin", category: "personal_data", test: re(/\b(where|which ranch|whose ranch)\b.{0,20}\b(did|does|do)\b.{0,20}\b(shared|other ranchers'?|neighbou?rs'?)\b.{0,10}\breports?\b.{0,15}\b(come from|originate|get (reported|submitted))\b/) },
  { id: "pii.owner", category: "personal_data", test: re(/\bwho (owns|lives (at|on)|runs)\b/) },

  // ---------------------------------------------------------------- lethal methods
  { id: "let.method", category: "lethal", test: (t) => /\b(snares?|leg-?hold|foot-?hold|conibear|body-?grip|m-?44s?|cyanide|strychnine|compound 1080|poison(ed)? (bait|meat|carcass)|caliber|calibre|\.(223|243|270|308)|ammo|ammunition|bullets?|shot placement|kill shot|predator calls?|e-?calls?|thermal scope|night vision scope|rifles?|shotguns?|guns?|firearms?)\b/.test(t) && !(EXPLAIN.test(t) && /\b(layer|data|map|tier)\b/.test(t)) },

  // ---------------------------------------------------------------- legal
  { id: "leg.isit", category: "legal", test: re(/\b(is it|it's|it is|would it be|is that|was it|was that|am i|are we)\b.{0,30}\b(legal|illegal|lawful|unlawful|against the law|allowed to|permitted to|breaking the law|in trouble|liable)\b/) },
  { id: "leg.cani", category: "legal", test: re(new RegExp(String.raw`\b(can|may|could|am i allowed to|is anyone allowed to|are ranchers allowed to)\b.{0,10}\b(i|we|ranchers|a rancher|you)?\b.{0,10}\b(legally )?(shoot|kill|trap|take|poison|hunt|remove|harass)\b.{0,20}\b${PREDATOR}`)) },
  { id: "leg.canit", category: "legal", test: re(/\b(can|may|could) (i|we) (legally |lawfully )?(shoot|kill|trap|poison|take|hunt|harass|haze) (it|them|one|that one|this one|that thing)\b/) },
  { id: "leg.legally", category: "legal", test: re(/\b(legally|legality|legal right|right to (shoot|kill|defend)|legal advice|legal options?)\b/) },
  { id: "leg.law", category: "legal", test: re(/\b(lawyer|attorney|lawsuit|sue (the|them|him|her|my|a|an)|suing|litigation|court|liab(le|ility)|statutes?|endangered species act|\besa\b|section \d+|federal law|state law|the law say|regulations? (say|mean|allow|require)|interpret\w*.{0,20}(rule|regulation|law)|penalt(y|ies)|fined|prosecut\w*|ticketed|cited for)\b/) },
  { id: "leg.permit", category: "legal", test: re(/\b(kill|lethal|depredation|take|hunting|trapping) (permit|permits|tag|tags|license)\b/) },
  { id: "leg.status", category: "legal", test: re(new RegExp(String.raw`\b(are|is)\b.{0,10}\b${PREDATOR}\b.{0,10}\b(protected|listed|delisted|endangered|threatened|legal to)\b`)) },
  { id: "leg.required", category: "legal", test: re(/\b(am i|are we|are ranchers) (required|obligated|obliged|supposed) to\b|\b(do|does) (i|we) (have|need) to (report|notify|tell)\b|\bwhat happens if i (don't|do not|didn't) report\b/) },

  // ---------------------------------------------------------------- compensation
  { id: "comp.strategy", category: "compensation", test: (t) => /\b(compensat\w*|reimburs\w*|indemnit\w*|claims?|payouts?)\b/.test(t) && /\b(maximi[sz]e|get more|increase|win|appeal|denied|deny|denial|strategy|best way|prove|proof|convince|guarantee|qualify|eligib\w*|how much (will|would|can|could)|entitled|dispute|negotiat\w*|chances|make sure (it|they) (pays?|approve))\b/.test(t) },

  // ---------------------------------------------------------------- lethal how-to
  { id: "let.howto", category: "lethal", test: (t) => new RegExp(String.raw`${HOWTO.source}.{0,40}\b${LETHAL_VERB}\b.{0,12}\b(them|it|one|that|this|him|her|${PREDATOR})\b`).test(t) && !/\b(non-?lethal|without (killing|harming|hurting))\b/.test(t) },
  { id: "let.intent", category: "lethal", test: re(new RegExp(String.raw`\b(shoot|kill|trap|poison|hunt|cull|get rid of|take out|eliminate|exterminate|wipe out)\b.{0,15}\b(the |that |this |those |these |a |any |all (the )?)?${PREDATOR}`)) },
  { id: "let.removal", category: "lethal", test: (t) => /\b(lethal (removal|control|take|methods?|options?)|remove the (wolf|wolves|pack))\b/.test(t) && !EXPLAIN.test(t) && !/\b(has|have|did|were there|any|near me|near my|layer|data|map)\b/.test(t) },

  // ---------------------------------------------------------------- veterinary
  { id: "vet.drug", category: "veterinary", test: re(/\b(dose|doses|dosage|dosing|mg\/kg|ml\/kg|cc'?s?|\d+\s?(mg|ml|cc)|antibiotics?|penicillin|oxytetracycline|la-?200|banamine|flunixin|ivermectin|meloxicam|sedat\w*|tranquiliz\w*|anesthe\w*|lidocaine|prescri\w*|medicat\w*|drugs?|what (shot|medicine) (should|do|can) i give|what (should|can|do) i give (her|him|it|them|my|the))\b/) },
  { id: "vet.treat", category: "veterinary", test: re(/\b(diagnos\w*|treat(ing|ment)?|stitch(es)?|sutur\w*|clean (the|a|her|his|its) wound|wound care|euthani[sz]\w*|put (her|him|it) down|infect(ed|ion)|abscess)\b.{0,40}\b(calf|calves|cow|cows|ewe|ewes|lamb|lambs|sheep|goat|horse|dog|heifer|steer|bull|animal|wound|bite|injur\w*)\b|\b(is (she|he|it) going to (live|die|make it)|will (she|he|it) (live|survive)|put (her|him|it|them) down|put down (the|my|a|this|that) \w+|put (the|my|a|this|that) \w+ down)\b/) },
  { id: "vet.infected", category: "veterinary", test: re(/\b(is|could|might) (it|she|he|the (wound|bite|leg|cut)) (be )?(infected|broken|fractured|septic|abscessed)\b|\bwhat (antibiotic|medicine|medication|drug)\b/) },
  { id: "vet.sick", category: "veterinary", test: re(/\b(what'?s wrong with|is (my|the|this) (cow|calf|ewe|lamb|sheep|horse|dog|heifer|steer|bull|goat) (sick|dying|ok|okay|injured|going to)|why is (my|the) (cow|calf|ewe|lamb|sheep|horse|dog|heifer|steer|bull|goat) (limping|bleeding|not eating|down))\b/) },

  // ---------------------------------------------------------------- financial
  { id: "fin.money", category: "financial", test: re(/\b(insurance|insure|insurer|premiums?|deductible|tax(es)?|write[- ]?off|tax deduct\w*|invest\w*|loans?|mortgage|interest rate|stock market|stocks|crypto|bitcoin|financial (advice|planning)|cattle futures|futures|hedg(e|ing)|sell (my|the) (herd|cattle|calves|sheep)|cattle prices?|price of (cattle|calves|beef|lambs)|appraisal|livestock indemnity program|\blip\b|\blfp\b)\b/) },

  // ---------------------------------------------------------------- contested
  { id: "con.opinion", category: "contested", test: re(/\b(your|you'?re) (opinion|view|take|stance|position|personal view)\b|\bwhat do you (think|believe|feel) about\b|\bdo you (support|oppose|agree|like|hate)\b/) },
  { id: "con.should", category: "contested", test: re(new RegExp(String.raw`\b(should|shouldn't)\b.{0,10}\b(we|they|the (state|government|agency|agencies|feds)|wolves|${PREDATOR})\b.{0,40}\b(be )?(delist\w*|relist\w*|reintroduc\w*|removed|eradicat\w*|hunted|banned|protected|allowed|managed)\b`)) },
  { id: "con.value", category: "contested", test: re(new RegExp(String.raw`\b(are|is)\b.{0,6}\b(${PREDATOR}|ranchers|environmentalists|conservationists|activists)\b.{0,6}\b(good|bad|evil|a menace|vermin|pests|the problem|to blame|right|wrong)\b|\bwho is (right|to blame)\b|\b(pro|anti)[- ]?wolf\b`)) },

  // ---------------------------------------------------------------- off topic
  { id: "off.create", category: "off_topic", test: re(/\b(write|compose|generate|make)\b.{0,30}\b(poem|song|story|essay|code|script|program|joke|rap|haiku|limerick|cover letter|tweet)\b/) },
  { id: "off.subject", category: "off_topic", test: re(/\b(python|javascript|typescript|sql query|html|css|regex|c\+\+|election|president|democrats?|republicans?|celebrit\w*|movies?|netflix|football|basketball|baseball|nfl|nba|super bowl|recipe|homework|math problem|translate (this|that|into)|horoscope|lottery)\b/) },
];

const EMERGENCY = /\b(right now|happening now|being attacked|attacking (my|the|our)|in progress|emergency|someone (is )?(hurt|injured)|i'?m (hurt|injured|in danger))\b/;

export function classifyInput(text: string): GuardDecision {
  // "Camera trap" is a trail camera, not a trap.
  const t = normalize(text).replace(/\bcamera[- ]traps?\b/g, "trail camera");
  const emergency = EMERGENCY.test(t);
  for (const r of RULES) {
    if (r.test(t)) return { action: "decline", category: r.category, rule: r.id, emergency };
  }
  return { action: "allow", emergency };
}

/** Rule ids, for documentation and tests. */
export const RULE_IDS = RULES.map((r) => `${r.category}:${r.id}`);
