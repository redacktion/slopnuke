import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseRun, type Run } from "./run.ts";

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 15_000;
const LOCK_POLL_MS = 10;
const LOCK_OWNER = "owner";
const RUN_VERSION = 1;
const EDITED_VERSION = 1;
export const RUN_STALE_MS = 24 * 60 * 60 * 1000;

export function stateHome(): string {
  const configured = process.env.SLOPNUKE_HOME;
  return configured && isAbsolute(configured) ? configured : join(homedir(), ".slopnuke");
}

export function writePrivate(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, data, { mode: 0o600 });
  renameSync(temp, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function stale(lock: string, staleMs: number): boolean {
  try {
    const pid = Number(readFileSync(join(lock, LOCK_OWNER), "utf8"));
    if (Number.isInteger(pid) && pid > 0) return !alive(pid);
  } catch {}
  try {
    return Date.now() - statSync(lock).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

export interface LockTiming {
  waitMs: number;
  staleMs: number;
}

// Directory lock that slopnuke takes with its process id around a read-modify-write of one state file.
export function withLock<T>(file: string, body: () => T, timing: LockTiming = { waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS }): T {
  const lock = `${file}.lock`;
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timing.waitMs;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, LOCK_OWNER), String(process.pid), { mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() > deadline) throw new Error(`slopnuke: lock timeout on ${lock}`);
      if (stale(lock, timing.staleMs)) {
        const moved = `${lock}.${process.pid}.${randomBytes(6).toString("hex")}.stale`;
        try {
          renameSync(lock, moved);
          rmSync(moved, { recursive: true, force: true });
        } catch {}
        continue;
      }
      Atomics.wait(sleeper, 0, 0, LOCK_POLL_MS);
    }
  }
  try {
    return body();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function projectRoot(cwd: string): string {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (top) return realpathSync(top);
  } catch {}
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

const rootKey = (root: string): string => createHash("sha256").update(root).digest("hex").slice(0, 32);

export const runsDir = (): string => join(stateHome(), "runs");
export const runFile = (root: string): string => join(runsDir(), `${rootKey(root)}.json`);
export const editedFile = (root: string): string => join(stateHome(), "edited", `${rootKey(root)}.json`);
export const shownFile = (root: string): string => join(stateHome(), "shown", `${rootKey(root)}.json`);
export const acceptLock = (root: string): string => join(stateHome(), "accept", rootKey(root));

export function anyRuns(): boolean {
  try {
    return readdirSync(runsDir()).some((name) => name.endsWith(".json"));
  } catch {
    return false;
  }
}

export interface RunRecord {
  id: string;
  root: string;
  cwd: string;
  session: string | null;
  blocks: number;
  reason: string | null;
  updated: number;
  run: Run;
}

export function parseRunRecord(value: any): RunRecord | null {
  if (value === null || typeof value !== "object" || value.version !== RUN_VERSION) return null;
  const { id, root, cwd, session, blocks, reason, updated } = value;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof root !== "string" || typeof cwd !== "string" || !isAbsolute(root) || !isAbsolute(cwd)) return null;
  if (session !== null && typeof session !== "string") return null;
  if (reason !== null && typeof reason !== "string") return null;
  if (!Number.isInteger(blocks) || blocks < 0 || !Number.isFinite(updated)) return null;
  const run = parseRun(value.run);
  return run ? { id, root, cwd, session, blocks, reason, updated, run } : null;
}

export function loadRun(root: string): RunRecord | null {
  const record = parseRunRecord(readJson(runFile(root)));
  return record && record.root === root ? record : null;
}

export function saveRun(record: RunRecord): void {
  writePrivate(runFile(record.root), JSON.stringify({ version: RUN_VERSION, ...record }));
}

export function deleteRun(root: string): void {
  rmSync(runFile(root), { force: true });
}

export const newRunId = (): string => randomBytes(12).toString("hex");

export const contentHash = (file: string): string | null => {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
};

type Edited = Record<string, string | null>;

function loadEdited(root: string): Edited {
  const value: any = readJson(editedFile(root));
  const files: Edited = {};
  if (value?.version !== EDITED_VERSION || value.root !== root || !value.files || typeof value.files !== "object") return files;
  for (const [file, clean] of Object.entries<any>(value.files)) {
    if (isAbsolute(file) && (clean === null || typeof clean === "string")) files[file] = clean;
  }
  return files;
}

function updateEdited(root: string, change: (files: Edited) => Edited): void {
  const file = editedFile(root);
  withLock(file, () => writePrivate(file, JSON.stringify({ version: EDITED_VERSION, root, files: change(loadEdited(root)) })));
}

export function recordEdits(root: string, paths: string[]): void {
  if (paths.length === 0) return;
  updateEdited(root, (files) => {
    const next = { ...files };
    for (const path of paths) next[path] = next[path] ?? null;
    return next;
  });
}

export function pendingEdits(root: string): string[] {
  const pending: string[] = [];
  for (const [file, clean] of Object.entries(loadEdited(root))) {
    const hash = contentHash(file);
    if (hash !== null && hash !== clean) pending.push(file);
  }
  return pending.sort();
}

export function markClean(root: string, scanned: { file: string; content: string }[]): void {
  if (scanned.length === 0) return;
  const marked = new Map(scanned.map((entry) => [entry.file, entry.content]));
  updateEdited(root, (files) => {
    const next: Edited = {};
    for (const [file, clean] of Object.entries(files)) {
      if (contentHash(file) !== null) next[file] = marked.get(file) ?? clean;
    }
    return next;
  });
}

const PATCH_HEADER = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm;
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export function editedPaths(toolName: unknown, input: any, cwd: string): string[] {
  if (typeof toolName !== "string" || input === null || typeof input !== "object") return [];
  if (EDIT_TOOLS.has(toolName)) {
    const path = input.file_path ?? input.notebook_path;
    return typeof path === "string" && path.length > 0 ? [resolve(cwd, path)] : [];
  }
  if (toolName === "apply_patch" && typeof input.command === "string") {
    return [...new Set([...input.command.matchAll(PATCH_HEADER)].map((match) => resolve(cwd, match[1].trim())))];
  }
  return [];
}
