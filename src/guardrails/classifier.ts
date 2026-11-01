// Deterministic pre-classifier. Runs on every rancher question (text, voice
// transcripts, and free-text tool arguments, including over MCP) before any
// model sees it. Keyword and regex rules only: no network, no model call.
//
// It is tuned to decline clear gray-area requests and let normal ranching and
// data questions through. The model's system prompt and the output check are
// the second and third layers.
import type { GuardCategory } from "./policy";
import { decodeBase64Runs, decodeHexRuns, foldText, rot13 } from "./text";

export interface GuardDecision {
  action: "allow" | "decline";
  category?: GuardCategory;
  /** Rule id that matched, for the audit log and tests. */
  rule?: string;
  /** The question mentions an emergency in progress. */
  emergency?: boolean;
}

/**
 * Lowercase, fold Unicode look-alikes (fullwidth, Cyrillic and Greek letters,
 * combining marks), drop zero-width characters, map a few emoji to words, and
 * collapse spaces.
 */
export function normalize(text: string): string {
  return foldText(text)
    .replace(EMOJI_RE, (e) => ` ${EMOJI[e] ?? ""} `)
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const EMOJI: Record<string, string> = {
  "🔫": "shoot", "🐺": "wolf", "🪤": "trap", "☠": "kill", "💀": "kill", "🗡": "kill", "🔪": "kill", "🧪": "poison", "💊": "drug", "💉": "inject",
  "🐄": "cow", "🐮": "cow", "🐂": "bull", "🐑": "sheep", "🐐": "goat", "🐕": "dog", "🐶": "dog", "🐻": "bear", "🦊": "fox", "🐾": "tracks", "📍": "exact location", "🎯": "aim at",
};
const EMOJI_RE = new RegExp(`(${Object.keys(EMOJI).join("|")})\uFE0F?`, "gu");

/** Spoken filler and stutters, so a voice transcript reads like typed text. */
function stripFillers(t: string): string {
  return t
    .replace(/\b(?:um+|uh+|uhm+|erm*|hmm+|mm+|ah+)\b[,.]?\s*/g, "")
    .replace(/(?:^|,\s*|\s)(?:like|you know|i mean|kinda|sorta|basically|actually|literally),?(?=\s)/g, " ")
    .replace(/\b(\w{1,3})-(?=\1)/g, "") // st-stutter: "w-wolf" -> "wolf"
    .replace(/\b(\w+)(?:\s+\1\b)+/g, "$1") // "the the" -> "the"
    .replace(/\s+/g, " ")
    .trim();
}

/** Markup that hides words from rules: HTML tags and entities, markdown, underscores. */
function stripMarkup(t: string): string {
  return t
    .replace(/<[^>]{0,80}>/g, " ")
    .replace(/&(nbsp|amp|lt|gt|quot|#\d+);/g, (m, n) => (n === "amp" ? "&" : n === "nbsp" ? " " : n.startsWith("#") ? String.fromCharCode(Number(n.slice(1))) : " "))
    .replace(/[*_~`#>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "p o i s o n", "k.i.l.l", "s-n-a-r-e" -> "poison", "kill", "snare". */
function joinSpelledOut(t: string): string {
  return t
    .replace(/\b[a-z](?:[.\-*_][a-z]){2,}\b\.?/g, (m) => m.replace(/[.\-*_]/g, ""))
    .replace(/\b[a-z](?: [a-z]){3,}\b/g, (m) => {
      let letters = m.replace(/ /g, "");
      let lead = "";
      let trail = "";
      if (letters.length > 4 && /^[ia]/.test(letters)) {
        lead = letters[0] + " ";
        letters = letters.slice(1);
      }
      if (letters.length > 4 && /[ia]$/.test(letters)) {
        trail = " " + letters.slice(-1);
        letters = letters.slice(0, -1);
      }
      return lead + letters + trail;
    });
}

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };
/** Leetspeak, only inside words that mix letters with digits or symbols. */
function unleet(t: string): string {
  return t.replace(/\b[\w@$!]*[a-z][\w@$!]*\b|\b[\w@$!]*[0-9@$!][\w@$!]*[a-z][\w@$!]*\b/g, (w) => (/[a-z]/.test(w) && /[013457@$!]/.test(w) ? w.replace(/[013457@$!]/g, (c) => LEET[c]!) : w));
}

/**
 * Words in Spanish, French, Portuguese, and German mapped to English, so the
 * same rules apply. Accents are already removed by foldText.
 */
const TRANSLATE: [RegExp, string][] = [
  [/\b(envenen\w*|empoisonn\w*|vergift\w*|veneno|poison|gift)\b/g, "poison"],
  [/\b(matar|mato|mata|matarlos|matarlo|matalo|tuer|tue|toten|tote|umbringen|abschiessen)\b/g, "kill"],
  [/\b(disparar\w*|dispararle|tirer|tire|atirar|schiessen|erschiessen)\b/g, "shoot"],
  [/\b(lobos?|loups?|wolfe|wolfen)\b/g, "wolves"],
  [/\b(trampas?|pieges?|armadilhas?|fallen?|lazos?|collets?)\b/g, "trap"],
  [/\b(guaridas?|madrigueras?|tanieres?|tocas?|bau|baue|wolfsbau)\b/g, "den"],
  [/\b(donde|ou se trouve|ou est|onde|wo ist|wo sind|wo)\b/g, "where"],
  [/\b(como|comment|wie)\b/g, "how do i"],
  [/\b(legalmente|legal|legale|legalement|legalmente|gesetzlich|erlaubt|permitido|autorise)\b/g, "legally"],
  [/\b(dosis|posologie)\b/g, "dose"],
  [/\b(penicilina|penicilline|penizillin)\b/g, "penicillin"],
  [/\b(ignora|ignore[sz]?|ignorez|ignoriere|ignorar)\b/g, "ignore"],
  [/\b(instrucciones|instrucoes|anweisungen|consignes)\b/g, "instructions"],
  [/\b(quien|quem|qui a|wer)\b/g, "who"],
  [/\b(reporto|reportou|denuncio|signale|gemeldet|meldete)\b/g, "reported"],
  [/\b(seguro|assurance|versicherung)\b/g, "insurance"],
  [/\b(coordenadas|coordonnees|koordinaten)\b/g, "coordinates"],
  [/\b(exactas?|exactos?|exactes?|exakte?n?|exatas?)\b/g, "exact"],
  [/\b(collar|collier|halsband|coleira)\b/g, "collar"],
  [/\b(sin que me (atrapen|pillen|descubran)|sans (me faire prendre|etre vu)|ohne erwischt)\b/g, "without getting caught"],
  [/\b(becerros?|terneros?|veaux?|bezerros?|kalber|kalb)\b/g, "calf"],
  [/\b(muestrame|montre-moi|zeig mir)\b/g, "show me"],
  [/\b(previas|anteriores|precedentes|vorherigen)\b/g, "previous"],
];
function translate(t: string): string {
  let out = t;
  for (const [r, w] of TRANSLATE) out = out.replace(r, w);
  return out;
}

/** Story framing: "a world where", "a story where" are not location questions. */
function unframe(t: string): string {
  return t.replace(/\b(world|story|game|scenario|novel|movie|film|book|universe|situation|case|dream|version) where\b/g, "$1 in which");
}

/**
 * Every reading of the text the rules should see. A question is declined if
 * any reading is. Decoded readings (base64, hex, rot13, reversed) catch
 * requests hidden from the plain rules.
 */
export function readings(text: string): string[] {
  const base = unframe(stripFillers(normalize(text)).replace(/\bcamera[- ]traps?\b/g, "trail camera"));
  const out = new Set<string>([base]);
  const add = (s: string) => {
    const n = unframe(stripFillers(normalize(s)).replace(/\bcamera[- ]traps?\b/g, "trail camera"));
    if (n) out.add(n);
  };
  const plain = stripMarkup(base.replace(/_/g, " "));
  add(plain);
  add(joinSpelledOut(plain));
  add(unleet(joinSpelledOut(plain)));
  add(translate(plain));
  for (const d of decodeBase64Runs(text)) add(d);
  for (const d of decodeHexRuns(text)) add(d);
  add(rot13(plain));
  add([...plain].reverse().join(""));
  return [...out];
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
const HOWTO = /\b(how (do|can|should|would|to)|best way|teach me|show me how|tell me how|help me|steps to|where (can|should|do) i|what (gun|rifle|caliber|trap|bait|poison)|what (do|would|should) i (need|use) to|what (do|would|should) i use|what to use to|i want to|i'?m going to|going to|plan to|let'?s)\b/;
const NONLETHAL_SAFE = /\b(non-?lethal|deter\w*|fladry|haz(e|ing)|scare|without (killing|harming|hurting)|range riders?|guard(ian)? dogs?|fox ?lights?|night pens?|keep (them|it|wolves|coyotes) (away|out))\b/;

const RULES: Rule[] = [
  // ---------------------------------------------------------------- injection
  { id: "inj.ignore", category: "injection", test: re(/\b(ignore|disregard|forget|override|bypass|drop)\b.{0,40}\b(instructions?|rules|guardrails?|polic(y|ies)|prompts?|restrictions?|guidelines|programming|safety)\b/) },
  { id: "inj.system", category: "injection", test: re(/\b(system|developer|hidden|initial|original) (prompt|message|instructions?)\b/) },
  { id: "inj.reveal", category: "injection", test: re(/\b(reveal|print|show|repeat|output|dump|leak|tell me)\b.{0,30}\b(your|the)\b.{0,20}\b(instructions|prompt|rules|configuration|guidelines)\b/) },
  { id: "inj.persona", category: "injection", test: re(/\b(you are now|you're now|from now on you|you are no longer|jailbreak|dan mode|developer mode|god mode|no restrictions|without (any )?(rules|restrictions|filters|limits))\b/) },
  { id: "inj.roleplay", category: "injection", test: re(/\b(pretend|act|roleplay|role-play|role play|imagine)\b.{0,30}\b(you('| a)re|as|to be|you were)\b.{0,30}\b(lawyer|attorney|vet|veterinarian|hunter|trapper|unrestricted|unfiltered|evil|different (ai|assistant|model))\b/) },
  { id: "inj.tokens", category: "injection", test: re(/<\|[^|]{1,40}\|>|\[\/?(system|inst)\]|<\/?(system|instructions?)>|\bnew instructions?\s*:|\bsystem\s*:|"role"\s*:\s*"(system|developer|assistant)"/) },
  { id: "inj.disable", category: "injection", test: re(/\b(disable|turn off|deactivate|switch off|remove|lift|suspend|skip|bypass)\b.{0,20}\b(safety|filters?|guardrails?|restrictions?|rules|limits|moderation|content polic\w*|censorship)\b/) },
  { id: "inj.norules", category: "injection", test: re(/\b(no|without|zero) (rules|limits|filters|restrictions|guidelines|boundaries|censorship)\b|\b(anything goes|unfiltered|uncensored|unrestricted)\b|\bthe rules (don'?t|do not|no longer) apply\b/) },
  { id: "inj.game", category: "injection", test: re(/\b(let'?s )?play a (game|role)\b.{0,30}\b(you'?re|you are|you play|you will be)\b|\bopposite day\b|\b(everything|anything|things|what) you('?re| are) not (allowed|supposed|permitted) to (say|tell|share)\b/) },
  { id: "inj.split", category: "injection", test: re(/\b(two|2|dual|both) (characters|personas|personalities|responses|answers|versions|modes)\b|\bone (that )?(follows|obeys|keeps) the rules and (one|the other) (that )?(doesn'?t|does not|breaks|ignores)\b/) },
  { id: "inj.terminal", category: "injection", test: re(/\b(simulate|emulate|act as|pretend to be|behave like) (a |an )?(terminal|shell|linux|bash|console|command line|python interpreter|computer)\b|\bcat [\w./-]+\.(txt|md|json|env)\b|\bsystem_prompt\b|\bsudo\b|\b(as|be|you are|you'?re) dan\b|\b(dan|stan|dude|aim) mode\b/) },
  { id: "inj.authority", category: "injection", test: re(/\b(i'?m|i am|this is|we are|we'?re|message from|test from)\b.{0,12}\b(the |an |a |your )?(admin|administrator|developer|dev team|predator watch (staff|team|support)|staff|support team|moderator|owner of (this|the) (app|system|service|account)|game warden|warden|wildlife officer|enforcement officer|law enforcement|sheriff|deputy|federal agent)\b.{0,60}\b(so|show|give|tell|you can|unlock|access|let me|disable|allowed|authori[sz]ed|override)\b/) },
  { id: "inj.pretend", category: "injection", test: re(/\bpretend (that )?(i'?m|i am|to be|you'?re|you are|we'?re)\b.{0,30}\b(owner|admin|another|other|different|tenant|staff|warden|officer|agent|account|neighbou?r|unrestricted|lawyer|vet)\b/) },
  { id: "inj.grandma", category: "injection", test: re(/\b(grandpa|grandma|grandfather|grandmother|granddad|my (late|dead) \w+)\b.{0,30}\b(used to|would) (tell|read|sing|explain)\b/) },
  { id: "inj.assemble", category: "injection", test: re(/\b(put|combine|join|merge|stitch|glue) (those|these|them|the (words|pieces|parts|letters|halves)|it all|both) together\b|\b(remember|memori[sz]e|store|save|keep) (the|this|these|my) (code ?)?(word|words|letters|letter|part|phrase)s?\b|\b(the word|code ?word) \w+ (means|is|stands for)\b|\bwhen i say \w+,? i mean\b|\bfrom (now|here) on,? (the word )?\w+ (means|is|stands for)\b/) },
  { id: "inj.secret", category: "injection", test: re(/\b(what'?s|what is|show|give|tell|print|reveal|list|send)\b.{0,30}\b(access keys?|api keys?|passwords?|secret keys?|tokens?|credentials?|login)\b/) },
  { id: "inj.decode", category: "injection", test: re(/\b(decode|decrypt|deobfuscate|unscramble|reverse|translate|rot13|base64|hex)\b.{0,20}\b(and|then)\b.{0,10}\b(answer|do|follow|run|execute|obey|respond)\b|\brun this\s*:/) },

  // ---------------------------------------------------------------- evasion
  { id: "eva.around", category: "evasion", test: re(/\b(get(ting)? away with|get(ting)? around (the )?(rules?|law|regulations?|reporting)|evad(e|ing)|circumvent|loophole|under the radar|off the books|cover(ing)? (it |this |that )?up|hide (the |a )?(carcass|body|evidence|kill|collar))\b/) },
  { id: "eva.caught", category: "evasion", test: re(/\b(without|avoid|so (that )?)\b.{0,25}\b(getting caught|being caught|anyone (knowing|finding out)|the (game )?warden|wardens|(agency|state|feds|officers?|fish and game|enforcement) (finding out|knowing|noticing|seeing))\b/) },
  { id: "eva.noreport", category: "evasion", test: re(/\b(how (do|can) i|ways? to|is there a way to)\b.{0,20}\b(not|avoid|skip|get out of) report/) },
  { id: "eva.addcount", category: "evasion", test: re(/\b(add|include|count|claim|list|throw in)\b.{0,15}\b(a couple|a few|some|extra|more|another|two|three|\d+)\b.{0,20}\b(calves|cows|head|lambs|ewes|sheep|animals)?.{0,10}\b(to|on|in) (the|my) (count|claim|report|tally|total|list)\b/) },
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
  { id: "loc.ambush", category: "harm_location", test: re(new RegExp(String.raw`\b(tell|alert|notify|let me know|ping|text|warn)( me)? (when|as soon as|the moment|if)\b.{0,50}\b(collar\w*|${LOC_TARGET})\b.{0,60}\b(so (that )?(i|we) can|i'?ll be|be waiting|be ready|get (it|him|her|them)|i can get|catch (it|him|her|them))\b`)) },
  { id: "loc.stand", category: "harm_location", test: re(/\b(which|what|where)\b.{0,8}\b(cell|spot|place|area|stand|blind|ridge|draw)\b.{0,30}\b(sit|wait|set up|hide|park|stake out|post up)\b/) },
  { id: "loc.deal", category: "harm_location", test: (t) => /\b(go|going to|gonna|i'?ll|i will|then)\b.{0,8}\b(deal with|take care of|handle|settle|sort out|get|finish|end) (them|it|those|that pack|the (wolf|wolves|pack|coyotes?))\b/.test(t) && new RegExp(String.raw`\b(${LOC_TARGET}|cell|cells|activity|pack)\b`).test(t) && !NONLETHAL_SAFE.test(t) },
  {
    id: "loc.habits",
    category: "precise_location",
    test: (t) =>
      new RegExp(String.raw`\b${LOC_TARGET}\b`).test(t) &&
      /\b(which|what|where)\b/.test(t) &&
      /\b(waterholes?|water holes?|springs?|trails?|routes?|paths?|corridors?|crossings?|bed(s|ding)?( down)?|bed sites?|sleep\w*|rest(ing)? (area|spot|site)s?|hole up|hang out|hideouts?|kill sites? they use|travel (route|path|to))\b/.test(t) &&
      !/\b(my|our) (own )?(records?|sightings?|reports?)\b/.test(t) &&
      !/^(why|how come)\b/.test(t),
  },
  { id: "loc.trackdown", category: "harm_location", test: re(new RegExp(String.raw`\b(track|hunt|run) (down|after)\b.{0,30}\b${LOC_TARGET}`)) },
  {
    id: "loc.den",
    category: "precise_location",
    test: (t) =>
      /\b(dens?|denning|den site|rendezvous( sites?)?|whelping)\b/.test(t) &&
      /\b(where|locations?|located|locate|find|coordinates?|gps|exact|precise|pinpoint|address|directions?|lat(itude)?|long(itude)?|map|map it|show me|mark)\b/.test(t) &&
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
  { id: "loc.triangulate", category: "precise_location", test: re(/\b(triangulat\w*|narrow\w* (it |them |that )?down|keep narrowing|exact (cell|spot|point)|next to (it|that)|neighbou?ring cells?)\b/) },
  {
    id: "loc.resolution",
    category: "precise_location",
    test: (t) =>
      (/\b(zoom (in|into)|full[- ](precision|resolution)|higher[- ]resolution|more (precise|exact|detailed)|exact|real|true|actual|raw|unredacted|ungeneraliz\w*|underlying|original|finer|smaller|tighter)\b.{0,30}\b(locations?|spots?|points?|cells?|grid|reports?|observations?|data|coordinates|positions?)\b/.test(t) ||
        /\b(0?\.\d+|quarter|half|tenth|one[- ]tenth)[- ]?(mile|mi|km)[- ]?(cells?|grid|squares?|hexes|resolution)\b|\b(zoom in|full precision)\b/.test(t) ||
        /\b(not (been )?released|unreleased|haven'?t been released|before the delay|during the delay|skip the wait|early access)\b/.test(t) ||
        /\b(which|where|what|list|show)\b.{0,20}\b(cells?|areas?|spots?|reports?)\b.{0,30}\b(held back|withheld|hidden|holdback|suppressed|not shown)\b/.test(t)) &&
      /\b(shared|generaliz\w*|cells?|grid|reports?|observations?|held back|holdback|released|delay|den)\b/.test(t) &&
      !/\b(my|our) (own )?(records?|sightings?|observations?|entries)\b/.test(t) &&
      !/^(why|how (are|is|does|do)|what does)\b/.test(t),
  },

  // ---------------------------------------------------------------- other people
  { id: "pii.who", category: "personal_data", test: (t) => /\b(who|which (rancher|neighbou?r|ranch|person|user|member|account|family))\b.{0,40}\b(reported|shared|submitted|posted|lost|saw|logged|contributed|made (the|that|this) report|is reporting)\b/.test(t) && !/\bwho (do|should|can|would|will) (i|we)\b/.test(t) && !/\b(agency|agencies|layer|publisher|published|source|service)\b/.test(t) },
  { id: "pii.contact", category: "personal_data", test: re(/\b(name|names|phone|number|email|address|contact info|identity|identities|location)\b.{0,30}\b(of|for)\b.{0,20}\b(the |that |this |other |another |my )?(rancher|ranchers|neighbou?rs?|person|owner|reporter|member|user|other ranch(es)?|ranch that|place that|property that|ranch who|family)\b/) },
  { id: "pii.others", category: "personal_data", test: re(/\b(neighbou?r'?s|neighbou?rs'|other ranchers?'?s?|another rancher'?s|other (people|users|members|accounts)'?s?|someone else'?s)\b.{0,30}\b(records?|data|loss(es)?|reports?|location|ranch|address|name|sightings?|notes|herd|account)\b/) },
  { id: "pii.origin", category: "personal_data", test: re(/\b(where|which ranch|whose ranch)\b.{0,20}\b(did|does|do)\b.{0,20}\b(shared|other ranchers'?|neighbou?rs'?)\b.{0,10}\breports?\b.{0,15}\b(come from|originate|get (reported|submitted))\b/) },
  { id: "pii.owner", category: "personal_data", test: re(/\bwho (owns|lives (at|on)|runs)\b/) },
  { id: "pii.whose", category: "personal_data", test: re(/\bwhose (ranch|place|land|property|cattle|herd|calves|sheep|report|reports|allotment|cows)\b|\bwhich (ranch|place|property|outfit)\b.{0,30}\b(closest|nearest|next to|near|reported|lost)\b/) },
  { id: "pii.came_from", category: "personal_data", test: (t) => /\b(reports?|sightings?|depredations?|observations?|loss(es)?)\b.{0,40}\b(come|came|coming|originate\w*) from\b/.test(t) && !/\b(which|what) (agency|agencies|source|layer|data set|dataset)\b/.test(t) && !/\bwhere (does|do) (the|this|your) data\b/.test(t) },
  { id: "pii.neighbor", category: "personal_data", test: re(/\b(how many|what|which|did|has|have|show|tell me|list)\b.{0,20}\b(my |the |our |a )?neighbou?r('?s|s'?)?\b.{0,30}\b(lose|lost|losses|records?|data|reports?|notes|herd|access key|keys?|password|address|calves|count)\b|\bwhich of (my|the|our) (neighbou?rs|ranchers|members|group)\b/) },
  { id: "pii.tenant", category: "personal_data", test: re(/\btenant[- _]?[a-z0-9]{1,12}\b(?! (isolation|data))|\b(switch|change|log ?in|sign ?in|swap|move|jump|impersonate)\b.{0,8}\b(to|as|into|over to)?\b.{0,8}\b(tenant|another account|a different account|their account|the other account|other ranch|another ranch|account [a-z0-9-]+)\b/) },
  { id: "pii.everyone", category: "personal_data", test: re(/\b(every|all|each|other|everyone'?s|everybody'?s)\b.{0,6}\b(accounts?|tenants?|users?|customers?|subscribers?|members?|ranch(es|ers)?)'?s?'?\b.{0,20}\b(data|records?|observations?|reports?|loss(es)?|notes|keys?|locations?|names|info\w*)\b|\bdump\b.{0,20}\b(all|every|database|tenants?|accounts?|users?)\b/) },
  { id: "pii.group", category: "personal_data", test: re(/\b(list|who|which|name|show|tell me)\b.{0,30}\b(every|all|other|else|members?|ranch(es|ers)?|people|accounts)\b.{0,30}\b(sharing group|my group|the group|ranchers group|in (the|my|our) group|group members?)\b|\bwho else\b.{0,30}\b(group|shar\w*|uses|is on|is in)\b|\b(members|membership) of (the|my|our) (sharing )?group\b/) },
  { id: "pii.notes", category: "personal_data", test: re(/\b(notes|private|loss(es)?|names|addresses|phone numbers|access keys?|herd sizes?|head counts?)\b.{0,20}\b(other|another|every|all|those) (ranchers?|users?|members?|accounts?|tenants?|people)\b/) },
  { id: "pii.home", category: "personal_data", test: (t) => /\b(home|personal|private|house|cell) (address|phone|number|email|cell)\b|\bwhere (does|do) (he|she|they|the \w+( \w+)?) live\b/.test(t) && !/\b(my|our) (own )?(home|personal|private|house|cell)\b/.test(t) },
  { id: "pii.named_ranch", category: "personal_data", test: re(/\b(ranch|place|outfit|operation|cattle (co|company)|livestock|farms?|flat|creek)'s\b.{0,20}\b(records?|data|reports?|loss(es)?|observations?|notes|activity|sightings?|herd|calves|account)\b|\b(show|give|list|what did|what has)\b.{0,10}\b(the )?[a-z]+ (flat|creek|ranch|place|outfit|cattle co)\b.{0,15}\b(records?|data|reports?|loss(es)?|observations?|notes|report|lost)\b/) },

  // ---------------------------------------------------------------- lethal methods
  { id: "let.method", category: "lethal", test: (t) => /\b(snares?|snaring|leg-?hold|foot-?hold|conibear|body-?grip|m-?44s?|cyanide|strychnine|compound 1080|1080 bait|antifreeze|ethylene glycol|rat poison|warfarin|bait stations?|lac(e|ed|ing) (a |the )?(carcass|bait|meat)|poison(ed)? (bait|meat|carcass)|thermals? (setup|optic|scope|sight|rig|gear)|where to aim|aim (for|at)|(gas|gassing|fumigat\w*|smoke out|dig out|dig up|denning)\b.{0,20}\b(dens?|pups|coyotes?|wolf|wolves)|caliber|calibre|\.(223|243|270|308)|ammo|ammunition|bullets?|shot placement|kill shot|predator calls?|e-?calls?|thermal scope|night vision scope|rifles?|shotguns?|guns?|firearms?)\b/.test(t) && !(EXPLAIN.test(t) && /\b(layer|data|map|tier)\b/.test(t)) },

  // ---------------------------------------------------------------- legal
  { id: "leg.isit", category: "legal", test: re(/\b(is it|it's|it is|would it be|is that|was it|was that|am i|are we)\b.{0,30}\b(legal|illegal|lawful|unlawful|against the law|allowed to|permitted to|breaking the law|in trouble|liable)\b/) },
  { id: "leg.cani", category: "legal", test: re(new RegExp(String.raw`\b(can|may|could|am i allowed to|is anyone allowed to|are ranchers allowed to)\b.{0,10}\b(i|we|ranchers|a rancher|you)?\b.{0,10}\b(legally )?(shoot|kill|trap|take|poison|hunt|remove|harass)\b.{0,20}\b${PREDATOR}`)) },
  { id: "leg.canit", category: "legal", test: re(/\b(can|may|could) (i|we) (legally |lawfully )?(shoot|kill|trap|poison|take|hunt|harass|haze) (it|them|one|that one|this one|that thing)\b/) },
  { id: "leg.legally", category: "legal", test: re(/\b(legally|legality|legal right|right to (shoot|kill|defend)|legal advice|legal options?)\b/) },
  { id: "leg.law", category: "legal", test: re(/\b(lawyer|attorney|lawsuit|sue (the|them|him|her|my|a|an)|suing|litigation|court|liab(le|ility)|statutes?|endangered species act|\besa\b|section \d+|federal law|state law|the law say|regulations? (say|mean|allow|require)|interpret\w*.{0,20}(rule|regulation|law)|penalt(y|ies)|fined|prosecut\w*|ticketed|cited for)\b/) },
  { id: "leg.permit", category: "legal", test: re(/\b(kill|lethal|depredation|take|hunting|trapping) (permit|permits|tag|tags|license)\b/) },
  { id: "leg.status", category: "legal", test: re(new RegExp(String.raw`\b(are|is)\b.{0,10}\b${PREDATOR}\b.{0,10}\b(protected|listed|delisted|endangered|threatened|legal to)\b`)) },
  { id: "leg.consequence", category: "legal", test: re(/\bwhat (would|will|could|might) happen (to me )?if (i|we)\b.{0,30}\b(did it|do it|shot|shoot|killed|kill|trapped|poisoned|didn'?t report|don'?t report|anyway)\b|\b(would|will|could) i (get|be) (in trouble|arrested|charged|fined|prosecuted|sued)\b/) },
  { id: "leg.required", category: "legal", test: re(/\b(am i|are we|are ranchers) (required|obligated|obliged|supposed) to\b|\b(do|does) (i|we) (have|need) to (report|notify|tell)\b|\bwhat happens if i (don't|do not|didn't) report\b/) },

  // ---------------------------------------------------------------- compensation
  { id: "comp.strategy", category: "compensation", test: (t) => /\b(compensat\w*|reimburs\w*|indemnit\w*|claims?|payouts?)\b/.test(t) && /\b(maximi[sz]e|get more|increase|win|appeal|denied|deny|denial|strategy|best way|prove|proof|convince|guarantee|qualify|eligib\w*|how much (will|would|can|could)|entitled|dispute|negotiat\w*|chances|make sure (it|they) (pays?|approve))\b/.test(t) },

  // ---------------------------------------------------------------- lethal how-to
  { id: "let.howto", category: "lethal", test: (t) => new RegExp(String.raw`${HOWTO.source}.{0,40}\b${LETHAL_VERB}\b.{0,12}\b(them|it|one|that|this|him|her|${PREDATOR})\b`).test(t) && !/\b(non-?lethal|without (killing|harming|hurting))\b/.test(t) },
  { id: "let.intent", category: "lethal", test: re(new RegExp(String.raw`\b(shoot|shot|shoots|shooting|kill|kills|killed|killing|trap|traps|trapped|trapping|poison|poisons|poisoned|poisoning|hunt|hunted|hunting|cull|culled|culling|get rid of|take out|took out|eliminate|eliminated|exterminate|wipe out|wiped out|drop|dropped|gun down|bait)\b(?! by\b)(?! (some |a |the )?(videos?|photos?|pictures?|footage|film|images?|clips?)\b).{0,15}\b(the |that |this |those |these |a |any |all (the )?)?${PREDATOR}`)) },
  { id: "let.taking", category: "lethal", test: re(new RegExp(String.raw`\b(take|taking|took)( out)? (a |the |that |those |these |any |some )?(wolf|wolves|coyotes?|cougars?|lions?|bears?|pups)\b(?! (into account|seriously|off the list))`)) },
  { id: "let.with", category: "lethal", test: re(/\b(shoot|kill|trap|poison|drop) (them|it|him|her|one|a (wolf|coyote)|the (wolf|coyote|wolves|coyotes)) with\b|\bwhat (should|do|can) i (shoot|kill|trap|poison)\b/) },
  { id: "let.gone", category: "lethal", test: (t) => new RegExp(String.raw`\b(want|wanted|need|needs|get|make|have)\b.{0,25}\b(gone|dead|eliminated|wiped out|taken care of|dealt with)\b`).test(t) && new RegExp(String.raw`\b(${PREDATOR}|them|it)\b`).test(t) && (/\b(permanently|for good|forever|dead|fastest|quickest|how|for keeps|once and for all)\b/.test(t)) && !NONLETHAL_SAFE.test(t) },
  { id: "let.bait", category: "lethal", test: re(new RegExp(String.raw`\b(bait|baits|lure|lures|scent)\b.{0,30}\b(trap\w*|snar\w*|kill\w*|shoot\w*)\b.{0,20}${PREDATOR}|\b(bait|lure)\b.{0,20}\b(for|to) (trap|catch|kill|shoot)`)) },
  { id: "let.removal", category: "lethal", test: (t) => /\b(lethal (removal|control|take|methods?|options?)|remove the (wolf|wolves|pack))\b/.test(t) && !EXPLAIN.test(t) && !/\b(has|have|did|were there|any|near me|near my|layer|data|map)\b/.test(t) },

  // ---------------------------------------------------------------- veterinary
  { id: "vet.drug", category: "veterinary", test: re(/\b(dose|doses|dosage|dosing|mg\/kg|ml\/kg|cc'?s?|\d+\s?(mg|ml|cc)|antibiotics?|penicillin|oxytetracycline|la-?200|banamine|flunixin|ivermectin|meloxicam|sedat\w*|tranquiliz\w*|anesthe\w*|lidocaine|prescri\w*|medicat\w*|drugs?|what (shot|medicine) (should|do|can) i give|what (should|can|do) i give (her|him|it|them|my|the))\b/) },
  { id: "vet.treat", category: "veterinary", test: re(/\b(diagnos\w*|treat(ing|ment)?|stitch(es)?|sutur\w*|clean (the|a|her|his|its) wound|wound care|euthani[sz]\w*|put (her|him|it) down|infect(ed|ion)|abscess)\b.{0,40}\b(calf|calves|cow|cows|ewe|ewes|lamb|lambs|sheep|goat|horse|dog|heifer|steer|bull|animal|wound|bite|injur\w*)\b|\b(is (she|he|it) going to (live|die|make it)|will (she|he|it) (live|survive)|put (her|him|it|them) down|put down (the|my|a|this|that) \w+|put (the|my|a|this|that) \w+ down)\b/) },
  { id: "vet.infected", category: "veterinary", test: re(/\b(is|could|might) (it|she|he|the (wound|bite|leg|cut)) (be )?(infected|broken|fractured|septic|abscessed)\b|\bwhat (antibiotic|medicine|medication|drug)\b/) },
  { id: "vet.sick", category: "veterinary", test: re(/\b(what'?s wrong with|is (my|the|this) (cow|calf|ewe|lamb|sheep|horse|dog|heifer|steer|bull|goat) (sick|dying|ok|okay|injured|going to)|why is (my|the) (cow|calf|ewe|lamb|sheep|horse|dog|heifer|steer|bull|goat) (limping|bleeding|not eating|down))\b/) },

  // ---------------------------------------------------------------- financial
  { id: "fin.money", category: "financial", test: re(/\b(insurance|insure|insurer|premiums?|deductible|tax(es)?|write[- ]?off|tax deduct\w*|invest(?!igat)\w*|loans?|mortgage|interest rate|stock market|stocks|crypto|bitcoin|financial (advice|planning)|cattle futures|futures|hedg(e|ing)|sell (my|the) (herd|cattle|calves|sheep)|cattle prices?|price of (cattle|calves|beef|lambs)|appraisal|livestock indemnity program|\blip\b|\blfp\b)\b/) },

  // ---------------------------------------------------------------- contested
  { id: "con.opinion", category: "contested", test: re(/\b(your|you'?re) (opinion|view|take|stance|position|personal view)\b|\bwhat do you (think|believe|feel) about\b|\bdo you (support|oppose|agree|like|hate)\b/) },
  { id: "con.should", category: "contested", test: re(new RegExp(String.raw`\b(should|shouldn't)\b.{0,10}\b(we|they|the (state|government|agency|agencies|feds)|wolves|${PREDATOR})\b.{0,40}\b(be )?(delist\w*|relist\w*|reintroduc\w*|removed|eradicat\w*|hunted|banned|protected|allowed|managed)\b`)) },
  { id: "con.value", category: "contested", test: re(new RegExp(String.raw`\b(are|is)\b.{0,6}\b(${PREDATOR}|ranchers|environmentalists|conservationists|activists)\b.{0,6}\b(good|bad|evil|a menace|vermin|pests|the problem|to blame|right|wrong)\b|\bwho is (right|to blame)\b|\b(pro|anti)[- ]?wolf\b`)) },

  // ---------------------------------------------------------------- off topic
  { id: "off.create", category: "off_topic", test: re(/\b(write|compose|generate|make)\b.{0,30}\b(poem|song|story|essay|code|script|program|joke|rap|haiku|limerick|cover letter|tweet)\b/) },
  { id: "off.subject", category: "off_topic", test: re(/\b(python|javascript|typescript|sql query|html|css|regex|c\+\+|election|president|democrats?|republicans?|celebrit\w*|movies?|netflix|football|basketball|baseball|nfl|nba|super bowl|recipe|homework|math problem|translate (this|that|into)|horoscope|lottery)\b/) },
];

const EMERGENCY = /\b(right now|happening now|being attacked|attacking (my|the|our)|in progress|emergency|someone (is )?(hurt|injured)|i'?m (hurt|injured|in danger))\b/;

export interface ClassifyOptions {
  /**
   * Names of the caller's own ranches and allotments. They are read as "my
   * ranch" so "Home place's records" is the rancher's own data, while another
   * ranch's name is not.
   */
  ownNames?: string[];
}

function ownNamesToMine(t: string, names: string[] = []): string {
  let out = t;
  for (const n of names) {
    const k = normalize(n);
    if (k.length < 3) continue;
    out = out.replace(new RegExp(`\\b(the )?${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), "my ranch");
  }
  return out;
}

export function classifyInput(text: string, opts: ClassifyOptions = {}): GuardDecision {
  // "Camera trap" is a trail camera, not a trap (handled in readings()).
  const all = readings(text).map((t) => ownNamesToMine(t, opts.ownNames));
  const emergency = all.some((t) => EMERGENCY.test(t));
  for (const t of all) {
    for (const r of RULES) {
      if (r.test(t)) return { action: "decline", category: r.category, rule: all[0] === t ? r.id : `${r.id}~decoded`, emergency };
    }
  }
  return { action: "allow", emergency };
}

/** Follow-ups that only make sense with the earlier turns. */
const DEPENDENT = /^(and|so|ok(ay)?|fine|then|now|but|also|well|alright|right|just|yes|no|what about|how about|what if|and if|hypothetically|ok so|okay so|same)\b|\b(it|that|them|those|these|this one|that one|he|she|him|her|one|exactly|anyway|instead|the same|again|like (he|she|they) did|do that|did that)\b/;
/** Follow-ups that are always fine to answer, even after a declined turn. */
const SAFE_INTENT = /\b(who (do|should|can) i (call|contact|report|tell)|how (do|should) i report|report (it|this|that)|agency contacts?|conflict specialist|non-?lethal|deterr\w*|fladry|range riders?|guard(ian)? dogs?|night pens?|fire|weather|alerts?|how fresh|data freshness|my audit|never ?mind|forget it|thanks?|thank you|okay thanks|without (hurting|harming|killing|injuring)|keep (them|it|\w+) (away|out|off))\b/;

/** Code words set up earlier in the conversation: "when I say pickle I mean kill". */
export function aliasesFrom(history: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const h of history) {
    const t = normalize(h);
    for (const m of t.matchAll(/\b(?:when i say|if i say|the word|code ?word)\s+"?([a-z]+)"?,?\s+(?:i mean|means|is|stands for|=)\s+"?([a-z]+)"?/g)) out.push([m[1]!, m[2]!]);
    for (const m of t.matchAll(/\b(?:from (?:now|here) on,?|let'?s say|pretend)\s+(?:the word\s+)?"?([a-z]+)"?\s+(?:means|is|stands for|=)\s+"?([a-z]+)"?/g)) out.push([m[1]!, m[2]!]);
    for (const m of t.matchAll(/\b"?([a-z]+)"?\s*=\s*"?([a-z]+)"?/g)) out.push([m[1]!, m[2]!]);
  }
  return out;
}

/**
 * Classify the latest user turn in context. Catches a forbidden ask split
 * over several turns: code words set up earlier, and short follow-ups like
 * "just yes or no" or "what about a 300 lb one" that only make sense with the
 * turn before. Earlier declined turns count too, so a rancher can't get a
 * declined question answered by rephrasing it as a follow-up.
 */
export function classifyConversation(userTurns: string[], opts: ClassifyOptions = {}): GuardDecision {
  const last = userTurns[userTurns.length - 1] ?? "";
  const prior = userTurns.slice(0, -1).slice(-3);
  let current = last;
  for (const [word, meaning] of aliasesFrom(prior)) current = current.replace(new RegExp(`\\b${word}\\b`, "gi"), meaning);
  const alone = classifyInput(current, opts);
  if (alone.action === "decline") return current === last ? alone : { ...alone, rule: `${alone.rule}~alias` };
  if (!prior.length) return alone;
  const n = normalize(last);
  if (SAFE_INTENT.test(n) || !DEPENDENT.test(n)) return alone;
  // Join the recent turns, newest last, and check them as one question.
  const joined = classifyInput([...prior, current].join(" "), opts);
  if (joined.action === "decline") return { ...joined, rule: `${joined.rule}~context`, emergency: alone.emergency || joined.emergency };
  return alone;
}

/** Rule ids, for documentation and tests. */
export const RULE_IDS = RULES.map((r) => `${r.category}:${r.id}`);
