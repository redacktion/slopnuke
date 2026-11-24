import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drive, type Host } from "../core/drive.ts";
import { advance, start, type Phase, type Run, type Step } from "../core/run.ts";
import { FindingCache, listFiles, loadLinter, modeFor, ScanError, scanFiles, withoutIgnored, type LinterHandle } from "../core/scan.ts";
import { acceptRequest, loadAccept, parseAcceptArgs, saveShown } from "../core/accept.ts";
import { loadSettings } from "../core/config.ts";
import { runReview, type ReviewForm } from "../core/review.ts";
import { projectRoot } from "../core/store.ts";
import { Type } from "typebox";
import { describe, displayPath, MAX_FINDINGS_PER_PROMPT, rewritePrompt, roundSummary, scanLine, shownEntries, skippedLine } from "../core/text.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ACCEPT_COMMAND = `node "${join(PACKAGE_ROOT, "scripts", "slopnuke.ts")}" accept`;
const LINK_ENTRY = "slopnuke-link";
const CLEAN_ENTRY = "slopnuke-clean";
const GENESIS = "0".repeat(64);
const KEY_FILE = join(homedir(), ".pi", "agent", "slopnuke.key");
const CACHE_FILE = join(homedir(), ".pi", "agent", "slopnuke-cache.json");
const PAINT_INTERVAL_MS = 80;
const PROGRESS_WIDTH = 20;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const WRITE_TOOL = /(^|__)(write|edit)$/;

interface Link {
  id: string;
  enc: string;
  hash: string;
  prev: string;
  link: string;
}

interface CleanMark {
  id: string;
  hash: string;
}

function loadKey(): Buffer {
  try {
    const key = readFileSync(KEY_FILE);
    if (key.length === KEY_BYTES) return key;
  } catch {}
  const key = randomBytes(KEY_BYTES);
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  writeFileSync(KEY_FILE, key, { mode: 0o600 });
  chmodSync(KEY_FILE, 0o600);
  return key;
}

const mac = (key: Buffer, data: string | Buffer): string => createHmac("sha256", key).update(data).digest("hex");

function fileMac(key: Buffer, file: string): string | null {
  try {
    return mac(key, readFileSync(file));
  } catch {
    return null;
  }
}

function seal(key: Buffer, text: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function unseal(key: Buffer, sealed: string): string | null {
  try {
    const raw = Buffer.from(sealed, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

class Ledger {
  private keyCache?: Buffer;
  private head = GENESIS;
  private current = new Map<string, string>();
  private clean = new Map<string, string>();
  private paths = new Map<string, string>();

  private get key(): Buffer {
    return (this.keyCache ??= loadKey());
  }

  private chain(prev: string, id: string, hash: string): string {
    return mac(this.key, `${prev}\0${id}\0${hash}`);
  }

  load(links: Link[], marks: CleanMark[]): void {
    this.head = GENESIS;
    this.current.clear();
    this.clean.clear();
    this.paths.clear();
    for (const link of links) {
      if (link.prev !== this.head || link.link !== this.chain(link.prev, link.id, link.hash)) break;
      const path = unseal(this.key, link.enc);
      if (path === null || mac(this.key, path) !== link.id) break;
      this.head = link.link;
      this.current.set(link.id, link.hash);
      this.paths.set(link.id, path);
    }
    for (const mark of marks) {
      if (this.current.has(mark.id)) this.clean.set(mark.id, mark.hash);
    }
  }

  record(path: string): Link | null {
    const hash = fileMac(this.key, path);
    const id = mac(this.key, path);
    if (!hash || this.current.get(id) === hash) return null;
    const link: Link = { id, enc: seal(this.key, path), hash, prev: this.head, link: this.chain(this.head, id, hash) };
    this.head = link.link;
    this.current.set(id, hash);
    this.paths.set(id, path);
    return link;
  }

  pending(): string[] {
    const files: string[] = [];
    for (const [id, path] of this.paths) {
      const hash = fileMac(this.key, path);
      if (hash !== null && hash !== this.clean.get(id)) files.push(path);
    }
    return files;
  }

  markClean(path: string, scanned: string | null): CleanMark | null {
    let content: Buffer;
    try {
      content = readFileSync(path);
    } catch {
      return null;
    }
    if (scanned !== null && createHash("sha256").update(content).digest("hex") !== scanned) return null;
    const hash = mac(this.key, content);
    const id = mac(this.key, path);
    this.clean.set(id, hash);
    return { id, hash };
  }
}

function restrictSessionFiles(ctx: any): void {
  try {
    const file = ctx.sessionManager.getSessionFile?.();
    if (!file) return;
    chmodSync(dirname(dirname(file)), 0o700);
    chmodSync(dirname(file), 0o700);
    chmodSync(file, 0o600);
  } catch {}
}

function writtenPaths(toolName: string, input: Record<string, unknown>): string[] {
  return WRITE_TOOL.test(toolName) && typeof input.path === "string" ? [input.path] : [];
}

function progressBar(done: number, total: number): string {
  const filled = Math.round((done / total) * PROGRESS_WIDTH);
  return "[" + "#".repeat(filled) + "-".repeat(PROGRESS_WIDTH - filled) + "]";
}

export default function slopnuke(pi: ExtensionAPI): void {
  const ledger = new Ledger();
  const cache = new FindingCache(CACHE_FILE);
  let linter: Promise<LinterHandle> | undefined;
  let run: Run | null = null;
  let busy = false;

  const getLinter = (): Promise<LinterHandle> => {
    linter ??= loadLinter([PACKAGE_ROOT])
      .then((handle) => handle ?? Promise.reject(new ScanError(`slopsift is missing, run npm install in ${PACKAGE_ROOT}`)))
      .catch((error) => {
        linter = undefined;
        throw error;
      });
    return linter;
  };

  function say(text: string): void {
    pi.sendMessage({ customType: "slopnuke", content: text, display: true });
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    run = null;
    restrictSessionFiles(ctx);
    const entries = ctx.sessionManager.getEntries() as any[];
    const custom = (type: string) => entries.filter((entry) => entry.type === "custom" && entry.customType === type && entry.data).map((entry) => entry.data);
    ledger.load(custom(LINK_ENTRY), custom(CLEAN_ENTRY));
  });

  pi.on("tool_result", async (event: any, ctx: any) => {
    if (event.isError) return;
    for (const raw of writtenPaths(event.toolName, event.input ?? {})) {
      const link = ledger.record(resolve(ctx.cwd, raw));
      if (link) pi.appendEntry(LINK_ENTRY, link);
    }
  });

  function host(ctx: any): Host {
    return {
      list: async (phase) => {
        const root = projectRoot(ctx.cwd);
        return withoutIgnored(phase === "own" ? ledger.pending() : await listFiles(phase, ctx.cwd), root, loadSettings(root));
      },
      scan: async (phase, files, round) => {
        say(scanLine({ kind: "scan", phase, files, round }));
        const handle = await getLinter();
        let painted = 0;
        try {
          const root = projectRoot(ctx.cwd);
          const scan = await scanFiles(handle, cache, files, loadAccept(root), modeFor(phase), loadSettings(root), (progress) => {
            const now = Date.now();
            if (now - painted < PAINT_INTERVAL_MS && progress.index !== progress.total - 1) return;
            painted = now;
            const label = `slopnuke ${phase} ${progressBar(progress.index, progress.total)} ${progress.index}/${progress.total} files, ${progress.flagged} flagged, ${progress.findings} findings`;
            ctx.ui.setStatus("slopnuke", label);
            ctx.ui.setWidget("slopnuke", [label, `  ${displayPath(progress.file, ctx.cwd)}`]);
            ctx.ui.setWorkingMessage(label);
          });
          if (scan.skipped.length > 0) say(skippedLine(phase, scan.skipped.length));
          if (phase === "own") {
            const marks = [...scan.clean.map((entry) => ledger.markClean(entry.file, entry.content)), ...scan.skipped.map((file) => ledger.markClean(file, null))];
            for (const mark of marks) if (mark) pi.appendEntry(CLEAN_ENTRY, mark);
          }
          return scan;
        } finally {
          ctx.ui.setStatus("slopnuke", undefined);
          ctx.ui.setWidget("slopnuke", undefined);
          ctx.ui.setWorkingMessage();
        }
      },
      note: (note) => say(note.kind === "empty" && note.phase === "own" ? `${describe(note, ctx.cwd)}. Try /slopnuke.` : describe(note, ctx.cwd)),
    };
  }

  async function proceed(step: Step, ctx: any): Promise<void> {
    busy = true;
    run = step.run;
    try {
      const next = await drive(step, host(ctx));
      run = next.run;
      if (next.action.kind !== "rewrite") return;
      say(`${roundSummary(next.action, ctx.cwd)}\nsending ${Math.min(next.action.total, MAX_FINDINGS_PER_PROMPT)} to the agent for rewrite`);
      saveShown(projectRoot(ctx.cwd), shownEntries(next.action, ctx.cwd));
      pi.sendMessage({ customType: "slopnuke-task", content: rewritePrompt(next.action, ctx.cwd, { accept: ACCEPT_COMMAND, stalled: (next.run?.stalls ?? 0) > 0 }), display: false }, { triggerTurn: true, deliverAs: "followUp" });
    } finally {
      busy = false;
    }
  }

  pi.on("agent_end", async (event: any, ctx: any) => {
    restrictSessionFiles(ctx);
    if (!run || busy) return;
    const last = [...(event.messages ?? [])].reverse().find((message: any) => message.role === "assistant");
    await proceed(advance(run, last?.stopReason === "aborted" ? { kind: "aborted" } : { kind: "rewritten" }), ctx);
  });

  function register(name: string, description: string, phases: Phase[]): void {
    pi.registerCommand(name, {
      description,
      handler: async (_args: string, ctx: any) => {
        if (run || busy) {
          say("slopnuke: a run is already active");
          return;
        }
        await proceed(start(phases), ctx);
      },
    });
  }

  // Sequential select dialogs that Pi shows in place of one MCP elicitation form.
  function askWithDialogs(ctx: any, signal?: AbortSignal): ((form: ReviewForm) => Promise<unknown>) | null {
    if (!ctx.hasUI) return null;
    return async (form) => {
      const content: Record<string, string> = {};
      for (const [id, field] of Object.entries(form.requestedSchema.properties)) {
        if (signal?.aborted) return { action: "cancel" };
        const choice = await ctx.ui.select(`${field.title}\n${field.description}`, [...field.enum], { signal });
        if (choice === undefined) return { action: "cancel" };
        content[id] = choice;
      }
      return { action: "accept", content };
    };
  }

  pi.registerTool({
    name: "slopnuke_review",
    label: "slopnuke review",
    description:
      "Ask the user to decide each slopnuke finding from the last round: rewrite it, accept the flagged text, or accept the whole rule for the repo. Call it for findings that are correct as written, then rewrite the rest.",
    parameters: Type.Object({
      ids: Type.Optional(Type.Array(Type.String(), { description: "Finding ids from the last round, without brackets. All findings of the last round when absent, up to 10." })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId: string, params: { ids?: string[] }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
      const result = await runReview(ctx.cwd, params.ids, { ask: askWithDialogs(ctx, signal), defaults: true, acceptCommand: ACCEPT_COMMAND });
      return { content: [{ type: "text" as const, text: result.text }], details: undefined, isError: result.error };
    },
  } as any);

  pi.registerCommand("slopnuke-review", {
    description: "Decide each slopnuke finding from the last round: /slopnuke-review [id...]",
    handler: async (args: string, ctx: any) => {
      const ids = args.trim().split(/\s+/).filter(Boolean);
      const result = await runReview(ctx.cwd, ids.length > 0 ? ids : undefined, { ask: askWithDialogs(ctx), defaults: true, acceptCommand: ACCEPT_COMMAND });
      say(result.text);
    },
  });

  pi.registerCommand("slopnuke-accept", {
    description: "Put findings on the repo accept list: /slopnuke-accept <id...> or /slopnuke-accept <rule> [text]",
    handler: async (args: string, ctx: any) => {
      const request = parseAcceptArgs(args.trim().split(/\s+/).filter(Boolean));
      if (request.kind === "invalid") {
        say("slopnuke: usage: /slopnuke-accept <id...> or /slopnuke-accept <rule> [text]");
        return;
      }
      const outcome = acceptRequest(projectRoot(ctx.cwd), request);
      const lines = [...outcome.added.map((line) => `slopnuke: accepted ${line}`), ...outcome.unknown.map((id) => `slopnuke: no finding with id ${id} in the last round`)];
      say(lines.length > 0 ? lines.join("\n") : "slopnuke: already on the accept list");
    },
  });

  register("slopnuke", "Rewrite slop in every code comment and markdown file under the working directory", ["cc", "md"]);
  register("slopnuke-edited", "Rewrite slop in files edited this session", ["own"]);
  register("slopnuke-cc", "Rewrite slop in every code comment under the working directory", ["cc"]);
  register("slopnuke-md", "Rewrite slop in every markdown file under the working directory", ["md"]);
  register("slopnuke-code", "Rewrite slop in error and log messages, UI strings and identifiers under the working directory", ["code"]);
  register("slopnuke-tests", "Rewrite slop in test names under the working directory", ["tests"]);
  register("slopnuke-all", "Code comments, markdown, code strings and names, then test names under the working directory", ["cc", "md", "code", "tests"]);
}
