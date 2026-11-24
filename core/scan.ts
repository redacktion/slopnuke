import { contractMessage } from "./contract.ts";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { blankComments, CODE_EXTENSIONS, CODE_VERSION, codeFindings, commentPassages, codeTerms, type IdentifierSpan, type ProseSpan, extractCodeProse, isTestSpan, languageOf, layout, toSource } from "./code.ts";
import type { FileResult, Finding, Phase, ScanFailure } from "./run.ts";
import { accepts, type AcceptList } from "./accept.ts";
import { forScope, type Scope, type Settings } from "./config.ts";
import { HOUSE_PACK, houseRules, HOUSE_VERSION, restoreCode } from "./house.ts";
import { writePrivate } from "./store.ts";

export const LINT_OPTIONS = { profile: "recommended", rulepacks: ["ai-style", "reader-first"], house: HOUSE_VERSION, code: CODE_VERSION } as const;
export const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);
export const COMMENT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".kt", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".rb", ".php", ".sh", ".bash", ".zsh", ".lua", ".scala", ".sql", ".css", ".scss", ".yaml", ".yml", ".toml"]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_DISCOVERED = 20_000;
const MAX_CACHE_ENTRIES = 20_000;
const DISCOVERY_TIMEOUT_MS = 30_000;
const CACHE_VERSION = 5;
const MASK_VERSION = 2;
const SKIPPED_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules", "dist", "build", "out", "target", "coverage", ".next", ".nuxt", ".turbo", ".cache", ".venv", "venv", "__pycache__", "vendor", "Pods", ".gradle", "3rdparty", "third_party", "thirdparty", "third-party", "Carthage", "DerivedData", ".build"]);

// Scan module error for linter load failures.
export class ScanError extends Error {}

interface Lint {
  start: number;
  ruleId: string;
  message: string;
  text: string;
}

export type LintMode = "prose" | "code" | "tests" | "all";

const PHASE_MODES: Record<Phase, LintMode> = { own: "all", cc: "prose", md: "prose", code: "code", tests: "tests" };
export const modeFor = (phase: Phase): LintMode => PHASE_MODES[phase];

interface Linter {
  lint(file: string, source: string, mode: LintMode, settings: Settings): Promise<Lint[]>;
}

interface Extracted {
  text: string;
  sourceRange(start: number, end: number): [number, number];
  regions?: unknown;
  annotations?: unknown;
  language?: string;
}

// One run of the SlopSift engine with the slopnuke house pack beside the SlopSift profile.
async function buildLinter(entry: string, version: string): Promise<Linter> {
  const dist = dirname(entry);
  const module = await import(pathToFileURL(entry).href);
  const extract = await import(pathToFileURL(join(dist, "extract.js")).href);
  const profiles = await import(pathToFileURL(join(dist, "profiles.js")).href);
  const engine = (await module.createSlopSift())?.linter;
  if (typeof engine?.lint !== "function" || typeof extract.extractInput !== "function" || typeof extract.inputKind !== "function" || typeof extract.extractLintText !== "function" || typeof profiles.profileFor !== "function") {
    throw new ScanError(`slopsift ${version} lacks the engine, extract or profile internals that slopnuke needs`);
  }
  const extractFor = (kind: string, file: string, text: string): Extracted =>
    kind === "comments" ? { text: commentPassages(text, extract.extractLintText(file, text)), sourceRange: (start: number, end: number) => [start, end] } : extract.extractInput(file, text);
  const pass = async (kind: string, file: string, text: string, source: string, full: boolean, settings: Settings): Promise<Lint[]> => {
    const extracted = extractFor(kind, file, text);
    if (!/\p{L}/u.test(extracted.text)) return [];
    const comments = kind === "comments";
    const scoped = forScope(settings, comments ? "cc" : "md");
    const restored = kind === "prose" ? restoreCode(text, extracted.text) : comments ? backtickCode(extracted.text) : { text: extracted.text, spans: [] };
    const context = { language: extracted.language, regions: extracted.regions, annotations: extracted.annotations };
    const terms = new Set([...scoped.lexicon.terms, ...restored.spans.map((span) => restored.text.slice(span.start, span.end).toLowerCase())]);
    const house = { plugins: { slopnuke: HOUSE_PACK }, rules: houseRules(restored.spans, [], { enabled: scoped.enabled, lexicon: { ...scoped.lexicon, terms } }, full, comments), minimumSeverity: "warn" };
    const houseReport = await engine.lint(restored.text, house, context);
    const markdown = MARKDOWN_EXTENSIONS.has(extname(file).toLowerCase());
    const split = markdown ? splitPassages(text) : text;
    const profileExtracted = markdown ? extract.extractInput(file, split) : extracted;
    const profileText = markdown ? restoreCode(split, profileExtracted.text, true).text : profileExtracted.text;
    const profileConfig = { extends: [profiles.profileFor(kind, LINT_OPTIONS.profile, LINT_OPTIONS.rulepacks)], rules: Object.fromEntries(scoped.slopsiftOff.map((id) => [id, "off"])), minimumSeverity: "warn" };
    const profileReport = full ? await engine.lint(profileText, profileConfig, { language: profileExtracted.language, regions: profileExtracted.regions, annotations: profileExtracted.annotations }) : undefined;
    let lints = [...(profileReport?.lints ?? []), ...(houseReport?.lints ?? [])] as (Lint & { end: number })[];
    if (comments) {
      const sentences = (profileReport ?? houseReport)?.doc?.sentences ?? [];
      const passageBreak = String.fromCharCode(0x2029);
      lints = lints.filter((lint) => !extracted.text.slice(lint.start + 1, lint.end).includes(passageBreak) && !/\n[ \t]*\n/.test(extracted.text.slice(lint.start, lint.end)));
      lints = lints.filter((lint) => {
        if (!DOC_EXEMPT.has(lint.ruleId)) return true;
        const covered = sentences.filter((sentence: DocSentence) => sentence.end > lint.start && sentence.start < lint.end);
        return covered.length === 0 || !covered.every(acceptedDocShape);
      });
    }
    return lints.map((lint) => {
      const [start, end] = extracted.sourceRange(lint.start, lint.end);
      return { ...lint, message: contractMessage(lint.ruleId, lint.message, comments ? "comments" : "prose"), start, text: source.slice(start, end) };
    });
  };
  const prosePass = async (file: string, source: string, settings: Settings): Promise<Lint[]> => {
    const kind = extract.inputKind(file);
    if (!kind) return [];
    const markdown = MARKDOWN_EXTENSIONS.has(extname(file).toLowerCase());
    const lints = (await pass(kind, file, markdown ? protectAngles(maskTables(source, file)) : source, source, true, settings)).filter((lint) => lint.ruleId !== "reader-first/paragraph-load" || listItems(lint.text) < 2);
    if (markdown && TABLE_START.test(source)) lints.push(...(await pass(kind, file, protectAngles(tablesOnly(source)), source, false, settings)));
    const quoted = [...source.matchAll(QUOTED)].map((match) => [match.index ?? 0, (match.index ?? 0) + match[0].length]);
    return lints.filter((lint) => !(lint.ruleId.startsWith("slopnuke/") && quoted.some(([start, end]) => lint.start > start && lint.start < end)));
  };
  const codePass = async (file: string, source: string, mode: Exclude<LintMode, "prose">, settings: Settings): Promise<Lint[]> => {
    const lang = languageOf(file);
    if (!lang) return [];
    const code = blankComments(source, extract.extractLintText(file, source));
    const prose = extractCodeProse(lang, code, settings.descriptionCalls);
    const fileSettings: Settings = { ...settings, lexicon: { ...settings.lexicon, terms: new Set([...settings.lexicon.terms, ...codeTerms(code, prose)]) } };
    const groups: [Scope, ProseSpan[], IdentifierSpan[]][] = [];
    if (mode !== "tests") groups.push(["code", prose.spans.filter((span) => !isTestSpan(span)), prose.identifiers]);
    if (mode !== "code") groups.push(["tests", prose.spans.filter(isTestSpan), []]);
    const lints: Lint[] = [];
    for (const [scope, spans, identifiers] of groups) {
      const scoped = forScope(fileSettings, scope);
      if (spans.length > 0) {
        const map = layout(spans);
        const ranges = map.chunks.map(({ span, at }) => ({ start: at, end: at + span.text.length, kind: span.kind }));
        const report = await engine.lint(map.text, { plugins: { slopnuke: HOUSE_PACK }, rules: houseRules([], ranges, scoped, false), minimumSeverity: "warn" }, {});
        for (const lint of (report?.lints ?? []) as (Lint & { end: number })[]) {
          const range = toSource(map, lint.start, lint.end);
          if (range) lints.push({ ...lint, start: range.start, text: source.slice(range.start, range.end) });
        }
      }
      for (const finding of codeFindings(spans, identifiers, scoped)) lints.push({ ruleId: finding.ruleId, message: finding.message, start: finding.start, text: source.slice(finding.start, finding.end) });
    }
    return lints;
  };
  return {
    async lint(file, source, mode, settings) {
      const lints =
        mode === "prose" ? await prosePass(file, source, settings) : mode === "all" ? [...(await prosePass(file, source, settings)), ...(await codePass(file, source, "all", settings))] : await codePass(file, source, mode, settings);
      return lints.sort((a, b) => a.start - b.start);
    },
  };
}

export interface LinterHandle {
  linter: Linter;
  version: string;
  salt: string;
}

export type LintOutcome = { kind: "findings"; findings: Finding[]; content: string } | { kind: "skipped" } | { kind: "failed"; error: string };

const message = (error: unknown): string => String((error as Error)?.message ?? error).replace(/\s+/g, " ").slice(0, 400);

export async function loadLinter(roots: string[]): Promise<LinterHandle | null> {
  for (const root of roots) {
    let entry: string;
    try {
      entry = createRequire(join(root, "package.json")).resolve("slopsift");
    } catch {
      continue;
    }
    if (!entry.startsWith(root + sep)) continue;
    try {
      const version = JSON.parse(readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8")).version;
      const linter = await buildLinter(entry, version);
      return { linter, version, salt: `${version}\0${JSON.stringify(LINT_OPTIONS)}\0${MASK_VERSION}` };
    } catch (error) {
      if (error instanceof ScanError) throw error;
      throw new ScanError(`slopsift failed to start: ${message(error)}`);
    }
  }
  return null;
}

interface CacheEntry {
  h: string;
  f: Finding[];
}

function isFinding(value: any): value is Finding {
  return (
    value !== null &&
    typeof value === "object" &&
    Number.isInteger(value.line) &&
    Number.isInteger(value.column) &&
    typeof value.ruleId === "string" &&
    typeof value.message === "string" &&
    typeof value.text === "string"
  );
}

// Content-hash finding cache with recency order for trimming.
export class FindingCache {
  private readonly path: string;
  private entries: Map<string, CacheEntry> | undefined;
  private dirty = false;

  constructor(path: string) {
    this.path = path;
  }

  private load(): Map<string, CacheEntry> {
    if (this.entries) return this.entries;
    this.entries = new Map();
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      if (parsed?.version !== CACHE_VERSION || !parsed.files || typeof parsed.files !== "object") return this.entries;
      for (const [file, record] of Object.entries<any>(parsed.files)) {
        if (record && typeof record.h === "string" && Array.isArray(record.f) && record.f.every(isFinding)) this.entries.set(file, { h: record.h, f: record.f });
      }
    } catch {}
    return this.entries;
  }

  get(file: string, hash: string): Finding[] | undefined {
    const entries = this.load();
    const entry = entries.get(file);
    if (entry?.h !== hash) return undefined;
    entries.delete(file);
    entries.set(file, entry);
    this.dirty = true;
    return entry.f;
  }

  put(file: string, hash: string, findings: Finding[]): void {
    const entries = this.load();
    entries.delete(file);
    entries.set(file, { h: hash, f: findings });
    this.dirty = true;
  }

  save(): void {
    if (!this.entries || !this.dirty) return;
    const kept = [...this.entries].slice(-MAX_CACHE_ENTRIES);
    try {
      writePrivate(this.path, JSON.stringify({ version: CACHE_VERSION, files: Object.fromEntries(kept) }));
      this.dirty = false;
    } catch {}
  }
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
  return starts;
}

function lineColumn(starts: number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - starts[low] + 1 };
}

export function locate(text: string, offset: number): { line: number; column: number } {
  return lineColumn(lineStarts(text), offset);
}

// Double-quoted spans on one line for mention-not-use filtering.
const QUOTED = /"[^"\n]*"|“[^”\n]*”/g;
const TABLE_ROW = /^[ \t]*\|.*$/gm;
const TABLE_START = /^[ \t]*\|/m;

// Bare angle bracket swap against the multi-line HTML mask in slopsift extraction.
export function protectAngles(text: string): string {
  return text.replace(/<(?![^>\n]*>)/g, "\u2039");
}

function tablesOnly(text: string): string {
  return text.replace(/^.*$/gm, (line) => (/^[ \t]*\|/.test(line) ? line : " ".repeat(line.length)));
}

const LIST_ITEM = /^[ \t]{0,3}(?:\d+[.)]|[-*+])[ \t]+\S/;
const HEADING = /^([ \t]{0,3})##(#{0,4}[ \t]+\S)/;

// Same-length markdown text where a heading of level two or deeper after a text line starts a new paragraph.
export function splitPassages(text: string): string {
  const lines = text.split("\n");
  return lines.map((line, index) => (index > 0 && lines[index - 1].trim() !== "" && HEADING.test(line) ? line.replace(HEADING, "$1\n#$2") : line)).join("\n");
}

// Comment text with backtick names and snake or camel case words as code spans and the backticks as spaces.
function backtickCode(text: string): { text: string; spans: { start: number; end: number }[] } {
  const spans: { start: number; end: number }[] = [];
  const out = text.replace(/`([^`\n]+)`/g, (match, content: string, offset: number) => {
    spans.push({ start: offset + 1, end: offset + 1 + content.length });
    return ` ${content} `;
  });
  for (const match of out.matchAll(/\b(?:[A-Za-z]+_[A-Za-z0-9_]+|[a-z]+[A-Z][A-Za-z0-9]*)\b/g)) spans.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  return { text: out, spans };
}

const listItems = (text: string): number => text.split("\n").filter((line) => LIST_ITEM.test(line)).length;

const DOC_EXEMPT = new Set(["reader-first/fragment-chain", "ai-style/headline-fragment", "ai-style/agentless-rationale", "ai-style/evidence-cluster", "slopnuke/island-sentence", "slopnuke/repeated-subject"]);
const CONDITION_OPENER = /^\s*(?:condition|precondition|requires?|when|if|unless)\b/i;

interface DocSentence {
  start: number;
  end: number;
  text: string;
  dep: { tokens: { id: number; head: number; deprel: string; upos: string }[] };
}

// Doc comment sentence in an accepted shape: a condition, a copula sentence, or a noun phrase with no main verb.
export function acceptedDocShape(sentence: DocSentence): boolean {
  if (CONDITION_OPENER.test(sentence.text)) return true;
  const root = sentence.dep.tokens.find((token) => token.deprel === "root");
  if (!root) return false;
  if (root.upos === "AUX" || sentence.dep.tokens.some((token) => token.deprel === "cop" && token.head === root.id)) return true;
  return root.upos !== "VERB";
}

export function maskTables(text: string, file: string): string {
  if (!MARKDOWN_EXTENSIONS.has(extname(file).toLowerCase()) || !TABLE_START.test(text)) return text;
  return text.replace(TABLE_ROW, (row) => " ".repeat(row.length));
}

export async function lintFile(handle: LinterHandle, cache: FindingCache, file: string, mode: LintMode, settings: Settings): Promise<LintOutcome> {
  let buffer: Buffer;
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return { kind: "skipped" };
    buffer = readFileSync(file);
  } catch {
    return { kind: "skipped" };
  }
  const text = buffer.toString("utf8");
  const content = createHash("sha256").update(buffer).digest("hex");
  const hash = createHash("sha256").update(handle.salt).update("\0").update(mode).update("\0").update(settings.hash).update("\0").update(text).digest("hex");
  const key = `${mode}\0${file}`;
  const cached = cache.get(key, hash);
  if (cached) return { kind: "findings", findings: cached, content };
  let lints: Lint[];
  try {
    lints = await handle.linter.lint(file, text, mode, settings);
  } catch (error) {
    return { kind: "failed", error: message(error) };
  }
  const starts = lineStarts(text);
  const findings = lints.map((lint) => ({ ...lineColumn(starts, lint.start), ruleId: lint.ruleId, message: lint.message, text: lint.text }));
  cache.put(key, hash, findings);
  return { kind: "findings", findings, content };
}

export interface ScanProgress {
  index: number;
  total: number;
  file: string;
  flagged: number;
  findings: number;
}

export interface CleanFile {
  file: string;
  content: string;
}

export interface ScanResult {
  results: FileResult[];
  failures: ScanFailure[];
  skipped: string[];
  clean: CleanFile[];
}

// Sequential file scan with one lint call at a time.
export async function scanFiles(handle: LinterHandle, cache: FindingCache, files: string[], accepted: AcceptList, mode: LintMode, settings: Settings, onProgress?: (progress: ScanProgress) => void): Promise<ScanResult> {
  const scan: ScanResult = { results: [], failures: [], skipped: [], clean: [] };
  let findings = 0;
  try {
    for (let index = 0; index < files.length; index++) {
      onProgress?.({ index, total: files.length, file: files[index], flagged: scan.results.length, findings });
      const outcome = await lintFile(handle, cache, files[index], mode, settings);
      switch (outcome.kind) {
        case "findings": {
          const open = outcome.findings.filter((finding) => !accepts(accepted, finding.ruleId, finding.text));
          if (open.length > 0) {
            scan.results.push({ file: files[index], findings: open });
            findings += open.length;
          } else {
            scan.clean.push({ file: files[index], content: outcome.content });
          }
          break;
        }
        case "failed":
          scan.failures.push({ file: files[index], error: outcome.error });
          break;
        case "skipped":
          scan.skipped.push(files[index]);
          break;
      }
      await new Promise((done) => setImmediate(done));
    }
  } finally {
    cache.save();
  }
  return scan;
}

interface IgnoreRule {
  pattern: RegExp;
  directoryOnly: boolean;
}

function globToRegExp(glob: string): string {
  return glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\0").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\0/g, "(?:.*/)?");
}

export function parseIgnore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) continue;
    const directoryOnly = line.endsWith("/");
    if (directoryOnly) line = line.slice(0, -1);
    const anchored = line.includes("/");
    line = line.replace(/^\//, "");
    rules.push({ pattern: new RegExp(`^${anchored ? "" : "(?:.*/)?"}${globToRegExp(line)}$`), directoryOnly });
  }
  return rules;
}

export function ignored(rules: IgnoreRule[], rel: string, isDirectory: boolean): boolean {
  return rules.some((rule) => (isDirectory || !rule.directoryOnly) && rule.pattern.test(rel));
}

function walkFiles(root: string, wanted: Set<string>): string[] {
  let rules: IgnoreRule[] = [];
  try {
    rules = parseIgnore(readFileSync(join(root, ".gitignore"), "utf8"));
  } catch {}
  const found: string[] = [];
  const pending: string[] = [root];
  while (pending.length > 0 && found.length < MAX_DISCOVERED) {
    const directory = pending.pop() as string;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      const isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink() || (!isDirectory && !entry.isFile())) continue;
      if (isDirectory && SKIPPED_DIRECTORIES.has(entry.name)) continue;
      if (ignored(rules, relative(root, full), isDirectory)) continue;
      if (isDirectory) pending.push(full);
      else if (wanted.has(extname(entry.name).toLowerCase())) found.push(full);
    }
  }
  return found.sort();
}

function isSymlink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return true;
  }
}

function gitFiles(cwd: string): Promise<string[] | null> {
  return new Promise((done) => {
    execFile("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd, timeout: DISCOVERY_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      done(error ? null : stdout.split("\0").filter((file) => file.length > 0));
    });
  });
}

// Repo files without ignored paths from the config and without paths outside the repo root.
export function withoutIgnored(files: string[], root: string, settings: Settings): string[] {
  return files.filter((file) => {
    const rel = relative(root, file).split(sep).join("/");
    return !rel.startsWith("..") && !settings.ignore(rel) && !rel.split("/").some((segment) => SKIPPED_DIRECTORIES.has(segment));
  });
}

export async function listFiles(phase: Exclude<Phase, "own">, cwd: string): Promise<string[]> {
  const wanted = phase === "md" ? MARKDOWN_EXTENSIONS : phase === "cc" ? COMMENT_EXTENSIONS : CODE_EXTENSIONS;
  const listed = await gitFiles(cwd);
  if (listed === null) return walkFiles(cwd, wanted);
  return listed
    .filter((file) => wanted.has(extname(file).toLowerCase()) && !file.split("/").some((segment) => SKIPPED_DIRECTORIES.has(segment)))
    .slice(0, MAX_DISCOVERED)
    .map((file) => resolve(cwd, file))
    .filter((file) => !isSymlink(file));
}
