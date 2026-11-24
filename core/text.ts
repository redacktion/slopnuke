import { GOLDEN_COMMENT, GOLDEN_DESCRIPTION, LINKS, MARKS, noActorFallback, SENTENCE_BAND, SPOKEN_TEST } from "./contract.ts";
import { isAbsolute, relative } from "node:path";
import { fingerprint, type ShownFinding } from "./accept.ts";
import { MAX_ROUNDS, type Action, type Finding, type Note, type Phase } from "./run.ts";

export const MAX_FINDINGS_PER_PROMPT = 60;
const EXCERPT_LIMIT = 240;
const SUMMARY_FILES = 8;
const FAILURES_SHOWN = 3;

export const PHASE_LABEL: Record<Phase, string> = {
  own: "edited files",
  cc: "code comments",
  md: "markdown files",
  code: "code strings and names",
  tests: "test names",
};

export function displayPath(file: string, cwd: string): string {
  const rel = relative(cwd, file);
  return rel.startsWith("..") || isAbsolute(rel) ? file : rel;
}

export function describe(note: Note, cwd: string): string {
  switch (note.kind) {
    case "empty":
      return note.phase === "own"
        ? "slopnuke: edited files: no edited file changed since its last clean scan"
        : `slopnuke: ${PHASE_LABEL[note.phase]}: no files to scan`;
    case "clean":
      return `slopnuke: ${PHASE_LABEL[note.phase]}: clean`;
    case "stopped":
      return `slopnuke: ${PHASE_LABEL[note.phase]}: stopped with ${note.total} finding(s) left after ${note.rounds} round(s), ${note.reason === "stalled" ? "findings stopped dropping" : "round limit"}`;
    case "unscanned": {
      const shown = note.failures.slice(0, FAILURES_SHOWN).map((failure) => `  ${displayPath(failure.file, cwd)}: ${failure.error}`);
      const hidden = note.failures.length - shown.length;
      return [`slopnuke: ${PHASE_LABEL[note.phase]}: ${note.failures.length} file(s) failed to scan`, ...shown, hidden > 0 ? `  ... ${hidden} more` : ""].filter(Boolean).join("\n");
    }
    case "aborted":
      return "slopnuke: stopped";
    case "failed":
      return `slopnuke: ${note.error}`;
  }
}

export function scanLine(action: Extract<Action, { kind: "scan" }>): string {
  const rescan = action.round > 0 ? `, rescan after round ${action.round}` : "";
  return `slopnuke: scanning ${action.files.length} file(s), ${PHASE_LABEL[action.phase]}${rescan}`;
}

export function skippedLine(phase: Phase, count: number): string {
  return `slopnuke: ${PHASE_LABEL[phase]}: skipped ${count} file(s) over 512 KiB or unreadable`;
}

export function roundSummary(action: Extract<Action, { kind: "rewrite" }>, cwd: string): string {
  const ranked = [...action.results].sort((a, b) => b.findings.length - a.findings.length);
  const lines = ranked.slice(0, SUMMARY_FILES).map((result) => `  ${String(result.findings.length).padStart(4)}  ${displayPath(result.file, cwd)}`);
  const hidden = ranked.length - lines.length;
  return [
    `slopnuke round ${action.round}/${MAX_ROUNDS} · ${PHASE_LABEL[action.phase]} · ${action.total} finding(s) in ${action.results.length} file(s)`,
    ...lines,
    hidden > 0 ? `  ... ${hidden} more file(s)` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface Shown {
  file: string;
  finding: Finding;
  id: string;
}

export function shownFindings(action: Extract<Action, { kind: "rewrite" }>): Shown[] {
  const shown: Shown[] = [];
  for (const result of action.results) {
    for (const finding of result.findings) {
      if (shown.length >= MAX_FINDINGS_PER_PROMPT) return shown;
      shown.push({ file: result.file, finding, id: fingerprint(finding.ruleId, finding.text) });
    }
  }
  return shown;
}

export function shownEntries(action: Extract<Action, { kind: "rewrite" }>, cwd: string): ShownFinding[] {
  const entries = new Map<string, ShownFinding>();
  for (const { file, finding, id } of shownFindings(action)) {
    const existing = entries.get(id);
    if (existing) existing.count += 1;
    else entries.set(id, { id, ruleId: finding.ruleId, text: finding.text, place: `${displayPath(file, cwd)}:${finding.line}`, message: finding.message, count: 1 });
  }
  return [...entries.values()];
}

export interface PromptHints {
  accept: string;
  stalled: boolean;
}

export function rewritePrompt(action: Extract<Action, { kind: "rewrite" }>, cwd: string, hints: PromptHints): string {
  const shown = shownFindings(action).map(({ file, finding, id }) => {
    const excerpt = finding.text.replace(/\s+/g, " ").slice(0, EXCERPT_LIMIT);
    return `${displayPath(file, cwd)}:${finding.line}:${finding.column} ${finding.ruleId} [${id}]\n  ${finding.message}\n  > ${excerpt}`;
  });
  const omitted = action.total - shown.length;
  return [
    `SlopNuke round ${action.round}/${MAX_ROUNDS}, scope: ${PHASE_LABEL[action.phase]}. ${action.total} finding(s).`,
    "Rewrite every flagged span in place. Read the region first: line numbers after an edit differ from this list.",
    SPOKEN_TEST,
    "State the behavior and its consequence directly. Keep meaning, leave unflagged text alone, no commentary in the reply.",
    "Make a program, process or person the subject of an action verb only when it really performs that action. Data, files, values and code components never act.",
    noActorFallback(action.phase === "cc" ? "comments" : action.phase === "code" || action.phase === "tests" ? "code" : "prose"),
    ...(action.phase === "cc" || action.phase === "own" ? [`Code comments: open with what the thing is as a noun phrase, then name the program that uses it and for what, for example "${GOLDEN_COMMENT}" Say what the thing is and where it is used, not how it works inside. Delete the comment when the name already says it.`] : []),
    ...(action.phase === "code" ? [`UI descriptions and help text: a noun phrase that says what the value is and what it applies to, for example "${GOLDEN_DESCRIPTION}" Labels: a noun phrase of at most four words. Buttons: a verb and its object.`] : []),
    MARKS,
    SENTENCE_BAND,
    LINKS,
    "For a repeated subject, use it or they, or open with a when or after clause. For short choppy sentences, join two related facts with which, when or then, or with because or so where one fact causes the other.",
    "Keep paragraphs as paragraphs. Use a list or a table only for parallel items such as steps, files, cases or options, never to clear a finding.",
    "For a finding that is correct as written, call the slopnuke review tool with its id. The user picks rewrite or accept for each finding.",
    `When the user approves a finding with no change in chat, put it on the accept list: ${hints.accept} <id>. Never accept a finding without the user's approval.`,
    ...(hints.stalled ? ["The finding count did not drop in the last round. Call the slopnuke review tool for each finding that is correct as written."] : []),
    "",
    ...shown,
    omitted > 0 ? `\n${omitted} more finding(s) surface on the next scan.` : "",
  ].join("\n");
}
