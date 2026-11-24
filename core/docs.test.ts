import assert from "node:assert/strict";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { extractLintText } from "slopsift/extract";
import { commentPassages } from "./code.ts";
import { resolveSettings } from "./config.ts";
import { loadLinter, withoutIgnored } from "./scan.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ACTOR_FIRST = resolveSettings([{ profile: "actor-first", lists: {} }]);
const handle = await loadLinter([ROOT]);

async function docLints(comment: string): Promise<string[]> {
  assert.ok(handle, "slopsift is installed in the repo");
  const lints = await handle.linter.lint("Fixture.swift", `/// ${comment}\nfunc fixture() {}\n`, "prose", ACTOR_FIRST);
  return lints.map((lint) => lint.ruleId).sort();
}

test("doc comments: noun phrase, condition and copula shapes -> no finding from any rule", async () => {
  const cases = [
    "Top border with the title.",
    "Condition: the cache has an entry for this key.",
    "The stored values are the keys of one cache entry.",
    "Setting value type that the CLI uses for parsing, TOML validation and the config editor.",
  ];
  const actual: string[][] = [];
  for (const comment of cases) actual.push(await docLints(comment));
  assert.deepEqual(actual, cases.map(() => []));
});

const STRUCTS = [
  "/// Limits of one cache run: sizes.",
  "public struct CachePlan: Sendable {",
  "    /// Entry sizes in bytes with the first one for a warm start.",
  "    public var sizes: [Int]",
  "    /// Hit rates of one run at every size.",
  "    public var rates: [Double]",
  "}",
  "",
  "/// Result of a cache run.",
  "public struct CacheReport: Sendable {",
  "    public var sizes: [Int]",
  "    public var baseline: [Double]",
  "}",
  "",
].join("\n");

const MARKS = [
  "import Foundation",
  "",
  "// MARK: Context",
  "",
  "/// Top border of the window.",
  "public struct Border {",
  "    // MARK: getters - boolean",
  "",
  "    public func get() -> Bool? {",
  "        self.flag()",
  "    }",
  "}",
  "",
].join("\n");

const plainSlopSift = async (file: string, source: string): Promise<{ ruleId: string; text: string }[]> => {
  const { createSlopSift } = await import("slopsift");
  return ((await (await createSlopSift()).lintSource(file, source, { level: "warning", rulepacks: ["ai-style", "reader-first"] }))?.lints ?? []) as { ruleId: string; text: string }[];
};

test("doc comments: comments between struct code -> plain SlopSift spans code, slopnuke spans none", async () => {
  assert.ok(handle, "slopsift is installed in the repo");
  const hasCode = (lints: { text: string }[]): number => lints.filter((lint) => /public |[{}]/.test(lint.text)).length;
  const plain = await plainSlopSift("Cache.swift", STRUCTS);
  const ours = await handle.linter.lint("Cache.swift", STRUCTS, "prose", ACTOR_FIRST);
  assert.deepEqual([hasCode(plain) > 0, hasCode(ours)], [true, 0]);
});

test("pragma lines: MARK lines in a Swift file -> plain SlopSift flags MARK, slopnuke flags nothing on MARK", async () => {
  assert.ok(handle, "slopsift is installed in the repo");
  const onMark = (lints: { text: string }[]): number => lints.filter((lint) => /MARK/.test(lint.text)).length;
  const plain = await plainSlopSift("Getters.swift", MARKS);
  const ours = await handle.linter.lint("Getters.swift", MARKS, "prose", ACTOR_FIRST);
  assert.deepEqual([onMark(plain) > 0, onMark(ours)], [true, 0]);
});

test("comment headers: license header, pragma lines and ignored paths -> no prose, no files", () => {
  const source = [
    "//",
    "//  Cache.swift",
    "//  Example",
    "//",
    "//  Created by Jane Doe on 02.06.2025.",
    "//  Copyright © 2024 Example Corp.",
    "//",
    "",
    "import Foundation",
    "",
    "// MARK: Context",
    "// TODO: remove after the port",
    "// swiftlint:disable line_length",
    "/// The window shows the context.",
    "struct Context {}",
    "",
  ].join("\n");
  const prose = commentPassages(source, extractLintText("Cache.swift", source)).replace(/\s+/g, " ").trim();
  const settings = resolveSettings([{ ignore: ["Sources/Parser/upstream/**"], lists: {} }]);
  const kept = withoutIgnored(["/r/Sources/Parser/upstream/a.cc", "/r/3rdparty/zlib/zlib.h", "/r/Sources/App/Model.swift"], "/r", settings);
  assert.deepEqual([prose, kept], ["The window shows the context.", ["/r/Sources/App/Model.swift"]]);
});

test("comment passages: template literal lines, block, trailing and hash comments -> only comment prose", () => {
  const ts = [
    "const NOUNS = words(`",
    "  amendment answer approval argument",
    "  contract dialog draft epoch",
    "`);",
    "/*",
    " Block comment text for the reader.",
    "*/",
    "const limit = 4; // Trailing note for the limit.",
    "",
  ].join("\n");
  const py = ["def run():", "    # Hash comment for the run.", "    return 1", ""].join("\n");
  const prose = (file: string, source: string): string => commentPassages(source, extractLintText(file, source)).replace(/[\s\u2029]+/g, " ").trim();
  assert.deepEqual([prose("words.ts", ts), prose("run.py", py)], ["Block comment text for the reader. Trailing note for the limit.", "Hash comment for the run."]);
});

test("markdown lists: thirteen-item numbered list under a heading -> plain SlopSift paragraph-load, slopnuke none", async () => {
  assert.ok(handle, "slopsift is installed in the repo");
  const items = Array.from({ length: 13 }, (_, index) => `${index + 1}. The client sends request number ${index + 1} to the daemon, and the daemon answers it with a lease.`);
  const source = `# Steps\nThe list below shows the order.\n${items.join("\n")}\n`;
  const load = (lints: { ruleId?: string; text: string }[]): number => lints.filter((lint) => lint.ruleId === "reader-first/paragraph-load").length;
  const plain = await plainSlopSift("Steps.md", source);
  const ours = await handle.linter.lint("Steps.md", source, "prose", ACTOR_FIRST);
  assert.deepEqual([load(plain) > 0, load(ours)], [true, 0]);
});

test("markdown headings: level-two heading right after a text line -> plain SlopSift paragraph-load across it, slopnuke none", async () => {
  assert.ok(handle, "slopsift is installed in the repo");
  const sentence = (index: number): string => `The daemon writes event number ${index} to the ledger file after the client releases the lease and the queue moves forward again.`;
  const source = `${[1, 2, 3, 4].map(sentence).join(" ")}\n## Next stage\n${[5, 6, 7, 8].map(sentence).join(" ")}\n`;
  const load = (lints: { ruleId?: string }[]): number => lints.filter((lint) => lint.ruleId === "reader-first/paragraph-load").length;
  const plain = await plainSlopSift("Stage.md", source);
  const ours = await handle.linter.lint("Stage.md", source, "prose", ACTOR_FIRST);
  assert.deepEqual([load(plain) > 0, load(ours)], [true, 0]);
});

test("doc comments: two copula sentences with one subject -> repeated-subject in markdown, nothing in one doc comment block", async () => {
  assert.ok(handle, "slopsift is installed in the repo");
  const first = "The stored values are the keys of one cache entry.";
  const second = "The stored values are the sizes of one cache entry.";
  const markdown = await handle.linter.lint("Entry.md", `${first} ${second}\n`, "prose", ACTOR_FIRST);
  const swift = [`/// ${first}`, `/// ${second}`, "var entry: [Float] = []", "", "/// Top border with the title.", "func top() {}", ""].join("\n");
  const comment = await handle.linter.lint("Entry.swift", swift, "prose", ACTOR_FIRST);
  assert.deepEqual([markdown.some((lint) => lint.ruleId === "slopnuke/repeated-subject"), comment.map((lint) => lint.ruleId)], [true, []]);
});

test("scoped rules: rule off in the cc scope only -> silent in comments, active in markdown", async () => {
  assert.ok(handle, "slopsift is installed in the repo");
  const scoped = resolveSettings([{ profile: "actor-first", rules: { "slopnuke/banned-word": { cc: "off" } }, lists: {} }]);
  const comment = await handle.linter.lint("Note.swift", "/// The cache delves into each layer for a key.\nfunc note() {}\n", "prose", scoped);
  const markdown = await handle.linter.lint("Note.md", "The cache delves into each layer for a key.\n", "prose", scoped);
  const banned = (lints: { ruleId: string }[]): number => lints.filter((lint) => lint.ruleId === "slopnuke/banned-word").length;
  assert.deepEqual([banned(comment), banned(markdown)], [0, 1]);
});
