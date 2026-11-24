// Prose spans inside code for the house rules.

import { extname } from "node:path";
import { figurativeAt, type HouseSettings } from "./house.ts";

export const CODE_VERSION = 9;

export type Lang = "js" | "jsx" | "py" | "rust" | "go" | "swift";
export type ProseKind = "test-name" | "test-group" | "message" | "ui-label" | "ui-button" | "ui-text" | "ui-description";

export interface ProseSpan {
  kind: ProseKind;
  start: number;
  end: number;
  exact: boolean;
  text: string;
  raw: string;
  literal: boolean;
}

export interface IdentifierSpan {
  start: number;
  end: number;
  name: string;
}

export interface CodeProse {
  spans: ProseSpan[];
  identifiers: IdentifierSpan[];
}

const LANGS: Record<string, Lang> = {
  ".js": "js", ".mjs": "js", ".cjs": "js", ".ts": "js", ".mts": "js", ".cts": "js",
  ".jsx": "jsx", ".tsx": "jsx",
  ".py": "py", ".rs": "rust", ".go": "go", ".swift": "swift",
};

export function languageOf(file: string): Lang | null {
  return LANGS[extname(file).toLowerCase()] ?? null;
}

// Code text with a space for each comment character that the SlopSift extractor reports.
export function blankComments(source: string, comments: string): string {
  if (comments.length !== source.length) return source;
  let out = "";
  for (let index = 0; index < source.length; index++) out += /\s/.test(comments[index]) ? source[index] : " ";
  return out;
}

const PRAGMA = /^\s*(?:MARK\s*:|TODO\b|FIXME\b|HACK\b|XXX\b|swiftlint:|swift-format-ignore|sourcery:|periphery:|eslint-(?:disable|enable)|prettier-ignore|biome-ignore|@ts-(?:ignore|expect-error|nocheck|check)\b|jshint\b|istanbul\s+ignore|[cv]8\s+ignore|noqa\b|type:\s*ignore|pylint:|mypy:|pyright:|ruff:|fmt:\s*(?:off|on|skip)|rubocop:|clang-format\s+(?:off|on)|NOLINT|nolint\b|go:[a-z]+|#?(?:end)?region\b|-\*-|@formatter:|@generated\b|DO NOT EDIT|cspell:|spell-checker:|#?pragma\b)/i;
const LICENSE = /copyright|©|\(c\)\s*\d{4}|all rights reserved|licensed under|SPDX-License-Identifier|created by .+ on \d/i;
const CODEISH = /(?:\b(?:let|var|const)\s+\w+\s*[:=])|(?:^\s*(?:let|var|func|if|for|while|guard|return|import|public|private|internal|static|case|struct|class|enum|protocol|extension|def|fn|const|#include|#define)\b.*[=({:])|[{};]\s*$|^\s*[}\])]/;

type LineKind = "comment" | "trailing" | "break" | "code" | "blank";

// Comment text with each comment block as its own passage and with pragma lines and license headers as breaks.
export function commentPassages(source: string, comments: string): string {
  if (comments.length !== source.length) return comments;
  const out = comments.split("");
  const lines: { start: number; end: number; kind: LineKind; license: boolean }[] = [];
  const blocks = [...source.matchAll(/\/\*[\s\S]*?\*\//g)].map((match) => [match.index ?? 0, (match.index ?? 0) + match[0].length]);
  for (let start = 0; start <= source.length; ) {
    const newline = source.indexOf("\n", start);
    const end = newline === -1 ? source.length : newline;
    const text = comments.slice(start, end);
    const raw = source.slice(start, end).trim();
    let kind: LineKind = raw === "" ? "blank" : /^(?:\/\/|\/\*|\*|#|--)/.test(raw) && !/\S/.test(text) ? "break" : "code";
    let license = false;
    if (/\S/.test(text)) {
      const marker = text.match(/^(\s*)([/!*]+)/);
      if (marker) for (let index = marker[1].length; index < marker[0].length; index++) out[start + index] = " ";
      const content = out.slice(start, end).join("");
      license = LICENSE.test(content);
      const leading = /^(?:\/\/|\/\*|\*|#|--)/.test(raw);
      const at = start + text.search(/\S/);
      const marked = leading || /(?:\/\/|\/\*|#|--)/.test(source.slice(start, at)) || blocks.some(([open, close]) => at > open && at < close);
      kind = !marked ? "code" : license || PRAGMA.test(content) || CODEISH.test(content) || !/\p{L}/u.test(content) ? "break" : leading ? "comment" : "trailing";
    }
    lines.push({ start, end, kind, license });
    if (newline === -1) break;
    start = newline + 1;
  }
  const firstCode = lines.findIndex((line) => line.kind === "code");
  const header = lines.slice(0, firstCode === -1 ? lines.length : firstCode);
  if (header.some((line) => line.license)) for (const line of header) if (line.kind === "comment") line.kind = "break";
  let previous: LineKind = "blank";
  for (const line of lines) {
    if (line.kind === "break" || line.kind === "code") {
      for (let index = line.start; index < line.end; index++) out[index] = " ";
      if (line.end - line.start >= 2) out[line.end - 1] = "\n";
    } else if (line.kind === "comment" && previous !== "comment" && /\s/.test(out[line.start] ?? "")) {
      out[line.start] = "\u2029";
    } else if (line.kind === "trailing") {
      const first = out.slice(line.start, line.end).findIndex((character) => /\S/.test(character));
      if (first > 0) out[line.start + first - 1] = "\u2029";
    }
    if (line.kind !== "blank" || previous === "comment") previous = line.kind === "trailing" ? "code" : line.kind;
  }
  return out.join("");
}

const QUOTES: Record<Lang, string> = { js: "\"'`", jsx: "\"'`", py: "\"'", rust: "\"", go: "\"`", swift: "\"" };

interface Literal {
  start: number;
  end: number;
  quote: string;
  prefix: string;
}

// Single-line string literal at an index with optional Python prefix letters.
function readLiteral(code: string, at: number, lang: Lang): Literal | null {
  let index = at;
  let prefix = "";
  if (lang === "py") {
    while (/[rRfFbBuU]/.test(code[index] ?? "") && prefix.length < 2) prefix += code[index++];
  }
  const quote = code[index];
  if (!quote || !QUOTES[lang].includes(quote)) return null;
  if (code.startsWith(quote.repeat(3), index)) return null;
  const raw = /r/i.test(prefix) || (lang === "go" && quote === "`");
  for (let cursor = index + 1; cursor < code.length; cursor++) {
    const character = code[cursor];
    if (character === "\n" && quote !== "`") return null;
    if (character === "\\" && !raw) {
      cursor++;
      continue;
    }
    if (character === quote) return { start: index + 1, end: cursor, quote, prefix };
  }
  return null;
}

const blank = (text: string): string => " ".repeat(text.length);

// Interpolation holes from an opener to the balanced closer as one placeholder word.
function blankHoles(text: string, opener: string, open: string, close: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (!text.startsWith(opener, index)) {
      out += text[index++];
      continue;
    }
    let depth = 0;
    let end = index + opener.length - 1;
    for (; end < text.length; end++) {
      if (text[end] === open) depth++;
      else if (text[end] === close && --depth === 0) break;
    }
    const stop = Math.min(end + 1, text.length);
    out += `N${" ".repeat(stop - index - 1)}`;
    index = stop;
  }
  return out;
}

// Same-length literal text with escapes and interpolation holes as spaces.
function literalProse(raw: string, lang: Lang, literal: Literal): string {
  let text = raw;
  if (!/r/i.test(literal.prefix)) text = text.replace(/\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)/g, blank);
  if ((lang === "js" || lang === "jsx") && literal.quote === "`") text = blankHoles(text, "${", "{", "}");
  if (lang === "swift") text = blankHoles(raw, "\\(", "(", ")").replace(/\\(?:u\{[0-9a-fA-F]+\}|.)/g, blank);
  if ((lang === "py" && /f/i.test(literal.prefix)) || lang === "rust") text = blankHoles(text, "{", "{", "}");
  if (lang === "go" || lang === "py" || lang === "swift" || lang === "rust") text = text.replace(/%[-+ #0]*\d*(?:\.\d+)?[a-zA-Z@]/g, blank);
  return text;
}

interface Pattern {
  kind: ProseKind;
  regex: RegExp;
}

const JS_PATTERNS: Pattern[] = [
  { kind: "test-name", regex: /\b(?:test|it)(?:\.(?:only|skip|todo|concurrent))?\s*\(\s*/g },
  { kind: "test-group", regex: /\b(?:describe|suite|context)(?:\.(?:only|skip))?\s*\(\s*/g },
];

const PATTERNS: Record<Lang, Pattern[]> = {
  js: JS_PATTERNS,
  jsx: [...JS_PATTERNS, { kind: "ui-label", regex: /\b(?:aria-label|title|placeholder|alt|label)=/g }],
  py: [],
  rust: [],
  go: [{ kind: "test-name", regex: /\bt\.Run\(\s*/g }],
  swift: [
    { kind: "test-name", regex: /@Test\(\s*/g },
    { kind: "test-group", regex: /@Suite\(\s*/g },
    { kind: "ui-text", regex: /\bText\(\s*/g },
    { kind: "ui-description", regex: /\.help\(\s*/g },
    { kind: "ui-button", regex: /\bButton\(\s*/g },
    { kind: "ui-label", regex: /\b(?:Label|Toggle|TextField|SecureField|Section|Picker|Stepper|Menu|\.navigationTitle|\.alert)\(\s*/g },
  ],
};

// Message text with at least two words and no key=value pairs.
const isProse = (raw: string): boolean => /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(raw) && !/\w=\S/.test(raw);

// Callee name words that slopnuke reads as the mark of a call with a message as the first argument.
const MESSAGE_WORDS = new Set(
  `error errors errorf exception failure failures fail fault violation warning warn log logger logging info debug trace notice
  critical fatal panic abort bail anyhow unreachable unimplemented todo expect usage output print println printf eprintln
  message reason die`.split(/\s+/),
);
const CALL = /\b([A-Za-z_][\w.]*)(!?)\s*\(\s*/g;

// Identifier-named tests with the test prefix as blanks and word breaks as spaces.
const NAMED_TESTS: Record<Lang, RegExp | null> = {
  js: null,
  jsx: null,
  py: /\bdef\s+(test_\w+)/g,
  rust: /#\[(?:tokio::)?test[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g,
  go: /\bfunc\s+(Test[A-Z]\w*)\s*\(/g,
  swift: /\bfunc\s+(test[A-Z]\w*)\s*\(/g,
};

const DECLARATIONS: Record<Lang, RegExp> = {
  js: /\b(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  jsx: /\b(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  py: /\b(?:def|class)\s+([A-Za-z_]\w*)/g,
  rust: /\b(?:fn|struct|enum|trait|type|const|static|let(?:\s+mut)?)\s+([A-Za-z_]\w*)/g,
  go: /\b(?:func(?:\s*\([^)]*\))?|type|var|const)\s+([A-Za-z_]\w*)/g,
  swift: /\b(?:func|struct|class|enum|protocol|actor|let|var|typealias)\s+([A-Za-z_]\w*)/g,
};

export function splitWords(name: string): string[] {
  return name
    .split(/[_\-$]+/)
    .flatMap((part) => part.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/g) ?? [])
    .map((word) => word.toLowerCase());
}

function namedTest(name: string, start: number, lang: Lang): ProseSpan {
  if (lang === "py" || lang === "rust") {
    const prefix = name.match(/^test_+/)?.[0] ?? "";
    const text = blank(prefix) + name.slice(prefix.length).replace(/_/g, " ");
    return { kind: "test-name", start, end: start + name.length, exact: true, text, raw: name, literal: false };
  }
  const words = splitWords(name.replace(/^(?:Test|test)/, ""));
  return { kind: "test-name", start, end: start + name.length, exact: false, text: words.join(" "), raw: name, literal: false };
}

const BUTTON_TEXT = /<(button|Button)\b[^<>]*>([^<>{}]*[A-Za-z][^<>{}]*)<\/\1>/g;
const JSX_TEXT = />([^<>{}\n]*[A-Za-z][^<>{}\n]*)</g;

// Last string literal argument of the call with the open paren at an index.
function lastArgument(code: string, open: number, lang: Lang): Literal | null {
  let depth = 0;
  let last: Literal | null = null;
  for (let index = open; index < code.length; index++) {
    const character = code[index];
    if (QUOTES[lang].includes(character)) {
      const literal = readLiteral(code, index, lang);
      if (!literal) return null;
      if (depth === 1) last = literal;
      index = literal.end;
    } else if ("([{".includes(character)) depth++;
    else if (")]}".includes(character) && --depth === 0) return last;
  }
  return null;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Interior ranges of every single-line string literal in source order.
function literalRanges(code: string, lang: Lang): [number, number][] {
  const ranges: [number, number][] = [];
  for (let index = 0; index < code.length; index++) {
    if (!QUOTES[lang].includes(code[index])) continue;
    const literal = readLiteral(code, index, lang);
    if (!literal) continue;
    ranges.push([literal.start, literal.end]);
    index = literal.end;
  }
  return ranges;
}

export function extractCodeProse(lang: Lang, code: string, descriptionCalls: readonly string[] = []): CodeProse {
  const strings = literalRanges(code, lang);
  const inString = (at: number): boolean => strings.some(([start, end]) => at >= start && at < end);
  const spans: ProseSpan[] = [];
  const taken = new Set<number>();
  const add = (span: ProseSpan): void => {
    if (taken.has(span.start) || !/\p{L}/u.test(span.text)) return;
    taken.add(span.start);
    spans.push(span);
  };
  for (const { kind, regex } of PATTERNS[lang]) {
    for (const match of code.matchAll(regex)) {
      if (inString(match.index ?? 0)) continue;
      const literal = readLiteral(code, (match.index ?? 0) + match[0].length, lang);
      if (!literal) continue;
      let text = literalProse(code.slice(literal.start, literal.end), lang, literal);
      if (kind === "test-name") text = text.replace(/->/g, ", ");
      add({ kind, start: literal.start, end: literal.end, exact: true, text, raw: code.slice(literal.start, literal.end), literal: true });
    }
  }
  for (const call of descriptionCalls) {
    for (const match of code.matchAll(new RegExp(`${/^\w/.test(call) ? "\\b" : ""}${escapeRegExp(call)}\\s*\\(`, "g"))) {
      if (inString(match.index ?? 0)) continue;
      const literal = lastArgument(code, (match.index ?? 0) + match[0].length - 1, lang);
      if (!literal) continue;
      const raw = code.slice(literal.start, literal.end);
      add({ kind: "ui-description", start: literal.start, end: literal.end, exact: true, text: literalProse(raw, lang, literal), raw, literal: true });
    }
  }
  for (const match of code.matchAll(CALL)) {
    if (inString(match.index ?? 0)) continue;
    if (!splitWords(match[1]).some((word) => MESSAGE_WORDS.has(word))) continue;
    const literal = readLiteral(code, (match.index ?? 0) + match[0].length, lang);
    if (!literal || !isProse(code.slice(literal.start, literal.end))) continue;
    add({ kind: "message", start: literal.start, end: literal.end, exact: true, text: literalProse(code.slice(literal.start, literal.end), lang, literal), raw: code.slice(literal.start, literal.end), literal: true });
  }
  const named = NAMED_TESTS[lang];
  if (named) {
    for (const match of code.matchAll(named)) {
      if (inString(match.index ?? 0)) continue;
      const name = match[1];
      add(namedTest(name, (match.index ?? 0) + match[0].lastIndexOf(name), lang));
    }
  }
  if (lang === "jsx") {
    for (const match of code.matchAll(BUTTON_TEXT)) {
      const start = (match.index ?? 0) + match[0].indexOf(">") + 1;
      add({ kind: "ui-button", start, end: start + match[2].length, exact: true, text: match[2], raw: match[2], literal: false });
    }
    for (const match of code.matchAll(JSX_TEXT)) {
      const start = (match.index ?? 0) + 1;
      add({ kind: "ui-text", start, end: start + match[1].length, exact: true, text: match[1], raw: match[1], literal: false });
    }
  }
  const identifiers: IdentifierSpan[] = [];
  for (const match of code.matchAll(DECLARATIONS[lang])) {
    if (inString(match.index ?? 0)) continue;
    const name = match[1];
    const start = (match.index ?? 0) + match[0].lastIndexOf(name);
    identifiers.push({ start, end: start + name.length, name });
  }
  return { spans: spans.sort((a, b) => a.start - b.start), identifiers };
}

// Prose spans laid out one per paragraph with a passage break after each and a map back to source offsets.
export interface Layout {
  text: string;
  chunks: { span: ProseSpan; at: number }[];
}

export function layout(spans: readonly ProseSpan[]): Layout {
  let text = "";
  const chunks: Layout["chunks"] = [];
  for (const span of spans) {
    chunks.push({ span, at: text.length });
    text += `${span.text}\n\n\u2029`;
  }
  return { text, chunks };
}

export function toSource(map: Layout, start: number, end: number): { start: number; end: number } | null {
  let chunk: Layout["chunks"][number] | undefined;
  for (const entry of map.chunks) {
    if (entry.at <= start) chunk = entry;
    else break;
  }
  if (!chunk || start >= chunk.at + chunk.span.text.length) return null;
  const { span, at } = chunk;
  if (!span.exact) return { start: span.start, end: span.end };
  return { start: span.start + (start - at), end: Math.min(span.end, span.start + (end - at)) };
}

export const CODE_EXTENSIONS = new Set(Object.keys(LANGS));

const MEMBER = /\.([a-z][A-Za-z0-9]*)\b/g;
const ENUM_CASE = /\bcase\s+([a-z][A-Za-z0-9]*)/g;

// Lowercase declared names and enum cases and member references of one file.
export function codeTerms(code: string, prose: CodeProse): Set<string> {
  const terms = new Set(prose.identifiers.map((identifier) => identifier.name.toLowerCase()));
  for (const match of code.matchAll(MEMBER)) terms.add(match[1].toLowerCase());
  for (const match of code.matchAll(ENUM_CASE)) terms.add(match[1].toLowerCase());
  return terms;
}
export const isTestSpan = (span: ProseSpan): boolean => span.kind === "test-name" || span.kind === "test-group";

export interface CodeFinding {
  ruleId: string;
  start: number;
  end: number;
  message: string;
}

const TEST_NAME_FORMAT = /^[^:\n]*[^:\s]: \S(?:.*\S)? -> \S(?:.*\S)?$/;
const UI_TONE = /\b(?:please|sorry|oops|welcome|thanks|thank you|unfortunately|because|since|so that|in order to|apolog\w*)\b|!/i;

// Lexical part of the code rules that slopnuke runs without a parse.
export function codeFindings(spans: readonly ProseSpan[], identifiers: readonly IdentifierSpan[], settings: HouseSettings): CodeFinding[] {
  const findings: CodeFinding[] = [];
  const on = (id: string): boolean => settings.enabled.has(id);
  for (const span of spans) {
    if (on("slopnuke/test-name-format") && span.kind === "test-name" && span.literal && !TEST_NAME_FORMAT.test(span.raw.trim())) {
      findings.push({ ruleId: "slopnuke/test-name-format", start: span.start, end: span.end, message: "Test name outside the `subject: input -> outcome` shape." });
    }
    const tone = on("slopnuke/ui-tone") && span.kind.startsWith("ui-") ? span.raw.match(UI_TONE) : null;
    if (tone) findings.push({ ruleId: "slopnuke/ui-tone", start: span.start, end: span.end, message: `UI string with "${tone[0]}". Remove greetings, apologies, reasons and exclamation marks.` });
  }
  for (const identifier of on("slopnuke/identifier-word") ? identifiers : []) {
    const words = splitWords(identifier.name);
    const hits = words.filter((word, index) => settings.lexicon.bannedWords.has(word) || figurativeAt(words, index));
    if (hits.length > 0) findings.push({ ruleId: "slopnuke/identifier-word", start: identifier.start, end: identifier.end, message: `Identifier "${identifier.name}" with the word "${hits[0]}". Rename it with a plain, literal word.` });
  }
  return findings;
}
