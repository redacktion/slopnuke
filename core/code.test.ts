import assert from "node:assert/strict";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { extractCodeProse, splitWords, type Lang } from "./code.ts";
import { resolveSettings } from "./config.ts";
import { loadLinter, type LintMode } from "./scan.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ACTOR_FIRST = resolveSettings([{ profile: "actor-first", lists: {} }]);

test("extractCodeProse: snippets per language -> prose span kinds and raw text", () => {
  const cases: [Lang, string, [string, string][]][] = [
    ["js", 'test("parser: empty input -> no tokens", () => {});', [["test-name", "parser: empty input -> no tokens"]]],
    ["js", 'describe("parser", () => { it("returns [] on empty", f) });', [["test-group", "parser"], ["test-name", "returns [] on empty"]]],
    ["js", 'throw new Error(`lease ${id} was dropped by the queue`);', [["message", "lease ${id} was dropped by the queue"]]],
    ["js", 'console.log("debug"); logger.warn("the cache failed to load");', [["message", "the cache failed to load"]]],
    ["js", 'throw new Error(`given=${a} run=${b}`);', []],
    ["jsx", '<Button onClick={go}>Click here please</Button><input aria-label="Enter your name here" />', [["ui-button", "Click here please"], ["ui-label", "Enter your name here"]]],
    ["py", 'def test_lease_is_released_on_exit():\n    raise ValueError("the token was rejected")', [["test-name", "test_lease_is_released_on_exit"], ["message", "the token was rejected"]]],
    ["rust", '#[test]\nfn grant_waits_for_owner() { panic!("owner {} left the group", id); }', [["test-name", "grant_waits_for_owner"], ["message", "owner {} left the group"]]],
    ["go", 'func TestLeaseExpires(t *testing.T) { t.Run("lease: zero ttl -> expired", f); return errors.New("the lease timed out") }', [["test-name", "TestLeaseExpires"], ["test-name", "lease: zero ttl -> expired"], ["message", "the lease timed out"]]],
    ["swift", '@Test("grant: idle queue -> immediate") func a() { Text("Welcome back!"); Button("Save") ; fatalError("state \\(s.name()) is invalid") }', [["test-name", "grant: idle queue -> immediate"], ["ui-text", "Welcome back!"], ["ui-button", "Save"], ["message", "state \\(s.name()) is invalid"]]],
    ["swift", 'Text("Slots").help("Total slots on the GPU")', [["ui-text", "Slots"], ["ui-description", "Total slots on the GPU"]]],
  ];
  assert.deepEqual(
    cases.map(([lang, code]) => extractCodeProse(lang, code).spans.map((span) => [span.kind, span.raw])),
    cases.map(([, , expected]) => expected),
  );
});

test("splitWords: identifier styles -> lowercase words", () => {
  const cases: [string, string[]][] = [
    ["leverageCache", ["leverage", "cache"]],
    ["seamless_merge", ["seamless", "merge"]],
    ["HTTPServerHolds", ["http", "server", "holds"]],
    ["ledByDescendant", ["led", "by", "descendant"]],
    ["max_s", ["max", "s"]],
  ];
  assert.deepEqual(
    cases.map(([name]) => splitWords(name)),
    cases.map(([, expected]) => expected),
  );
});

test("code lint: code and test snippets -> slopnuke rule ids", async () => {
  const handle = await loadLinter([ROOT]);
  assert.ok(handle, "slopsift is installed in the repo");
  const cases: [string, LintMode, string, string[]][] = [
    ["a.test.ts", "tests", 'test("returns 401 when the token is missing", () => {});\n', ["test-name-format"]],
    ["a.test.ts", "tests", 'test("auth: missing token -> 401", () => {});\n', []],
    ["a.test.ts", "tests", 'test("queue: idle -> waiter granted at close", () => {});\n', ["agentless-passive"]],
    ["a_test.py", "tests", "def test_lease_is_released_on_exit():\n    pass\n", ["agentless-passive"]],
    ["a.ts", "code", 'throw new Error("the request waits for a free slot");\n', ["inanimate-subject"]],
    ["a.ts", "code", 'const leverageCache = 1;\nconst cacheSize = 2;\n', ["identifier-word"]],
    ["a.ts", "code", 'logger.warn("relayd skips the job");\n', []],
    ["a.swift", "code", 'Button("Settings")\nLabel("Choose a file from the list below", systemImage: "doc")\nText("Sorry, something broke")\n', ["ui-button", "ui-label", "ui-tone"]],
    ["a.swift", "code", 'Button("Save file")\nLabel("Recent files", systemImage: "doc")\n', []],
    ["a.ts", "tests", 'throw new Error("the request waits for a free slot");\n', []],
  ];
  const actual: string[][] = [];
  for (const [file, mode, source] of cases) {
    const lints = await handle.linter.lint(file, source, mode, ACTOR_FIRST);
    actual.push(lints.filter((lint) => lint.ruleId.startsWith("slopnuke/")).map((lint) => lint.ruleId.slice("slopnuke/".length)).sort());
  }
  assert.deepEqual(actual, cases.map(([, , , expected]) => expected));
});

test("ui-description: help strings in configured calls -> a finding for each clause and none for noun phrases", async () => {
  const handle = await loadLinter([ROOT]);
  assert.ok(handle, "slopsift is installed in the repo");
  const configured = resolveSettings([{ profile: "actor-first", descriptionCalls: [".value", ".toggle"], lists: {} }]);
  const cases: [string, typeof configured, number][] = [
    ['.value(["--slots"], "N", .engine, .integer(1 ... 256), "The total amount of concurrent slots for a loaded model.") { state, flag, raw in }\n', configured, 0],
    ['.value(["--slots"], "N", .engine, .integer(1 ... 256), "jobs served at once on the host") { state, flag, raw in }\n', configured, 1],
    ['.toggle(["--speak"], .model, .none, "read replies aloud with the system voice in chat") { state, on in }\n', configured, 1],
    ['.value(["--slots"], "N", .engine, .integer(1 ... 256), "jobs served at once on the host") { state, flag, raw in }\n', ACTOR_FIRST, 0],
    ['Text("Slots").help("Read replies aloud with the system voice")\n', ACTOR_FIRST, 1],
    ['.value(["--host"], "ADDR", .server, .none, .text, "address to bind (127.0.0.1)") { state, _, raw in }\n', configured, 0],
    ['.value(["--draft"], "N", .model, .none, .integer(1 ... 8), "tokens the draft model proposes per round (3)") { state, flag, raw in }\n', configured, 0],
    ['.toggle(["--unix"], .server, .none, "serve on a Unix socket instead of TCP") { state, on in }\n.value(["--host"], "ADDR", .server, .none, .text, "address to bind (127.0.0.1)") { state, _, raw in }\n.value(["--port"], "N", .server, .none, .integer(1 ... 65535), "port (8080)") { state, flag, raw in }\n', configured, 1],
  ];
  const actual: number[] = [];
  for (const [source, settings] of cases) {
    const lints = await handle.linter.lint("Flags.swift", source, "code", settings);
    actual.push(lints.filter((lint) => lint.ruleId === "slopnuke/ui-description").length);
  }
  assert.deepEqual(actual, cases.map(([, , expected]) => expected));
});
