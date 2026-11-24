import assert from "node:assert/strict";
import { test } from "node:test";
import { accepts, parseAccept, parseAcceptArgs } from "./accept.ts";

test("accepts: accept file lines and findings -> match result per finding", () => {
  const list = parseAccept([
    "# slopnuke accept list",
    "reader-first/unexplained-initialism GPU",
    "slopnuke/agentless-passive   method   not found",
    "ai-style/em-dash-overuse",
    "not a rule line",
    "",
  ].join("\n"));
  const cases: [string, string, boolean][] = [
    ["reader-first/unexplained-initialism", "GPU", true],
    ["reader-first/unexplained-initialism", "CPU", false],
    ["slopnuke/agentless-passive", "method not\n found", true],
    ["slopnuke/agentless-passive", "method not found here", false],
    ["ai-style/em-dash-overuse", "—", true],
    ["ai-style/ai-vocabulary", "GPU", false],
    ["not", "a rule line", false],
  ];
  assert.deepEqual(
    cases.map(([ruleId, text]) => accepts(list, ruleId, text)),
    cases.map(([, , expected]) => expected),
  );
});

test("parseAcceptArgs: command arguments -> request", () => {
  const cases: [string[], unknown][] = [
    [["0123456789", "abcdef0123"], { kind: "ids", ids: ["0123456789", "abcdef0123"] }],
    [["reader-first/unexplained-initialism", "GPU"], { kind: "rule", entry: { ruleId: "reader-first/unexplained-initialism", text: "GPU" } }],
    [["ai-style/em-dash-overuse"], { kind: "rule", entry: { ruleId: "ai-style/em-dash-overuse", text: null } }],
    [["slopnuke/banned-word", "hold", "on"], { kind: "rule", entry: { ruleId: "slopnuke/banned-word", text: "hold on" } }],
    [["0123456789", "GPU"], { kind: "invalid" }],
    [["XYZ"], { kind: "invalid" }],
    [[], { kind: "invalid" }],
  ];
  assert.deepEqual(
    cases.map(([args]) => parseAcceptArgs(args)),
    cases.map(([, expected]) => expected),
  );
});
