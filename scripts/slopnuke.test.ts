import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { GOLDEN_COMMENT, SPOKEN_TEST } from "../core/contract.ts";
import { markClean, pendingEdits, recordEdits } from "../core/store.ts";

const CLI = fileURLToPath(new URL("./slopnuke.ts", import.meta.url));
const SLOP = "This guide meticulously delves into the myriad of options to seamlessly leverage them.\n";
const PLAIN = "The guide lists each option once.\n";
const base = realpathSync(tmpdir());
const created: string[] = [];
let counter = 0;

after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  repo: string;
  home: string;
  cli(args: string[], stdin?: object | string): string;
  runs(): string[];
}

function fixture(): Fixture {
  const dir = join(base, `slopnuke-test-${process.pid}-${++counter}`);
  rmSync(dir, { recursive: true, force: true });
  created.push(dir);
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "notes.md"), `# Notes\n\n${SLOP}`);
  writeFileSync(join(repo, "plain.md"), `# Plain\n\n${PLAIN}`);
  return {
    repo,
    home,
    cli(args, stdin) {
      const input = stdin === undefined ? "" : typeof stdin === "string" ? stdin : JSON.stringify(stdin);
      const result = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, input, encoding: "utf8", env: { ...process.env, SLOPNUKE_HOME: home } });
      assert.equal(result.status, 0, `${args.join(" ")} exited ${result.status}: ${result.stderr}`);
      return result.stdout;
    },
    runs() {
      const dir = join(home, "runs");
      return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
    },
  };
}

const hook = (fx: Fixture, event: string, fields: object): any => {
  const output = fx.cli(["hook", event], { cwd: fx.repo, ...fields }).trim();
  return output === "" ? null : JSON.parse(output);
};

test("cli: md sweep, rewrite, next -> findings, then clean and run removed", () => {
  const fx = fixture();
  const first = fx.cli(["start", "md"]);
  assert.match(first, /slopnuke round 1\/40 · markdown files/);
  assert.match(first, /^notes\.md:3:\d+ ai-style\//m);
  assert.doesNotMatch(first, /plain\.md:/);
  assert.equal(fx.runs().length, 1);
  writeFileSync(join(fx.repo, "notes.md"), `# Notes\n\n${PLAIN}`);
  const second = fx.cli(["next"]);
  assert.match(second, /rescan after round 1/);
  assert.match(second, /markdown files: clean\nslopnuke: done/);
  assert.deepEqual(fx.runs(), []);
});

test("cli: repo sweep with an empty edit ledger -> comments phase, then markdown findings", () => {
  const fx = fixture();
  const output = fx.cli(["start", "repo"]);
  assert.match(output, /code comments: no files to scan[\s\S]*slopnuke round 1\/40 · markdown files/);
  assert.match(output, /^notes\.md:3:\d+ ai-style\//m);
});

test("cli: md and cc rewrite prompts -> spoken test in both, comment shape only for comments", () => {
  const md = fixture();
  const prose = md.cli(["start", "md"]);
  const cc = fixture();
  writeFileSync(join(cc.repo, "slop.ts"), `// ${SLOP}export const slop = 1;\n`);
  const comments = cc.cli(["start", "cc"]);
  const shape = (output: string): boolean[] => [output.includes(SPOKEN_TEST), output.includes(GOLDEN_COMMENT), output.includes("write a copula sentence (")];
  assert.deepEqual([shape(prose), shape(comments)], [[true, false, true], [true, true, false]]);
});

test("hook stop: active run -> blocks twice for its session, ignores others, then cancels", () => {
  const fx = fixture();
  fx.cli(["start", "md"]);
  const first = hook(fx, "stop", { session_id: "s1" });
  assert.equal(first.decision, "block");
  assert.match(first.reason, /slopnuke\.ts" next/);
  assert.deepEqual(hook(fx, "stop", { session_id: "s2" }), {});
  assert.equal(hook(fx, "stop", { session_id: "s1" }).decision, "block");
  assert.match(hook(fx, "stop", { session_id: "s1" }).systemMessage, /run cancelled/);
  assert.deepEqual(fx.runs(), []);
});

test("hooks: other sessions on a session-bound run -> same run, next still sweeps", () => {
  const fx = fixture();
  fx.cli(["start", "md", "--session", "s1"]);
  assert.deepEqual(hook(fx, "stop", { session_id: "s2" }), {});
  assert.equal(hook(fx, "prompt", { session_id: "s2", prompt: "unrelated work" }), null);
  assert.match(fx.cli(["next"]), /slopnuke round 2\/40/);
});

test("hooks: edit of a flagged file -> binds the unbound run to the editing session", () => {
  const fx = fixture();
  fx.cli(["start", "md", "--session", ""]);
  assert.equal(hook(fx, "edit", { session_id: "s1", tool_name: "Edit", tool_input: { file_path: join(fx.repo, "notes.md") } }), null);
  assert.deepEqual(hook(fx, "stop", { session_id: "s2" }), {});
  assert.equal(hook(fx, "prompt", { session_id: "s2", prompt: "unrelated work" }), null);
  assert.equal(hook(fx, "stop", { session_id: "s1" }).decision, "block");
});

test("cli: start from another session while a run is open -> exit 1, same open run", () => {
  const fx = fixture();
  fx.cli(["start", "md", "--session", "s1"]);
  const refused = spawnSync(process.execPath, [CLI, "start", "md", "--session", "s2"], { cwd: fx.repo, encoding: "utf8", env: { ...process.env, SLOPNUKE_HOME: fx.home } });
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /a run is already active[\s\S]*slopnuke: error/);
  assert.equal(hook(fx, "stop", { session_id: "s1" }).decision, "block");
});

test("hook stop: unbound run -> a block only for the session with start in the transcript", () => {
  const fx = fixture();
  fx.cli(["start", "md"]);
  const other = join(fx.home, "other.jsonl");
  const mine = join(fx.home, "mine.jsonl");
  writeFileSync(other, '{"type":"user","text":"unrelated"}\n');
  writeFileSync(mine, `{"command":"node \\"${CLI}\\" start md"}\n`);
  assert.deepEqual(hook(fx, "stop", { session_id: "s2", transcript_path: other }), {});
  assert.equal(hook(fx, "stop", { session_id: "s1", transcript_path: mine }).decision, "block");
  assert.deepEqual(hook(fx, "stop", { session_id: "s2", transcript_path: mine }), {});
});

test("markClean: an edit after the scan -> file stays on the pending list", () => {
  const fx = fixture();
  const file = join(fx.repo, "notes.md");
  const scanned = createHash("sha256").update(readFileSync(file)).digest("hex");
  const saved = process.env.SLOPNUKE_HOME;
  process.env.SLOPNUKE_HOME = fx.home;
  try {
    recordEdits(fx.repo, [file]);
    writeFileSync(file, `# Notes\n\n${PLAIN}`);
    markClean(fx.repo, [{ file, content: scanned }]);
    assert.deepEqual(pendingEdits(fx.repo), [file]);
  } finally {
    if (saved === undefined) delete process.env.SLOPNUKE_HOME;
    else process.env.SLOPNUKE_HOME = saved;
  }
});

test("hook edit: paths outside the repo -> no ledger entry", () => {
  const fx = fixture();
  const outside = join(fx.home, "outside.md");
  mkdirSync(fx.home, { recursive: true });
  writeFileSync(outside, `# Out\n\n${SLOP}`);
  hook(fx, "edit", { session_id: "s1", tool_name: "Write", tool_input: { file_path: outside } });
  assert.match(fx.cli(["start", "edited"]), /no edited file changed/);
});

test("cli: next with no run -> one no-run line only", () => {
  const fx = fixture();
  const output = fx.cli(["next"]);
  assert.match(output, /slopnuke: no active run/);
  assert.doesNotMatch(output, /slopnuke: done/);
});

test("hook prompt: continuation prompt -> no output, new prompt -> same run plus accept and cancel reminder", () => {
  const fx = fixture();
  fx.cli(["start", "md", "--session", "s1"]);
  const { reason } = hook(fx, "stop", { session_id: "s1" });
  assert.equal(hook(fx, "prompt", { session_id: "s1", prompt: reason }), null);
  const reminder = hook(fx, "prompt", { session_id: "s1", prompt: "GPU is fine as written" });
  assert.equal(reminder.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(reminder.hookSpecificOutput.additionalContext, /slopnuke\.ts" accept <id>[\s\S]*slopnuke\.ts" cancel/);
  assert.equal(fx.runs().length, 1);
});

test("cli: accept of every open finding by id -> accept file lines, next ends the run", () => {
  const fx = fixture();
  const first = fx.cli(["start", "md", "--session", "s1"]);
  const ids = [...first.matchAll(/^notes\.md:\d+:\d+ \S+ \[([0-9a-f]{10})\]$/gm)].map((match) => match[1]);
  assert.ok(ids.length > 0);
  const accepted = fx.cli(["accept", ...ids]);
  assert.match(accepted, /^slopnuke: accepted /m);
  const lines = readFileSync(join(fx.repo, ".slopnuke-accept"), "utf8").split("\n").filter((line) => line && !line.startsWith("#"));
  assert.equal(lines.length, new Set(ids).size);
  assert.match(fx.cli(["next"]), /markdown files: clean\nslopnuke: done/);
  assert.match(fx.cli(["start", "md"]), /markdown files: clean\nslopnuke: done/);
});

test("cli: accept of an unknown id -> exit 1 and no accept file", () => {
  const fx = fixture();
  fx.cli(["start", "md"]);
  const result = spawnSync(process.execPath, [CLI, "accept", "0000000000"], { cwd: fx.repo, encoding: "utf8", env: { ...process.env, SLOPNUKE_HOME: fx.home } });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /no finding with id 0000000000/);
  assert.equal(existsSync(join(fx.repo, ".slopnuke-accept")), false);
});

test("hook edit: edits from the hook -> slopnuke scans them in the own scope until clean", () => {
  const fx = fixture();
  assert.match(fx.cli(["start", "edited"]), /no edited file changed/);
  assert.equal(hook(fx, "edit", { session_id: "s1", tool_name: "Write", tool_input: { file_path: join(fx.repo, "notes.md") } }), null);
  assert.equal(hook(fx, "edit", { session_id: "s1", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Update File: plain.md\n*** End Patch" } }), null);
  const first = fx.cli(["start", "edited"]);
  assert.match(first, /scanning 2 file\(s\), edited files/);
  assert.match(first, /^notes\.md:3:/m);
  writeFileSync(join(fx.repo, "notes.md"), `# Notes\n\n${PLAIN}`);
  assert.match(fx.cli(["next"]), /edited files: clean/);
  assert.match(fx.cli(["start", "edited"]), /no edited file changed/);
});

test("hook stop: no run or malformed input -> empty JSON object", () => {
  const fx = fixture();
  const outputs = [fx.cli(["hook", "stop"], { cwd: fx.repo, session_id: "s1" }), fx.cli(["hook", "stop"], "not json"), fx.cli(["hook", "prompt"], "{}")];
  assert.deepEqual(outputs, ["{}\n", "{}\n", ""]);
});
