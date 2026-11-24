import assert from "node:assert/strict";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ConfigError, parseConfigLayer, resolveSettings, type ConfigLayer } from "./config.ts";
import { loadLinter, type LintMode } from "./scan.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("parseConfigLayer: config texts -> layer or config error", () => {
  const cases: [string, unknown][] = [
    ['{"profile": "actor-first", "terms": ["Shared"], "rules": {"slopnuke/arrow": "off"}}', { profile: "actor-first", rules: { "slopnuke/arrow": "off" }, lists: { terms: ["shared"] } }],
    ['{"$schema": "x", "bannedWords": ["synergy"]}', { lists: { bannedWords: ["synergy"] } }],
    ['{"profile": "strict"}', "x: profile is not one of standard, actor-first"],
    ['{"rules": {"arrow": "off"}}', "x: rules key arrow is not a rule id"],
    ['{"rules": {"slopnuke/arrow": "error"}}', 'x: rules.slopnuke/arrow is not "off", "warn" or an object of scopes'],
    ['{"rules": {"reader-first/fragment-chain": {"cc": "off"}}, "ignore": ["Sources/**/upstream/**"]}', { rules: { "reader-first/fragment-chain": { cc: "off" } }, ignore: ["Sources/**/upstream/**"], lists: {} }],
    ['{"rules": {"reader-first/fragment-chain": {"docs": "off"}}}', "x: rules.reader-first/fragment-chain.docs is not one of md, cc, code, tests"],
    ['{"rules": {"reader-first/fragment-chain": {"cc": "on"}}}', 'x: rules.reader-first/fragment-chain.cc is not "off" or "warn"'],
    ['{"ignore": ["!keep.md"]}', 'x: ignore pattern !keep.md uses "!", which slopnuke does not support'],
    ['{"ignore": "vendor"}', "x: ignore is not a list of nonempty strings"],
    ['{"intentVerbs": ["Ponder"]}', { lists: { intentVerbs: ["ponder"] } }],
    ['{"descriptionCalls": [".value", "Setting"]}', { descriptionCalls: [".value", "Setting"], lists: {} }],
    ['{"descriptionCalls": ["value("]}', 'x: descriptionCalls is not a list of call names such as ".help" or "Setting"'],
    ['{"terms": "shared"}', "x: terms is not a list of nonempty strings"],
    ['{"colour": "red"}', "x: unknown key colour"],
    ["[]", "x: the config is not a JSON object"],
  ];
  const run = (text: string): unknown => {
    try {
      return parseConfigLayer(text, "x");
    } catch (error) {
      return error instanceof ConfigError ? error.message : `unexpected ${String(error)}`;
    }
  };
  assert.deepEqual(
    cases.map(([text]) => run(text)),
    cases.map(([, expected]) => (expected !== null && typeof expected === "object" ? JSON.parse(JSON.stringify(expected)) : expected)),
  );
});

test("resolveSettings: layers -> profile, per-scope rules, word lists, intent verbs", () => {
  const cases: [ConfigLayer[], { profile: string; md: number; cc: number; banned: string[]; ccOff: string[]; mdOff: string[]; ponder: boolean }][] = [
    [[], { profile: "standard", md: 2, cc: 2, banned: ["delve:true", "hold:false", "synergy:false"], ccOff: [], mdOff: [], ponder: false }],
    [[{ profile: "actor-first", lists: {} }], { profile: "actor-first", md: 23, cc: 23, banned: ["delve:true", "hold:true", "synergy:false"], ccOff: ["ai-style/evidence-cluster"], mdOff: ["ai-style/evidence-cluster"], ponder: false }],
    [[{ profile: "actor-first", rules: { "ai-style/evidence-cluster": "warn" }, lists: {} }], { profile: "actor-first", md: 23, cc: 23, banned: ["delve:true", "hold:true", "synergy:false"], ccOff: [], mdOff: [], ponder: false }],
    [
      [{ profile: "actor-first", lists: {} }, { rules: { "slopnuke/arrow": "off", "reader-first/unexplained-initialism": "off" }, lists: { bannedWords: ["synergy"], allowedWords: ["hold"] } }],
      { profile: "actor-first", md: 22, cc: 22, banned: ["delve:true", "hold:false", "synergy:true"], ccOff: ["ai-style/evidence-cluster", "reader-first/unexplained-initialism"], mdOff: ["ai-style/evidence-cluster", "reader-first/unexplained-initialism"], ponder: false },
    ],
    [
      [{ profile: "actor-first", rules: { "reader-first/fragment-chain": { cc: "off" }, "slopnuke/island-sentence": { cc: "off" } }, lists: { intentVerbs: ["ponder"] } }],
      { profile: "actor-first", md: 23, cc: 22, banned: ["delve:true", "hold:true", "synergy:false"], ccOff: ["ai-style/evidence-cluster", "reader-first/fragment-chain"], mdOff: ["ai-style/evidence-cluster"], ponder: true },
    ],
    [[{ rules: { "slopnuke/ui-tone": "warn" }, lists: {} }], { profile: "standard", md: 3, cc: 3, banned: ["delve:true", "hold:false", "synergy:false"], ccOff: [], mdOff: [], ponder: false }],
  ];
  assert.deepEqual(
    cases.map(([layers]) => {
      const settings = resolveSettings(layers);
      return {
        profile: settings.profile,
        md: settings.scopes.md.enabled.size,
        cc: settings.scopes.cc.enabled.size,
        banned: ["delve", "hold", "synergy"].map((word) => `${word}:${settings.lexicon.bannedWords.has(word)}`),
        ccOff: settings.scopes.cc.slopsiftOff,
        mdOff: settings.scopes.md.slopsiftOff,
        ponder: settings.lexicon.intentVerbs.has("ponders"),
      };
    }),
    cases.map(([, expected]) => expected),
  );
});

test("ignore globs: patterns and repo paths -> true or false per path", () => {
  const settings = resolveSettings([{ ignore: ["Sources/Parser/upstream/**", "deps/zlib", "*.generated.swift", "docs/"], lists: {} }]);
  const cases: [string, boolean][] = [
    ["Sources/Parser/upstream/cpp/grammar.cc", true],
    ["Sources/Parser/upstream", true],
    ["Sources/Parser/Parser.swift", false],
    ["deps/zlib/include/zlib.h", true],
    ["deps/other/file.h", false],
    ["Sources/App/Model.generated.swift", true],
    ["Sources/App/Model.swift", false],
    ["docs/guide.md", true],
    ["guides/docs.md", false],
  ];
  assert.deepEqual(
    cases.map(([path]) => settings.ignore(path)),
    cases.map(([, expected]) => expected),
  );
});

test("settings lint: profiles and terms -> slopnuke rule ids", async () => {
  const handle = await loadLinter([ROOT]);
  assert.ok(handle, "slopsift is installed in the repo");
  const standard = resolveSettings([]);
  const actorFirst = resolveSettings([{ profile: "actor-first", lists: {} }]);
  const withTerm = resolveSettings([{ profile: "actor-first", lists: { terms: ["shared"] } }]);
  const cases: [string, LintMode, string, typeof standard, string[]][] = [
    ["a.md", "prose", "When a connection reaches EOF, relayd releases every lease.\n", standard, []],
    ["a.md", "prose", "When a connection reaches EOF, relayd releases every lease.\n", actorFirst, ["figurative-verb", "inanimate-subject"]],
    ["a.md", "prose", "This change seamlessly leverages the cache.\n", standard, ["banned-word", "banned-word"]],
    ["a.md", "prose", "Shared at once beside the queue.\n", actorFirst, ["agentless-passive"]],
    ["a.md", "prose", "The `shared` class runs first.\n\nShared at once beside the queue.\n", actorFirst, []],
    ["a.md", "prose", "Shared at once beside the queue.\n", withTerm, []],
    ["a.test.ts", "tests", 'test("returns 401 when the token is missing", () => {});\n', standard, []],
  ];
  const actual: string[][] = [];
  for (const [file, mode, source, settings] of cases) {
    const lints = await handle.linter.lint(file, source, mode, settings);
    actual.push(lints.filter((lint) => lint.ruleId.startsWith("slopnuke/")).map((lint) => lint.ruleId.slice("slopnuke/".length)).sort());
  }
  assert.deepEqual(actual, cases.map(([, , , , expected]) => expected));
});
