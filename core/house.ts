// slopnuke house rulepack for actor-first technical prose.

import { GOLDEN_COMMENT } from "./contract.ts";

export const HOUSE_VERSION = 16;

interface DepToken {
  id: number;
  form: string;
  upos: string;
  head: number;
  deprel: string;
  start: number;
  end: number;
}

interface DepSentence {
  text: string;
  tokens: DepToken[];
  children: Map<number, DepToken[]>;
}

interface Sentence {
  text: string;
  start: number;
  end: number;
  dep: DepSentence;
}

interface Tok {
  lower: string;
  upos: string;
  start: number;
  end: number;
}

interface Report {
  span: { start: number; end: number };
  message: string;
}

interface Context {
  options: unknown;
  report(descriptor: Report): void;
}

interface Listener {
  Document?(doc: { text: string; sentences: Sentence[] }): void;
  Sentence?(sentence: Sentence): void;
  Token?(token: Tok): void;
}

interface HouseRule {
  meta: { name: string; category: string; docs: { description: string }; defaultSeverity: "warn"; defaultConfidence: "high" | "medium" };
  create(context: Context): Listener;
}

export interface CodeSpan {
  start: number;
  end: number;
}

const words = (list: string): Set<string> => new Set(list.split(/\s+/).filter(Boolean));

// Nouns for data and artifacts that slopnuke never accepts as actors.
export const DATA_NOUNS = words(`
  amendment answer approval argument attestation body branch budget buffer cache call case catalog cell chain change check chunk class code column
  contract dialog draft epoch goal index invitation invite job paragraph profile reference rewrite suggestion work
  comment commit config configuration connection count data deadline descriptor description design diff doc document
  edit entry error event exception field figure file finding flag format frame function hash header id
  input interval invocation item key label ledger limit line link list log loop map mark marker message method
  metric name note notification number object option output overlap packet page param parameter patch path payload
  phase policy prompt protocol query record report reply request response result round row rule scan schema score
  section sentence setting signal source spec specification state status step stream string sum summary sweep table
  tag task test text threshold token total type update value variable version window word
`);

// Linking and state verbs that a data subject may take.
const STATIVE = words(`
  is are was were be been being am has have had having equal equals equaled contain contains contained include includes
  included consist consists consisted match matches matched differ differs differed exist exists existed mean means
  meant need needs needed depend depends depended remain remains remained cost costs weigh weighs fit fits fitted lack
  lacks lacked seem seems seemed appear appears appeared resemble resembles require requires required exceed exceeds
  exceeded span spans cover covers covered stay stays stayed conflict conflicts conflicted missing lacking
`);

const PARTICIPLES = words(`
  led sent held made built done given taken written known shown set put kept left found bound read begun chosen drawn
  driven fallen forgotten gotten got hidden laid lost meant met paid said seen sold sought shut split spent spun stolen
  struck taught thrown told thought understood won worn woven wound brought bought caught fed fled fought felt heard hit
  hung hurt lent lit cut dealt dug slid run spawned
`);

// Base forms that read as imperatives at the start of a sentence.
const AMBIGUOUS = words("run put set cut hit hurt read shut split let quit spread cost");

// Past forms with no passive reading in a subject-verb fragment.
const INTRANSITIVE_PAST = words("exited failed died arrived returned ended started stopped finished succeeded crashed timed happened occurred existed waited paused resumed changed appeared expired disappeared got");
const FRAGMENT_KINDS = new Set(["test-name", "message"]);

const SUBORDINATORS = words("when if whether until once after before while because since unless");
const POSSESSIVES = words("its their his her my our your");
const CLAUSE_OPENERS = words("when if whether until once after before while because since unless else otherwise");

// Words that slopnuke bans as generic AI prose in every profile.
export const GENERIC_BANNED_WORDS = words(`
  delve delves delved delving tapestry tapestries myriad plethora seamless seamlessly leverage leverages leveraged
  leveraging underscore underscores underscored underscoring meticulous meticulously nestled boast boasts boasted boasting
`);

// Intensifiers and hedges that slopnuke also bans in the actor-first profile.
export const PERSONAL_BANNED_WORDS = words(`
  crucially importantly notably fundamentally genuinely truly quietly deeply arguably inherently hold holds held holding
`);

export interface Lexicon {
  bannedWords: Set<string>;
  phrases: RegExp | null;
  dataNouns: Set<string>;
  actorNouns: Set<string>;
  terms: Set<string>;
  intentVerbs: Set<string>;
}

// People who can intend, learn, choose or know.
export const PERSON_NOUNS = words(`
  i we you he she person people persons user users operator operators developer developers reader readers writer writers
  author authors maintainer maintainers engineer engineers administrator administrators admin admins human humans customer
  customers reviewer reviewers contributor contributors team teams caller callers
`);

// Nouns that slopnuke accepts as actors in a doc comment.
export const DEFAULT_ACTORS = new Set([...PERSON_NOUNS, ...words("command commands process processes program programs cli server servers daemon daemons shell")]);

// Verbs of intent or cognition that only a person can perform.
export const DEFAULT_INTENT_VERBS = words(`
  try tries tried trying learn learns learned learnt learning treat treats treated treating choose chooses chose chosen
  choosing decide decides decided deciding admit admits admitted admitting find finds found finding
  prefer prefers preferred preferring ignore ignores ignored ignoring expect expects expected expecting want wants
  wanted wanting know knows knew known knowing see sees saw seen seeing name names named naming light lights lit lighting
  think thinks thought believe believes believed assume assumes assumed understand understands understood remember remembers
  remembered forget forgets forgot intend intends intended wish wishes wished hope hopes hoped notice notices noticed realize
  realizes realized attempt attempts attempted aim aims aimed
`);

// Code component nouns that slopnuke flags as invented actors in a doc comment.
const COMPONENT_NOUNS = words(`
  engine pipeline gate console tui ui runtime model layer kernel bench hub module component system subsystem framework library
  backend frontend cache queue pool stage graph network api app tool plugin client
`);

// Nouns with an agentive suffix that name data or parts and never act.
const NON_AGENT_ER = words(`
  number error buffer parameter intensifier qualifier modifier header footer folder border order color colour vector tensor cursor factor mirror member
  letter matter paper chapter character register pointer counter corner power center centre other either neither under after
  never over ever however rather whether together later former latter upper lower inner outer prior major minor floor door
  descriptor selector identifier container perimeter diameter meter liter litre water quarter master cluster interior
  exterior anchor tensor vendor sector error mirror placeholder holder integer marker delimiter separator modifier qualifier
  specifier quantifier multiplier divisor denominator numerator chapter computer
`);

// Program output verbs that slopnuke accepts after a component noun such as console.
const DIRECTIONS = new Set(["to", "from", "into", "onto", "through"]);
const IO_VERBS = words("write writes wrote print prints printed read reads send sends sent receive receives received open opens opened close closes closed exit exits exited spawn spawns spawned listen listens connect connects log logs logged");

// Figurative result verbs with an optional particle that must follow.
const FIGURATIVE: Record<string, string | null> = {
  land: null, lands: null, landed: null, landing: null,
  carry: null, carries: null, carried: null, carrying: null,
  earn: null, earns: null, earned: null, earning: null,
  reach: null, reaches: null, reached: null, reaching: null,
  crawl: null, crawls: null, crawled: null, crawling: null,
  lead: null, leads: null, led: null, leading: null,
  sit: "on", sits: "on", sat: "on", sitting: "on",
  belong: "to", belongs: "to", belonged: "to", belonging: "to",
  close: "in", closes: "in", closed: "in", closing: "in",
};

export const BANNED_PHRASES = [
  "here's the thing", "here's the deal", "here's the kicker", "here's the problem though", "here's what most people miss",
  "here's where it gets interesting", "here's what i find interesting", "it's worth noting", "it is worth noting",
  "it bears mentioning", "at its core", "at the end of the day", "let that sink in", "let's break this down",
  "think of it as", "in conclusion", "in summary", "to sum up", "needle in a haystack", "best of both worlds",
  "a testament to", "plays a pivotal role", "plays a crucial role", "plays a vital role", "plays a key role", "serves as a",
  "in today's world", "in today's landscape", "in a world where", "navigate the landscape", "navigate the complexity",
  "the landscape of", "despite these challenges", "it's important to note", "it is important to note",
  "it's important to remember", "when it comes to", "let's dive in", "not just", "worth noting",
];

const ARROW_PATTERN = /[→⇒➜⟶➔]/g;
const RELATIVE = new Set(["that", "which", "who"]);
const BREAKS = /[—–:;(\u2029]/;
const TRAILING_VERB_RELS = new Set(["conj", "parataxis", "root", "advcl"]);
const SUBJECTLESS_BLOCKERS = new Set(["nsubj", "nsubj:pass", "csubj", "expl", "aux", "aux:pass", "cop"]);

const lower = (token: DepToken): string => token.form.toLowerCase();
const kids = (sentence: DepSentence, id: number): DepToken[] => sentence.children.get(id) ?? [];
const byId = (sentence: DepSentence, id: number): DepToken | undefined => sentence.tokens[id - 1]?.id === id ? sentence.tokens[id - 1] : sentence.tokens.find((token) => token.id === id);

function subtreeSpan(sentence: DepSentence, root: DepToken): { start: number; end: number } {
  let start = root.start;
  let end = root.end;
  const pending = [root];
  while (pending.length > 0) {
    const token = pending.pop() as DepToken;
    if (token.upos !== "PUNCT") {
      start = Math.min(start, token.start);
      end = Math.max(end, token.end);
    }
    pending.push(...kids(sentence, token.id));
  }
  return { start, end };
}

function singular(word: string): string[] {
  const forms = [word];
  if (word.endsWith("ies")) forms.push(`${word.slice(0, -3)}y`);
  if (word.endsWith("es")) forms.push(word.slice(0, -2));
  if (word.endsWith("s")) forms.push(word.slice(0, -1));
  return forms;
}

const PROCESS_NOUN = /[a-z]{3}(?:tion|sion|ment|ance|ence)s?$/;
const ACTOR_PROCESS_NOUNS = words("extension extensions session sessions application applications instance instances");

export function isInanimateNoun(word: string, nouns: Set<string> = DATA_NOUNS, actors: Set<string> = ACTOR_PROCESS_NOUNS): boolean {
  const lowered = word.toLowerCase();
  if (singular(lowered).some((form) => nouns.has(form))) return true;
  return PROCESS_NOUN.test(lowered) && !ACTOR_PROCESS_NOUNS.has(lowered) && !singular(lowered).some((form) => actors.has(form));
}

const DEFAULT_LEXICON: Lexicon = { bannedWords: new Set([...GENERIC_BANNED_WORDS, ...PERSONAL_BANNED_WORDS]), phrases: null, dataNouns: DATA_NOUNS, actorNouns: DEFAULT_ACTORS, terms: new Set(), intentVerbs: DEFAULT_INTENT_VERBS };
const lexiconOption = (options: unknown): Lexicon => (options as { lexicon?: Lexicon } | null)?.lexicon ?? DEFAULT_LEXICON;
const isTerm = (lexicon: Lexicon, token: DepToken): boolean => lexicon.terms.has(lower(token));
const commentsOption = (options: unknown): boolean => (options as { comments?: boolean } | null)?.comments === true;

function isParticiple(token: DepToken): boolean {
  const word = lower(token);
  return token.upos === "VERB" && (PARTICIPLES.has(word) || /[a-z]{2}(?:ed|en)$/.test(word));
}

const isClearParticiple = (token: DepToken): boolean => isParticiple(token) && !AMBIGUOUS.has(lower(token));
const wordCount = (sentence: DepSentence): number => sentence.tokens.filter((token) => token.upos !== "PUNCT").length;

function isName(sentence: DepSentence, noun: DepToken): boolean {
  const first = sentence.tokens.find((token) => token.upos !== "PUNCT");
  const capital = /^[A-Z]/.test(noun.form) && noun.id !== first?.id;
  return capital || kids(sentence, noun.id).some((child) => child.deprel === "compound" && (child.upos === "PROPN" || /^[A-Z]/.test(child.form)));
}

function codeData(sentence: DepSentence, spans: CodeSpan[], noun: DepToken): boolean {
  if (!inCode(spans, noun)) return false;
  const previous = byId(sentence, noun.id - 1);
  const determined = previous !== undefined && (previous.upos === "DET" || POSSESSIVES.has(lower(previous)));
  return /[_.]/.test(noun.form) || determined || kids(sentence, noun.id).some((child) => child.deprel === "det" || child.deprel === "nmod:poss");
}

function afterSubordinator(sentence: DepSentence, noun: DepToken): boolean {
  const start = subtreeSpan(sentence, noun).start;
  const before = sentence.tokens.filter((token) => token.end <= start && token.upos !== "PUNCT").slice(-2);
  return before.some((token) => SUBORDINATORS.has(lower(token)));
}

const codeOption = (options: unknown): CodeSpan[] => (Array.isArray((options as { codeSpans?: unknown })?.codeSpans) ? (options as { codeSpans: CodeSpan[] }).codeSpans : []);
const inCode = (spans: CodeSpan[], token: DepToken): boolean => spans.some((span) => token.start >= span.start && token.end <= span.end);

function rule(name: string, description: string, confidence: "high" | "medium", create: (context: Context) => Listener): HouseRule {
  return { meta: { name, category: "actor-first", docs: { description }, defaultSeverity: "warn", defaultConfidence: confidence }, create };
}

const inanimateSubject = rule("inanimate-subject", "Data, files or code values as the subject of an action verb.", "medium", (context) => {
  const code = codeOption(context.options);
  const lex = lexiconOption(context.options);
  return {
    Sentence({ dep }) {
      for (const subject of dep.tokens) {
        if (subject.deprel !== "nsubj") continue;
        const verb = byId(dep, subject.head);
        if (!verb || verb.upos !== "VERB" || STATIVE.has(lower(verb)) || inCode(code, verb) || isTerm(lex, verb)) continue;
        const [from, to] = subject.id < verb.id ? [subject.id, verb.id] : [verb.id, subject.id];
        if (dep.tokens.some((token) => token.id > from && token.id < to && token.upos === "PUNCT" && BREAKS.test(token.form))) continue;
        if (wordCount(dep) <= 2) continue;
        if (kids(dep, verb.id).some((child) => child.id !== subject.id && child.deprel === "nsubj" && (child.upos === "NOUN" || child.upos === "PROPN") && !isInanimateNoun(child.form, lex.dataNouns, lex.actorNouns))) continue;
        if (kids(dep, subject.id).some((child) => child.deprel === "conj" && !isInanimateNoun(child.form, lex.dataNouns, lex.actorNouns))) continue;
        let noun = subject;
        if (RELATIVE.has(lower(subject)) && verb.deprel === "acl:relcl") noun = byId(dep, verb.head) ?? subject;
        const bare = noun.id === verb.id - 1 && /s$/.test(lower(verb)) && !/s$/.test(lower(noun)) && kids(dep, noun.id).length === 0 && dep.tokens.some((token) => token.id > verb.id && (token.upos === "VERB" || token.upos === "AUX"));
        const data = codeData(dep, code, noun) || (!bare && !inCode(code, noun) && noun.upos === "NOUN" && isInanimateNoun(noun.form, lex.dataNouns, lex.actorNouns) && !isName(dep, noun));
        if (!data) continue;
        const span = subtreeSpan(dep, subject);
        context.report({
          span: { start: Math.min(span.start, verb.start), end: Math.max(span.end, verb.end) },
          message: `"${noun.form}" is data, and data does not "${verb.form}". Make the program, process or person that acts the subject.`,
        });
      }
      for (const verb of dep.tokens) {
        if (verb.upos !== "NOUN" || !/[a-z]s$/.test(lower(verb)) || !TRAILING_VERB_RELS.has(verb.deprel) || isTerm(lex, verb)) continue;
        const clauseConj = verb.deprel === "conj" && byId(dep, verb.head)?.upos === "VERB";
        const clause = clauseConj || ((verb.deprel === "parataxis" || verb.deprel === "advcl") && dep.tokens.some((token) => token.id < verb.id && CLAUSE_OPENERS.has(lower(token))));
        if (!clause) continue;
        const next = byId(dep, verb.id + 1);
        if (next && next.upos !== "PUNCT" && next.upos !== "CCONJ") continue;
        const noun = byId(dep, verb.id - 1);
        if (!noun || noun.head !== verb.id || inCode(code, noun) || noun.upos !== "NOUN" || !isInanimateNoun(noun.form, lex.dataNouns, lex.actorNouns) || isName(dep, noun)) continue;
        context.report({
          span: { start: subtreeSpan(dep, noun).start, end: verb.end },
          message: `"${noun.form}" is data, and data does not "${verb.form}". Make the program, process or person that acts the subject.`,
        });
      }
    },
  };
});

const agentlessPassive = rule("agentless-passive", "Passive voice with no named actor.", "high", (context) => {
  const code = codeOption(context.options);
  const lex = lexiconOption(context.options);
  const prose = proseOption(context.options);
  return {
  Sentence(sentence) {
    const { dep } = sentence;
    if (FRAGMENT_KINDS.has(sentenceSpan(prose, sentence)?.kind ?? "")) {
      for (const verb of dep.tokens) {
        if (!isClearParticiple(verb) || INTRANSITIVE_PAST.has(lower(verb)) || inCode(code, verb) || isTerm(lex, verb)) continue;
        const children = kids(dep, verb.id);
        if (children.some((child) => ["aux", "aux:pass", "obj", "ccomp", "xcomp", "obl:agent"].includes(child.deprel))) continue;
        if (!children.some((child) => !["punct", "cc", "det", "advmod"].includes(child.deprel))) continue;
        const head = byId(dep, verb.head);
        if (verb.deprel === "acl" && head && ["NOUN", "PROPN", "PRON", "NUM"].includes(head.upos) && head.id < verb.id) continue;
        context.report({ span: subtreeSpan(dep, verb), message: `Participle outcome "${verb.form}" with no actor. Name the program, process or person that does it.` });
      }
    }
    const seen = new Set<number>();
    for (const token of dep.tokens) {
      if (token.deprel !== "aux:pass" && token.deprel !== "nsubj:pass") continue;
      const verb = byId(dep, token.head);
      if (!verb || seen.has(verb.id) || inCode(code, verb) || isTerm(lex, verb) || kids(dep, verb.id).some((child) => child.deprel === "obl:agent")) continue;
      seen.add(verb.id);
      const parts = kids(dep, verb.id).filter((child) => child.deprel === "nsubj:pass" || child.deprel === "aux:pass");
      const start = Math.min(verb.start, ...parts.map((part) => subtreeSpan(dep, part).start));
      context.report({ span: { start, end: verb.end }, message: `Passive "${verb.form}" with no actor. Name the program, process or person that does it as the subject.` });
    }
    for (const verb of dep.tokens) {
      if (verb.deprel !== "advcl" || !isClearParticiple(verb) || inCode(code, verb) || isTerm(lex, verb) || seen.has(verb.id)) continue;
      if (kids(dep, verb.id).some((child) => SUBJECTLESS_BLOCKERS.has(child.deprel) || child.deprel === "obl:agent" || (child.deprel === "mark" && lower(child) === "as"))) continue;
      seen.add(verb.id);
      context.report({ span: subtreeSpan(dep, verb), message: `Participle clause "${verb.form}" with no actor. Name the program, process or person that does it as the subject.` });
    }
    const first = dep.tokens.find((token) => token.upos !== "PUNCT");
    const adjectival = first !== undefined && ["NOUN", "PROPN", "ADJ"].includes(byId(dep, first.id + 1)?.upos ?? "");
    if (first && first.deprel === "root" && wordCount(dep) > 2 && !adjectival && isClearParticiple(first) && !inCode(code, first) && !isTerm(lex, first) && !kids(dep, first.id).some((child) => SUBJECTLESS_BLOCKERS.has(child.deprel))) {
      context.report({ span: { start: first.start, end: first.end }, message: `Participle fragment "${first.form}" with no actor. Write a full sentence with the actor as the subject.` });
    }
  },
  };
});

const participleAfterNoun = rule("participle-after-noun", "Participle phrase after a noun.", "high", (context) => {
  const code = codeOption(context.options);
  const lex = lexiconOption(context.options);
  return {
  Sentence({ dep }) {
    for (const verb of dep.tokens) {
      if ((verb.deprel !== "acl" && verb.deprel !== "parataxis") || inCode(code, verb) || isTerm(lex, verb)) continue;
      const head = byId(dep, verb.head);
      if (!head || head.id > verb.id || !["NOUN", "PROPN", "PRON", "NUM"].includes(head.upos)) continue;
      if (verb.deprel === "parataxis" && kids(dep, verb.id).some((child) => SUBJECTLESS_BLOCKERS.has(child.deprel))) continue;
      if (STATIVE.has(lower(verb)) || afterSubordinator(dep, head) || byId(dep, verb.id - 1)?.upos === "DET") continue;
      if (isParticiple(verb) && byId(dep, verb.id + 1)?.upos === "NOUN") continue;
      const holder = byId(dep, head.head);
      if (holder && /^(?:has|have|had|having|get|gets|got|keep|keeps|leave|leaves|want|wants|need|needs)$/.test(lower(holder)) && ["obj", "xcomp"].includes(head.deprel)) continue;
      if (kids(dep, verb.id).some((child) => child.deprel === "nsubj" || child.deprel === "nsubj:pass")) continue;
      if (!isParticiple(verb) && !(verb.upos === "VERB" && lower(verb).endsWith("ing"))) continue;
      context.report({ span: subtreeSpan(dep, verb), message: `Participle phrase "${verb.form} ..." after "${head.form}". Name the actor as the subject with a finite verb.` });
    }
  },
  };
});

const figurativeVerb = rule("figurative-verb", "Figurative verb for a result.", "medium", (context) => {
  const code = codeOption(context.options);
  const lex = lexiconOption(context.options);
  return {
  Sentence({ dep }) {
    for (const verb of dep.tokens) {
      const word = lower(verb);
      if (verb.upos !== "VERB" || verb.deprel === "acl" || !(word in FIGURATIVE) || inCode(code, verb) || isTerm(lex, verb)) continue;
      const particle = FIGURATIVE[word];
      if (particle !== null && !dep.tokens.some((token) => token.id > verb.id && token.id <= verb.id + 3 && lower(token) === particle)) continue;
      context.report({ span: { start: verb.start, end: verb.end }, message: `Figurative verb "${verb.form}". Name the literal action.` });
    }
  },
  };
});

const bannedWord = rule("banned-word", "Banned word.", "high", (context) => {
  const code = codeOption(context.options);
  const lex = lexiconOption(context.options);
  return {
  Token(token) {
    if (lex.bannedWords.has(token.lower) && !code.some((span) => token.start >= span.start && token.end <= span.end)) context.report({ span: { start: token.start, end: token.end }, message: `Banned word "${token.lower}". Use a plain word or delete it.` });
  },
  };
});

const bannedPhrase = rule("banned-phrase", "Banned stock phrase.", "high", (context) => ({
  Sentence(sentence) {
    const pattern = lexiconOption(context.options).phrases;
    if (pattern === null) return;
    for (const match of sentence.text.matchAll(pattern)) {
      const start = sentence.start + (match.index ?? 0);
      context.report({ span: { start, end: start + match[0].length }, message: `Banned phrase "${match[0]}". State the point directly.` });
    }
  },
}));

const arrow = rule("arrow", "Unicode arrow in prose.", "high", (context) => ({
  Document(doc) {
    for (const match of doc.text.matchAll(ARROW_PATTERN)) {
      const start = match.index ?? 0;
      context.report({ span: { start, end: start + match[0].length }, message: `Unicode arrow "${match[0]}". Write "to", "then", or "becomes".` });
    }
  },
}));

// Marks that slopnuke flags because people never say them aloud.
const WRITTEN_MARK = /;|\b(?:e\.g\.|i\.e\.|etc\.)|(?<![\w/.:~-])([A-Za-z]{2,})\/([A-Za-z]{2,})(?![\w/.-])/gi;

const writtenMark = rule("written-mark", "A mark that people write but never say aloud.", "high", (context) => {
  const code = codeOption(context.options);
  return {
    Document(doc) {
      for (const match of doc.text.matchAll(WRITTEN_MARK)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        if (code.some((span) => start < span.end && end > span.start)) continue;
        if (match[1] !== undefined && (match[1] === match[1].toUpperCase() || match[2] === match[2].toUpperCase())) continue;
        const advice = match[0] === ";" ? "End the sentence with a period, or join the clauses with and or but, or with because or so where one causes the other." : match[1] !== undefined ? `Write "${match[1]} and ${match[2]}" or "${match[1]} or ${match[2]}".` : 'Write "such as", "that is" or the full list.';
        context.report({ span: { start, end }, message: `"${match[0]}" is a mark people do not say aloud. ${advice}` });
      }
    },
  };
});

// Test for a figurative verb in a word list with the particle in the next word.
export function figurativeAt(words: readonly string[], index: number): boolean {
  const word = words[index];
  if (!(word in FIGURATIVE) || word.endsWith("ing")) return false;
  const particle = FIGURATIVE[word];
  return particle === null || words[index + 1] === particle;
}

interface ProseRange {
  start: number;
  end: number;
  kind: string;
}

const proseOption = (options: unknown): ProseRange[] => (Array.isArray((options as { proseSpans?: unknown })?.proseSpans) ? (options as { proseSpans: ProseRange[] }).proseSpans : []);

function sentenceSpan(spans: ProseRange[], sentence: Sentence): ProseRange | undefined {
  return spans.find((span) => sentence.start >= span.start && sentence.start < span.end);
}

const uiLabel = rule("ui-label", "UI label that is not a noun phrase of at most four words.", "high", (context) => {
  const spans = proseOption(context.options);
  return {
    Sentence(sentence) {
      if (sentenceSpan(spans, sentence)?.kind !== "ui-label") return;
      const words = sentence.dep.tokens.filter((token) => token.upos !== "PUNCT");
      if (words.length === 0) return;
      const root = sentence.dep.tokens.find((token) => token.deprel === "root");
      const span = { start: words[0].start, end: words[words.length - 1].end };
      if (words.length > 4) context.report({ span, message: `UI label with ${words.length} words. Write a noun phrase of at most four words.` });
      else if (root?.upos === "VERB" && root.id === words[0].id) context.report({ span, message: `UI label that starts with the verb "${root.form}". Write a noun phrase.` });
    },
  };
});

// Dependents that only a verb takes.
const VERB_ARGUMENT = /^(?:obj|iobj|obl(?::.*)?|advmod|nsubj(?::.*)?|ccomp|xcomp|compound:prt)$/;

const uiDescription = rule("ui-description", "UI description that is a clause and not a noun phrase.", "high", (context) => {
  const spans = proseOption(context.options);
  return {
    Sentence(sentence) {
      if (sentenceSpan(spans, sentence)?.kind !== "ui-description") return;
      const words = sentence.dep.tokens.filter((token) => token.upos !== "PUNCT");
      const root = sentence.dep.tokens.find((token) => token.deprel === "root");
      if (words.length < 2 || !root || (root.upos !== "VERB" && root.upos !== "AUX")) return;
      const hasObject = (id: number): boolean => kids(sentence.dep, id).some((child) => child.deprel === "obj");
      const infinitive = kids(sentence.dep, root.id).find((child) => child.deprel === "xcomp" && kids(sentence.dep, child.id).some((mark) => mark.deprel === "mark" && lower(mark) === "to"));
      if (infinitive && !hasObject(root.id) && !hasObject(infinitive.id)) return;
      if (!kids(sentence.dep, root.id).some((child) => VERB_ARGUMENT.test(child.deprel))) return;
      let top: DepToken | undefined = words[0];
      while (top && top.id !== root.id && top.head !== root.id && top.head !== 0) top = byId(sentence.dep, top.head);
      const subjects = kids(sentence.dep, root.id).filter((child) => /^nsubj/.test(child.deprel));
      const subjectFirst = top !== undefined && top.head === root.id && /^nsubj/.test(top.deprel) && top.id === subjects[subjects.length - 1]?.id;
      if (root.id !== words[0].id && !subjectFirst) return;
      context.report({
        span: { start: words[0].start, end: words[words.length - 1].end },
        message: 'UI description built on the verb "' + root.form + '". Write a noun phrase that says what the value is and what it applies to, for example "The total amount of concurrent slots for a loaded model."',
      });
    },
  };
});

const uiButton = rule("ui-button", "UI button text that is not a verb and an object.", "high", (context) => {
  const spans = proseOption(context.options);
  return {
    Sentence(sentence) {
      if (sentenceSpan(spans, sentence)?.kind !== "ui-button") return;
      const words = sentence.dep.tokens.filter((token) => token.upos !== "PUNCT");
      if (words.length === 0) return;
      const span = { start: words[0].start, end: words[words.length - 1].end };
      if (words.length < 2 || words[0].upos !== "VERB") context.report({ span, message: "UI button text that is not a verb and an object. Write the action and its object, for example \"Save file\"." });
    },
  };
});


const CONTENT_POS = new Set(["NOUN", "PROPN", "VERB"]);
const LIGHT_VERBS = words("be is are was were been being have has had do does did use uses used make makes made get gets got go goes went take takes took");
const BACK_REFERENCES = words("it its this that these those they them their both each such then so but however also instead here there thus still yet");
const LINKS = words("because when while if although though since unless until whereas so but then which who whose once after before");
const TRANSITIONS = words("however then so but also instead thus still yet therefore otherwise meanwhile first next finally");
// Short limit at 10 words so that two joined short sentences and a link word stay under the 24-word review line of reader-first/sentence-load.
export const SHORT_SENTENCE = 10;
export const LOAD_REVIEW_WORDS = 24;
const CHOPPY_RUN = 4;
const ISLAND_WINDOW = 2;

// Crude stem that slopnuke uses in overlap checks to give approves and approval one form.
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/['’]s$/, "");
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (/(?:s|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith("s") && !/[su]s$/.test(w) && w.length > 3) w = w.slice(0, -1);
  else if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  for (const suffix of ["ation", "ment", "al", "er", "or", "e"]) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 4) return w.slice(0, -suffix.length);
  }
  return w;
}

interface FlowSentence {
  sentence: Sentence;
  words: DepToken[];
  stems: Set<string>;
  section: number;
  paragraph: number;
  list: boolean;
  startsWithCode: boolean;
}

// Sentences of one document with section numbers that change at each heading line.
function flowSentences(doc: { text: string; sentences: Sentence[] }, comments = false): FlowSentence[] {
  const out: FlowSentence[] = [];
  let section = 0;
  let paragraph = 0;
  let lastSection = 0;
  let lastEnd = 0;
  for (const sentence of doc.sentences) {
    const between = doc.text.slice(lastEnd, sentence.start);
    const previousEnd = lastEnd;
    if (/(?:^|\n)\s{0,3}#/.test(between) || (comments ? /\n[ \t]*\n/ : /\n[ \t]+\n/).test(between) || between.includes("\u2029")) section++;
    lastEnd = sentence.end;
    const lineStart = doc.text.lastIndexOf("\n", sentence.start - 1) + 1;
    const line = doc.text.slice(lineStart, doc.text.indexOf("\n", sentence.start) === -1 ? doc.text.length : doc.text.indexOf("\n", sentence.start));
    if (/^\s{0,3}#/.test(line)) {
      section++;
      continue;
    }
    const words = sentence.dep.tokens.filter((token) => token.upos !== "PUNCT" && /\p{L}/u.test(token.form));
    if (words.length === 0) continue;
    if (words.length <= 3 && /:\s*$/.test(sentence.text)) {
      section++;
      continue;
    }
    const list = /^\s*(?:\d+[.)]|[-*+])[\s\u2029]/.test(line) || /^\s*\|/.test(line);
    const stems = new Set(words.filter((token) => CONTENT_POS.has(token.upos) && !LIGHT_VERBS.has(lower(token))).map((token) => stem(token.form)));
    const startsWithCode = /[ \t]{3,}/.test(doc.text.slice(Math.max(lineStart, previousEnd), words[0].start));
    if (section !== lastSection || /\n[ \t]*\n/.test(between)) paragraph++;
    lastSection = section;
    out.push({ sentence, words, stems, section, paragraph, list, startsWithCode });
  }
  return joinSingletons(out);
}

// Consecutive one-sentence paragraphs in one section count as one paragraph.
function joinSingletons(entries: FlowSentence[]): FlowSentence[] {
  const sizes = new Map<number, number>();
  for (const entry of entries) sizes.set(entry.paragraph, (sizes.get(entry.paragraph) ?? 0) + 1);
  const out: FlowSentence[] = [];
  for (const entry of entries) {
    const previous = out[out.length - 1];
    const joined = previous !== undefined && previous.section === entry.section && previous.paragraph !== entry.paragraph && sizes.get(entry.paragraph) === 1 && sizes.get(previous.paragraph) === 1;
    out.push(joined ? { ...entry, paragraph: previous.paragraph } : entry);
  }
  return out;
}

const shares = (a: FlowSentence, b: FlowSentence): boolean => [...a.stems].some((word) => b.stems.has(word));
const opensWithLink = (entry: FlowSentence): boolean => BACK_REFERENCES.has(lower(entry.words[0])) || LINKS.has(lower(entry.words[0]));
const refersBack = (entry: FlowSentence): boolean => opensWithLink(entry) || entry.words.some((token) => token.upos === "PRON" && BACK_REFERENCES.has(lower(token)));
const hasLink = (entry: FlowSentence): boolean => entry.words.some((token, index) => (index > 0 && LINKS.has(lower(token))) || token.deprel === "mark") || TRANSITIONS.has(lower(entry.words[0]));
const spanOfSentence = (entry: FlowSentence): { start: number; end: number } => ({ start: entry.words[0].start, end: entry.words[entry.words.length - 1].end });

// Stem of the main subject when the sentence opens with that subject.
function openingSubject(entry: FlowSentence): string | null {
  const root = entry.sentence.dep.tokens.find((token) => token.deprel === "root");
  if (!root) return null;
  const subject = kids(entry.sentence.dep, root.id).find((child) => child.deprel === "nsubj" || child.deprel === "nsubj:pass");
  if (!subject || subtreeSpan(entry.sentence.dep, subject).start !== entry.words[0].start) return null;
  return stem(subject.form);
}

const repeatedSubject = rule("repeated-subject", "Consecutive sentences with the same subject.", "high", (context) => ({
  Document(doc) {
    const entries = flowSentences(doc, commentsOption(context.options)).filter((entry) => !entry.list);
    for (let index = 1; index < entries.length; index++) {
      const previous = entries[index - 1];
      const current = entries[index];
      if (previous.paragraph !== current.paragraph) continue;
      const subject = openingSubject(current);
      if (subject === null || subject !== openingSubject(previous)) continue;
      context.report({ span: spanOfSentence(current), message: `This sentence opens with the same subject "${current.words.find((token) => stem(token.form) === subject)?.form ?? subject}" as the sentence before it. Use "it" or "they", open with a when or after clause, or join the two sentences, and keep the result under 24 words.` });
    }
  },
}));

const choppyRun = rule("choppy-run", "A run of short sentences with no link between them.", "medium", (context) => ({
  Document(doc) {
    const entries = flowSentences(doc, commentsOption(context.options)).filter((entry) => !entry.list);
    let run: FlowSentence[] = [];
    const flush = (): void => {
      if (run.length >= CHOPPY_RUN) {
        context.report({ span: { start: spanOfSentence(run[0]).start, end: spanOfSentence(run[run.length - 1]).end }, message: `${run.length} short sentences in a row with no link between them. Join pairs of related facts into one sentence of 11 to 23 words with which, when or then, or with because or so where one fact causes the other. Keep the text as prose.` });
      }
      run = [];
    };
    for (const entry of entries) {
      const short = entry.words.length <= SHORT_SENTENCE && !hasLink(entry);
      if (!short || (run.length > 0 && run[run.length - 1].paragraph !== entry.paragraph)) flush();
      if (short) run.push(entry);
    }
    flush();
  },
}));

const islandSentence = rule("island-sentence", "A sentence with no tie to the sentences around it.", "medium", (context) => ({
  Document(doc) {
    const all = flowSentences(doc, commentsOption(context.options));
    for (let index = 0; index < all.length; index++) {
      const entry = all[index];
      if (entry.list || entry.startsWithCode || entry.stems.size === 0 || refersBack(entry) || /:\s*$/.test(entry.sentence.text)) continue;
      const near = (from: number, to: number): FlowSentence[] => all.slice(Math.max(0, from), Math.max(0, to)).filter((other) => other.paragraph === entry.paragraph);
      const before = near(index - ISLAND_WINDOW, index);
      const after = near(index + 1, index + 1 + ISLAND_WINDOW);
      if (before.length === 0) continue;
      const tiedBack = before.some((other) => shares(entry, other));
      const tiedForward = after.some((other) => shares(entry, other) || (other === after[0] && refersBack(other)));
      if (tiedBack || tiedForward) continue;
      context.report({ span: spanOfSentence(entry), message: "This sentence shares no idea with the sentences around it. Tie it to the sentence before with a repeated noun, that, this or then, or move it to the part of the document where it belongs." });
    }
  },
}));

const stiltedNegation = rule("stilted-negation", "Negation through no plus a noun after a verb.", "high", (context) => ({
  Sentence({ dep }) {
    for (const object of dep.tokens) {
      if (object.deprel !== "obj") continue;
      const verb = byId(dep, object.head);
      const no = kids(dep, object.id).find((child) => child.deprel === "det" && lower(child) === "no");
      if (!verb || verb.upos !== "VERB" || !no) continue;
      context.report({ span: { start: verb.start, end: object.end }, message: `"${verb.form} no ${object.form}" reads as stilted. Write the negation with "does not", for example "does not ${verb.form.replace(/(?<=[^aeiou])ies$/, "y").replace(/(?<=(?:s|x|z|ch|sh))es$/, "").replace(/s$/, "")} any ${object.form}".` });
    }
  },
}));

// Two independent clauses with their own subjects joined by and or while with no shared idea.
const unrelatedJoin = rule("unrelated-join", "Two unrelated clauses joined in one sentence.", "medium", (context) => ({
  Sentence({ dep }) {
    const root = dep.tokens.find((token) => token.deprel === "root");
    if (!root) return;
    const clauses = [root, ...kids(dep, root.id).filter((child) => (child.deprel === "conj" || child.deprel === "advcl") && kids(dep, child.id).some((grand) => grand.deprel === "nsubj"))];
    if (clauses.length < 2 || !kids(dep, root.id).some((child) => child.deprel === "nsubj")) return;
    const second = clauses[1];
    if (root.upos !== "VERB" || second.upos !== "VERB") return;
    const joiner = kids(dep, second.id).find((child) => child.deprel === "cc" || child.deprel === "mark");
    if (!joiner || !["and", "while"].includes(lower(joiner))) return;
    const stemsOf = (head: DepToken, skip: DepToken | null): Set<string> => {
      const pending = [head];
      const out = new Set<string>();
      let pronoun = false;
      while (pending.length > 0) {
        const token = pending.pop() as DepToken;
        if (token.upos === "PRON" && BACK_REFERENCES.has(lower(token))) pronoun = true;
        if (CONTENT_POS.has(token.upos) && !LIGHT_VERBS.has(lower(token))) out.add(stem(token.form));
        for (const child of kids(dep, token.id)) if (child !== skip) pending.push(child);
      }
      if (pronoun) out.add("\u0000pronoun");
      return out;
    };
    const first = stemsOf(root, second);
    const other = stemsOf(second, null);
    if (other.has("\u0000pronoun") || [...first].some((word) => other.has(word))) return;
    context.report({ span: subtreeSpan(dep, root), message: `The two clauses joined by "${joiner.form}" share no idea. Split them into separate sentences, and place each one next to the point it belongs to.` });
  },
}));

// Possessive its and their and 's on a thing when the nearest noun before them is data.
const thingPossessive = rule("thing-possessive", "A data noun as the owner of another thing.", "medium", (context) => {
  const code = codeOption(context.options);
  const lex = lexiconOption(context.options);
  return {
    Sentence({ dep }) {
      for (const marker of dep.tokens) {
        const word = lower(marker);
        if (word === "whose" && marker.deprel === "nmod:poss") {
          let clause = byId(dep, marker.head);
          while (clause && clause.deprel !== "acl:relcl" && clause.head !== 0) clause = byId(dep, clause.head);
          const antecedent = clause?.deprel === "acl:relcl" ? byId(dep, clause.head) : undefined;
          const owned = byId(dep, marker.head);
          if (!antecedent || !owned || PERSON_NOUNS.has(lower(antecedent)) || inCode(code, antecedent)) continue;
          context.report({ span: { start: marker.start, end: owned.end }, message: `"whose ${owned.form}" makes the ${antecedent.form} the owner of the ${owned.form}. Write "a ${antecedent.form} with a ${owned.form} that ..." or a condition.` });
          continue;
        }
        const possessive = (marker.upos === "PRON" && (word === "its" || word === "their") && marker.deprel === "nmod:poss") || (marker.deprel === "case" && /^['’]s$/.test(marker.form));
        if (!possessive) continue;
        const owned = byId(dep, marker.deprel === "case" ? byId(dep, marker.head)?.head ?? 0 : marker.head);
        const owner = marker.deprel === "case" ? byId(dep, marker.head) : [...dep.tokens].reverse().find((token) => token.id < marker.id && (token.upos === "NOUN" || token.upos === "PROPN"));
        if (!owned || !owner || inCode(code, owner) || isName(dep, owner) || !isInanimateNoun(owner.form, lex.dataNouns, lex.actorNouns)) continue;
        const start = marker.deprel === "case" ? owner.start : marker.start;
        context.report({ span: { start, end: Math.max(owned.end, marker.end) }, message: `"${dep.text.slice(start - (dep.tokens[0]?.start ?? 0), Math.max(owned.end, marker.end) - (dep.tokens[0]?.start ?? 0))}" makes the ${owner.form} the owner of the ${owned.form}. Name the ${owned.form} directly, for example "the ${owned.form} of the ${owner.form}", or rewrite the sentence around the actor.` });
      }
    },
  };
});

// Verbs that need an object in technical prose with base and inflected forms.
const TRANSITIVE = new Set(
  `edit edits edited write writes wrote written read reads check checks checked verify verifies verified validate validates
  validated parse parses parsed load loads loaded save saves saved store stores stored send sends sent receive receives
  received accept accepts accepted reject rejects rejected grant grants granted release releases
  released create creates created delete deletes deleted remove removes removed update updates updated modify modifies
  modified copy copies copied fetch fetches fetched scan scans scanned rewrite rewrites rewrote rewritten approve approves
  approved install installs installed sign signs signed encrypt encrypts encrypted decrypt decrypts decrypted record records
  recorded mark marks marked flag flags flagged require requires required use uses take takes took taken give gives gave
  given put puts make makes made find finds found open opens opened pass passes passed`.split(/\s+/),
);
const OBJECT_RELS = new Set(["obj", "iobj", "ccomp", "xcomp", "csubj"]);

const missingObject = rule("missing-object", "A transitive verb with no object.", "medium", (context) => {
  const code = codeOption(context.options);
  const lex = lexiconOption(context.options);
  return {
    Sentence({ dep }) {
      for (const verb of dep.tokens) {
        if (verb.upos !== "VERB" || !TRANSITIVE.has(lower(verb)) || inCode(code, verb) || isTerm(lex, verb)) continue;
        if (["acl", "acl:relcl", "amod", "compound", "xcomp"].includes(verb.deprel)) continue;
        const children = kids(dep, verb.id);
        if (children.some((child) => OBJECT_RELS.has(child.deprel) || child.deprel === "aux:pass" || child.deprel === "nsubj:pass")) continue;
        if (children.some((child) => child.deprel === "mark" && lower(child) === "to")) continue;
        if (IO_VERBS.has(lower(verb)) && children.some((child) => child.deprel.startsWith("obl") && kids(dep, child.id).some((grand) => grand.deprel === "case" && DIRECTIONS.has(lower(grand))))) continue;
        if (children.some((child) => child.deprel === "obl" && child.id > verb.id && kids(dep, child.id).some((grand) => grand.deprel === "nummod"))) continue;
        const head = byId(dep, verb.head);
        if (verb.deprel === "conj" && head && (kids(dep, head.id).some((child) => OBJECT_RELS.has(child.deprel)) || ["acl", "acl:relcl"].includes(head.deprel))) continue;
        if (children.some((child) => child.deprel === "conj" && kids(dep, child.id).some((grand) => OBJECT_RELS.has(grand.deprel)))) continue;
        if (!children.some((child) => child.deprel === "nsubj")) continue;
        const next = dep.tokens.find((token) => token.id > verb.id && token.upos !== "PUNCT");
        if (next && inCode(code, next)) continue;
        context.report({ span: { start: verb.start, end: verb.end }, message: `"${verb.form}" has no object. Say what the subject ${verb.form}, for example "${verb.form} the files".` });
      }
    },
  };
});

// Vague verbs with a literal replacement for each one.
const VAGUE: Record<string, string> = {
  keep: "store, retain on disk or leave", keeps: "stores or leaves", kept: "stored or left", keeping: "storing",
  handle: "parse, answer, reject or route", handles: "parses, answers, rejects or routes", handled: "parsed or answered", handling: "parsing or answering",
  manage: "create, start, stop or delete", manages: "creates, starts, stops or deletes", managed: "created or started", managing: "creating or starting",
  maintain: "update or write", maintains: "updates or writes", maintained: "updated", maintaining: "updating",
  ensure: "check or refuse unless", ensures: "checks or refuses unless", ensured: "checked", ensuring: "checking",
  facilitate: "let or start", facilitates: "lets or starts", utilize: "use", utilizes: "uses", utilized: "used",
  own: "created or leased", owns: "created or leased", owned: "created", possess: "have", possesses: "has",
};

const vagueVerb = rule("vague-verb", "A vague verb in place of the literal action.", "high", (context) => {
  const code = codeOption(context.options);
  const lex = lexiconOption(context.options);
  return {
    Sentence({ dep }) {
      for (const verb of dep.tokens) {
        const word = lower(verb);
        if (verb.upos !== "VERB" || !(word in VAGUE) || inCode(code, verb) || isTerm(lex, verb)) continue;
        if (word.startsWith("keep") && kids(dep, verb.id).some((child) => child.deprel === "xcomp" && lower(child).endsWith("ing"))) continue;
        context.report({ span: { start: verb.start, end: verb.end }, message: `"${verb.form}" is vague. Name the literal action, such as ${VAGUE[word]}.` });
      }
    },
  };
});

const isRoleNoun = (token: DepToken, lexicon: Lexicon): boolean => {
  const word = singular(lower(token)).at(-1) ?? lower(token);
  const forms = singular(lower(token));
  if (forms.some((form) => lexicon.actorNouns.has(form))) return false;
  if (forms.some((form) => COMPONENT_NOUNS.has(form))) return true;
  return /^[a-z]{3,}(?:er|or)$/.test(word) && !forms.some((form) => NON_AGENT_ER.has(form) || lexicon.dataNouns.has(form));
};

// Non-person subjects with intent verbs anywhere and component subjects with action verbs in doc comments.
const animateSubject = rule("animate-subject", "A thing that intends, decides or knows, or a component invented as an actor.", "high", (context) => {
  const code = codeOption(context.options);
  const lex = lexiconOption(context.options);
  const comments = (context.options as { comments?: boolean } | null)?.comments === true;
  const advice = comments
    ? `Write a noun phrase that names the thing and the program that uses it ("${GOLDEN_COMMENT}"), a condition or a copula sentence ("The rate is ..."). Never invent an actor.`
    : 'Make the program or person that really acts the subject, or write a copula sentence ("The rate is ..."). Never invent an actor.';
  return {
    Sentence({ dep }) {
      for (const subject of dep.tokens) {
        if (subject.deprel !== "nsubj") continue;
        const verb = byId(dep, subject.head);
        if (!verb || verb.upos !== "VERB" || inCode(code, verb) || isTerm(lex, verb)) continue;
        let noun = subject;
        if (RELATIVE.has(lower(subject)) && verb.deprel === "acl:relcl") noun = byId(dep, verb.head) ?? subject;
        const person = PERSON_NOUNS.has(lower(noun)) || singular(lower(noun)).some((form) => PERSON_NOUNS.has(form));
        if (person || inCode(code, noun)) continue;
        const word = lower(verb);
        const bareCapital = /^[A-Z]/.test(noun.form) && !/s$/.test(noun.form) && !kids(dep, noun.id).some((child) => child.deprel === "det" || child.deprel === "nmod:poss");
        if (lex.intentVerbs.has(word) && noun.upos !== "PROPN" && !isName(dep, noun) && !bareCapital && !lex.actorNouns.has(lower(noun))) {
          context.report({ span: { start: Math.min(subtreeSpan(dep, subject).start, verb.start), end: verb.end }, message: `"${noun.form}" is not a person and cannot "${verb.form}". ${advice}` });
          continue;
        }
        if (!comments || STATIVE.has(word) || IO_VERBS.has(word) || (noun.upos !== "NOUN" && noun.upos !== "PROPN") || !isRoleNoun(noun, lex)) continue;
        context.report({ span: { start: Math.min(subtreeSpan(dep, subject).start, verb.start), end: verb.end }, message: `This doc comment makes "${noun.form}" an actor that "${verb.form}". ${advice}` });
      }
    },
  };
});

const RULES: HouseRule[] = [inanimateSubject, agentlessPassive, participleAfterNoun, figurativeVerb, bannedWord, bannedPhrase, arrow, writtenMark, uiLabel, uiButton, uiDescription, repeatedSubject, choppyRun, islandSentence, stiltedNegation, unrelatedJoin, thingPossessive, missingObject, vagueVerb, animateSubject];

export const HOUSE_PACK = {
  name: "slopnuke",
  rules: Object.fromEntries(RULES.map((entry) => [entry.meta.name, entry])),
  categories: { "actor-first": { id: "actor-first", label: "Actor first", blurb: "Programs, processes and people act. Data does not." } },
};

export const FLOW_RULE_IDS = ["slopnuke/repeated-subject", "slopnuke/choppy-run", "slopnuke/island-sentence"];

export const HOUSE_RULE_IDS: readonly string[] = RULES.map((entry) => `slopnuke/${entry.meta.name}`);

export interface HouseSettings {
  lexicon: Lexicon;
  enabled: Set<string>;
}

export function houseRules(codeSpans: CodeSpan[], proseSpans: ProseRange[], settings: HouseSettings, flow = true, comments = false): Record<string, ["warn", unknown]> {
  const options = { codeSpans, proseSpans, lexicon: settings.lexicon, comments };
  return Object.fromEntries(HOUSE_RULE_IDS.filter((id) => settings.enabled.has(id) && (flow || !FLOW_RULE_IDS.includes(id))).map((id) => [id, ["warn", options]]));
}

const IDENTIFIER = /^[A-Za-z_][\w.-]*$/;
const INLINE_CODE = /`([^`\n]+)`/g;

// Inline code restore into blanked extraction text at identical offsets with one placeholder word for code that is not an identifier.
export function restoreCode(source: string, text: string, placeholderOnly = false): { text: string; spans: CodeSpan[] } {
  if (source.length !== text.length) return { text, spans: [] };
  let restored = text;
  const spans: CodeSpan[] = [];
  for (const match of source.matchAll(INLINE_CODE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const content = match[1];
    if (restored.slice(start, end).trim() !== "") continue;
    const lineStart = restored.lastIndexOf("\n", start) + 1;
    const lineEnd = restored.indexOf("\n", end);
    const line = restored.slice(lineStart, lineEnd === -1 ? restored.length : lineEnd);
    if (!/[\p{L}\p{N}]/u.test(line)) continue;
    const literal = IDENTIFIER.test(content) && !placeholderOnly && !/[.!?:]$/.test(content);
    const shown = literal ? content : `X${" ".repeat(content.length - 1)}`;
    restored = `${restored.slice(0, start)} ${shown} ${restored.slice(end)}`;
    spans.push({ start: start + 1, end: literal ? end - 1 : start + 2 });
  }
  return { text: restored, spans };
}
