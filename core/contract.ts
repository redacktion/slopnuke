// One writing contract that every rule message and the rewrite prompt share.

export type ContractScope = "prose" | "comments" | "code";

export const SPOKEN_TEST =
  "Write what a person would say out loud in normal conversation. A sentence that would sound odd spoken aloud is wrong, whatever the findings say. When two findings pull opposite ways, keep the version a person would say and send the other finding to the review tool.";

export const MARKS = "No semicolons, no dashes or brackets around asides, and no slash pairs such as read/edit.";

export const SENTENCE_BAND = "Sentence length: 11 to 23 words. Under 24 words keeps reader-first/sentence-load quiet, and over 10 words keeps slopnuke/choppy-run quiet.";

export const LINKS = "When you split a sentence, tie the second half to the first with a repeated noun, that, this or then. Use so or because only when the first fact causes the second.";

export const GOLDEN_COMMENT = "Setting value type that the CLI uses for parsing, TOML validation and the config editor.";

export const GOLDEN_DESCRIPTION = "The total amount of concurrent slots for a loaded model.";

// What to write when no program or person acts.
export function noActorFallback(scope: ContractScope): string {
  return scope === "comments"
    ? `If no program acts, write a noun phrase that names the thing and the program that uses it ("${GOLDEN_COMMENT}"), a condition or a copula sentence. Never invent an actor, and never give a thing intent: no tries, learns, decides, chooses or knows.`
    : 'If no program acts, write a copula sentence ("The rate is ..."). Never invent an actor, and never give a thing intent: no tries, learns, decides, chooses or knows.';
}

const COMMENT_SHAPE = `Write a noun phrase that names the thing and the program that uses it ("${GOLDEN_COMMENT}"), a condition or a copula sentence.`;

// Advice per rule and scope that slopnuke puts in place of the SlopSift advice sentence.
export const SLOPSIFT_ADVICE: Readonly<Record<string, string | { prose: string; comments: string }>> = {
  "ai-style/comma-splice": "Join the clauses with and or but, with because or so where one causes the other, or end the first sentence with a period.",
  "ai-style/passive-actor-hiding": { prose: "Make the program or person that did it the subject. If nobody acts, write a copula sentence.", comments: COMMENT_SHAPE },
  "ai-style/passive-voice-density": { prose: "Make the program or person that acts the subject of each sentence. If nobody acts, write a copula sentence.", comments: COMMENT_SHAPE },
  "ai-style/headline-fragment": { prose: "Write it as a full sentence with a real actor or a copula verb.", comments: COMMENT_SHAPE },
  "ai-style/agentless-rationale": { prose: "Give each explanation its real subject, the program or person that acts.", comments: COMMENT_SHAPE },
  "ai-style/agentless-opener": "Make the program or person that acts the subject of the opening clause.",
  "ai-style/corrective-antithesis": 'Say what the thing is, and drop the "not Y" part unless a reader would assume Y.',
  "reader-first/fragment-chain": { prose: 'Write each one as a full sentence that a person would say aloud, with a real actor or a copula verb, for example "This spec is a proposal for the tool environment only."', comments: COMMENT_SHAPE },
  "reader-first/label-led-explanation": 'Turn each bold label into the subject of a full sentence, for example "The path length stays at 62 bytes".',
  "reader-first/aside-pileup": "Put the aside in its own sentence if it matters, otherwise delete it.",
  "reader-first/sentence-load": "Split it into two sentences of 11 to 23 words, and tie the second to the first with a repeated noun, that, this or then.",
};

// SlopSift rules that slopnuke turns off in each profile.
export const PROFILE_SLOPSIFT_OFF: Readonly<Record<string, readonly string[]>> = {
  standard: [],
  "actor-first": ["ai-style/evidence-cluster"],
};

// SlopSift message that slopnuke builds from the first sentence of the original and the contract advice.
export function contractMessage(ruleId: string, message: string, scope: ContractScope): string {
  const entry = SLOPSIFT_ADVICE[ruleId];
  if (entry === undefined) return message;
  const advice = typeof entry === "string" ? entry : scope === "comments" ? entry.comments : entry.prose;
  const cut = message.search(/[.!?)”"](?=\s+[A-Z])/);
  const diagnosis = cut === -1 ? message : message.slice(0, cut + 1);
  return `${diagnosis} ${advice}`;
}
