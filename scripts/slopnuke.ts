#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { drive, type Host } from "../core/drive.ts";
import { advance, MAX_ROUNDS, start, type Phase, type Step } from "../core/run.ts";
import { FindingCache, listFiles, loadLinter, modeFor, ScanError, scanFiles, withoutIgnored, type LinterHandle } from "../core/scan.ts";
import {
  anyRuns,
  contentHash,
  deleteRun,
  editedPaths,
  loadRun,
  markClean,
  newRunId,
  pendingEdits,
  projectRoot,
  recordEdits,
  RUN_STALE_MS,
  runFile,
  saveRun,
  stateHome,
  withLock,
  type RunRecord,
} from "../core/store.ts";
import { acceptRequest, loadAccept, parseAcceptArgs, saveShown } from "../core/accept.ts";
import { loadSettings } from "../core/config.ts";
import { serveMcp } from "./mcp.ts";
import { describe, rewritePrompt, roundSummary, scanLine, shownEntries, skippedLine } from "../core/text.ts";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(PLUGIN_ROOT, "scripts", "slopnuke.ts");
const MAX_BLOCKS = 2;
const INSTALL_TIMEOUT_MS = 600_000;
const INSTALL_LOCK = { waitMs: 660_000, staleMs: 900_000 };
const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;
const SCOPES: Record<string, Phase[]> = { repo: ["cc", "md"], edited: ["own"], cc: ["cc"], md: ["md"], code: ["code"], tests: ["tests"], all: ["cc", "md", "code", "tests"] };
const USAGE = "usage: slopnuke.ts start <repo|edited|cc|md|code|tests|all> [--session <id>] | next | accept <id...> | accept <rule> [text] | cancel | mcp | hook <stop|prompt|edit>";
const NEXT_COMMAND = `node "${CLI}" next`;
const CANCEL_COMMAND = `node "${CLI}" cancel`;
const ACCEPT_COMMAND = `node "${CLI}" accept`;
const DONE = "slopnuke: done";
const ERROR = "slopnuke: error";
const NO_RUN = "slopnuke: no active run";

const out = (text: string): void => {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
};

const lockedRun = <T>(root: string, body: () => T): T => withLock(runFile(root), body);

function slopsiftSpec(): string {
  const spec = JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8")).dependencies?.slopsift;
  if (typeof spec !== "string" || spec.length === 0) throw new ScanError("package.json lacks a slopsift dependency");
  return spec;
}

// Runtime install into a temp directory with a rename into place under a long lock.
function install(runtime: string, spec: string): void {
  withLock(
    runtime,
    () => {
      const temp = `${runtime}.${process.pid}.tmp`;
      rmSync(temp, { recursive: true, force: true });
      mkdirSync(temp, { recursive: true, mode: 0o700 });
      writeFileSync(join(temp, "package.json"), '{ "private": true }\n');
      process.stderr.write(`slopnuke: installing slopsift@${spec} into ${runtime}, first run only\n`);
      const args = ["install", "--prefix", temp, "--no-audit", "--no-fund", "--omit=dev", `slopsift@${spec}`];
      const windows = process.platform === "win32";
      try {
        execFileSync("npm", windows ? args.map((arg) => `"${arg}"`) : args, { stdio: ["ignore", "ignore", "inherit"], timeout: INSTALL_TIMEOUT_MS, shell: windows });
      } catch (error) {
        rmSync(temp, { recursive: true, force: true });
        throw new ScanError(`npm install of slopsift failed: ${(error as Error).message}`);
      }
      rmSync(runtime, { recursive: true, force: true });
      renameSync(temp, runtime);
    },
    INSTALL_LOCK,
  );
}

async function openLinter(): Promise<LinterHandle> {
  const local = await loadLinter([PLUGIN_ROOT]);
  if (local) return local;
  const spec = slopsiftSpec();
  const runtime = join(stateHome(), "runtime", spec.replace(/[^0-9A-Za-z.]/g, "_"));
  try {
    const found = await loadLinter([runtime]);
    if (found) return found;
  } catch (error) {
    if (!(error instanceof ScanError)) throw error;
    process.stderr.write(`slopnuke: ${error.message}, reinstalling\n`);
  }
  install(runtime, spec);
  const installed = await loadLinter([runtime]);
  if (!installed) throw new ScanError(`slopsift is missing from ${runtime} after npm install`);
  return installed;
}

function cliHost(root: string, cwd: string, failed: { value: boolean }): Host {
  const cache = new FindingCache(join(stateHome(), "cache.json"));
  let handle: Promise<LinterHandle> | undefined;
  return {
    list: async (phase) => withoutIgnored(phase === "own" ? pendingEdits(root) : await listFiles(phase, cwd), root, loadSettings(root)),
    scan: async (phase, files, round) => {
      out(scanLine({ kind: "scan", phase, files, round }));
      const scan = await scanFiles(await (handle ??= openLinter()), cache, files, loadAccept(root), modeFor(phase), loadSettings(root));
      if (scan.skipped.length > 0) out(skippedLine(phase, scan.skipped.length));
      if (phase === "own") {
        const skipped = scan.skipped.flatMap((file) => {
          const content = contentHash(file);
          return content === null ? [] : [{ file, content }];
        });
        markClean(root, [...scan.clean, ...skipped]);
      }
      return scan;
    },
    note: (note) => {
      if (note.kind === "failed") failed.value = true;
      out(describe(note, cwd));
    },
  };
}

type Base = Pick<RunRecord, "id" | "root" | "cwd">;

async function proceed(step: Step, base: Base): Promise<void> {
  const failed = { value: false };
  const next = await drive(step, cliHost(base.root, base.cwd, failed));
  const action = next.action;
  const kept = lockedRun(base.root, () => {
    const current = loadRun(base.root);
    if (!current || current.id !== base.id) return false;
    if (next.run === null || action.kind !== "rewrite") deleteRun(base.root);
    else saveRun({ ...current, blocks: 0, updated: Date.now(), run: next.run });
    return true;
  });
  if (!kept) {
    out(`${NO_RUN}: the run was cancelled during the scan. Stop here.`);
    return;
  }
  if (next.run === null || action.kind !== "rewrite") {
    out(failed.value ? `${ERROR}. Stop here.` : DONE);
    return;
  }
  out(roundSummary(action, base.cwd));
  out("");
  saveShown(base.root, shownEntries(action, base.cwd));
  out(rewritePrompt(action, base.cwd, { accept: ACCEPT_COMMAND, stalled: next.run.stalls > 0 }));
  out(`\nAfter the rewrite, run: ${NEXT_COMMAND}\nRepeat until it prints "${DONE}".`);
}

function parseSession(value: string | undefined): string | null {
  return value && value.length > 0 && !value.startsWith("${") ? value : null;
}

const isStale = (record: RunRecord): boolean => Date.now() - record.updated > RUN_STALE_MS;

async function commandStart(args: string[]): Promise<number> {
  const [scope, flag, id] = args;
  const phases = scope ? SCOPES[scope] : undefined;
  if (!phases || (flag !== undefined && flag !== "--session") || args.length > 3) {
    out(USAGE);
    return 2;
  }
  const cwd = process.cwd();
  const root = projectRoot(cwd);
  const session = parseSession(id);
  const step = start(phases);
  const base: Base = { id: newRunId(), root, cwd };
  const claimed = lockedRun(root, () => {
    const current = loadRun(root);
    if (current && !isStale(current) && (session === null || current.session !== session)) return false;
    if (step.run) saveRun({ ...base, session, blocks: 0, reason: null, updated: Date.now(), run: step.run });
    return true;
  });
  if (!claimed) {
    out(`slopnuke: a run is already active in ${root}. End it with: ${CANCEL_COMMAND}`);
    out(`${ERROR}. Stop here.`);
    return 1;
  }
  await proceed(step, base);
  return 0;
}

async function commandNext(): Promise<number> {
  const root = projectRoot(process.cwd());
  const record = loadRun(root);
  if (!record) {
    out(`${NO_RUN} in ${root}. The run finished or was cancelled. Stop here.`);
    return 0;
  }
  await proceed(advance(record.run, { kind: "rewritten" }), record);
  return 0;
}

function commandCancel(): number {
  const root = projectRoot(process.cwd());
  const active = lockedRun(root, () => {
    const found = loadRun(root) !== null;
    deleteRun(root);
    return found;
  });
  out(active ? "slopnuke: run cancelled" : `${NO_RUN} in ${root}`);
  return 0;
}

function commandAccept(args: string[]): number {
  const request = parseAcceptArgs(args);
  if (request.kind === "invalid") {
    out(USAGE);
    return 2;
  }
  const root = projectRoot(process.cwd());
  const outcome = acceptRequest(root, request);
  for (const line of outcome.added) out(`slopnuke: accepted ${line}`);
  for (const id of outcome.unknown) out(`slopnuke: no finding with id ${id} in the last round`);
  if (outcome.added.length === 0 && outcome.unknown.length === 0) out("slopnuke: already on the accept list");
  if (loadRun(root)) out(`Run: ${NEXT_COMMAND}`);
  return outcome.unknown.length > 0 ? 1 : 0;
}

interface HookInput {
  session: string | null;
  cwd: string;
  prompt: string | null;
  transcript: string | null;
  tool: unknown;
  toolInput: unknown;
}

function parseHookInput(text: string): HookInput | null {
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || typeof value.cwd !== "string" || value.cwd.length === 0) return null;
  return {
    session: typeof value.session_id === "string" && value.session_id.length > 0 ? value.session_id : null,
    cwd: value.cwd,
    prompt: typeof value.prompt === "string" ? value.prompt : null,
    transcript: typeof value.transcript_path === "string" && value.transcript_path.length > 0 ? value.transcript_path : null,
    tool: value.tool_name,
    toolInput: value.tool_input,
  };
}

// Test for a slopnuke start command in the tail of a transcript.
function transcriptStarted(path: string | null): boolean | null {
  if (path === null) return null;
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    return /slopnuke\.ts\\?"? start /.test(text);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function hookRecord(root: string, input: HookInput): RunRecord | null {
  const record = loadRun(root);
  if (!record) return null;
  if (isStale(record)) {
    deleteRun(root);
    return null;
  }
  return record.session === null || record.session === input.session ? record : null;
}

function hookStop(input: HookInput): object {
  if (!anyRuns()) return {};
  const root = projectRoot(input.cwd);
  return lockedRun(root, () => {
    const record = hookRecord(root, input);
    if (!record) return {};
    if (record.session === null && transcriptStarted(input.transcript) === false) return {};
    if (record.blocks >= MAX_BLOCKS) {
      deleteRun(root);
      return { systemMessage: `slopnuke: run cancelled, the agent ended ${MAX_BLOCKS} turns without running next` };
    }
    const reason = `slopnuke round ${record.run.round}/${MAX_ROUNDS} is not finished. Run: ${NEXT_COMMAND}\nRewrite what it reports and repeat until it prints "${DONE}". When the user approved findings with no change, put them on the accept list first: ${ACCEPT_COMMAND} <id>. When the user moved on to other work, run: ${CANCEL_COMMAND}`;
    saveRun({ ...record, session: input.session, blocks: record.blocks + 1, reason, updated: Date.now() });
    return { decision: "block", reason };
  });
}

function hookPrompt(input: HookInput): object | null {
  if (!anyRuns()) return null;
  const root = projectRoot(input.cwd);
  return lockedRun(root, () => {
    const record = hookRecord(root, input);
    if (!record || record.session === null) return null;
    if (record.reason !== null && input.prompt?.includes(record.reason.trim())) return null;
    const additionalContext = `A slopnuke run is open in ${root} at round ${record.run.round}/${MAX_ROUNDS}. When the user approves findings with no change, record each one: ${ACCEPT_COMMAND} <id>. Then run: ${NEXT_COMMAND}. When the user wants the sweep stopped or moved on to other work, run: ${CANCEL_COMMAND}`;
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } };
  });
}

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

function hookEdit(input: HookInput): null {
  const root = projectRoot(input.cwd);
  const paths = editedPaths(input.tool, input.toolInput, input.cwd)
    .map(real)
    .filter((path) => path.startsWith(root + sep));
  if (paths.length === 0) return null;
  recordEdits(root, paths);
  if (input.session === null || !anyRuns()) return null;
  lockedRun(root, () => {
    const record = loadRun(root);
    const stage = record?.run.stage;
    if (record && record.session === null && stage?.kind === "rewriting" && paths.some((path) => stage.files.includes(path))) {
      saveRun({ ...record, session: input.session });
    }
  });
  return null;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// Fail-open hook entry with JSON-only stdout.
async function commandHook(event: string | undefined): Promise<number> {
  let result: object | null = event === "stop" ? {} : null;
  try {
    const input = parseHookInput(await readStdin());
    if (input) {
      if (event === "stop") result = hookStop(input);
      else if (event === "prompt") result = hookPrompt(input);
      else if (event === "edit") result = hookEdit(input);
    }
  } catch (error) {
    result = { systemMessage: `slopnuke hook ${event} failed open: ${String((error as Error)?.message ?? error).slice(0, 300)}` };
  }
  if (result !== null) out(JSON.stringify(result));
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, argument] = argv;
  try {
    switch (command) {
      case "start":
        return await commandStart(argv.slice(1));
      case "next":
        return await commandNext();
      case "cancel":
        return commandCancel();
      case "accept":
        return commandAccept(argv.slice(1));
      case "mcp":
        await serveMcp(process.stdin, process.stdout, JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8")).version, ACCEPT_COMMAND);
        return 0;
      case "hook":
        return await commandHook(argument);
      default:
        out(USAGE);
        return 2;
    }
  } catch (error) {
    if (!(error instanceof ScanError)) throw error;
    out(`slopnuke: ${error.message}`);
    out(`${ERROR}. Stop here.`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
