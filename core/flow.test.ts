import assert from "node:assert/strict";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveSettings } from "./config.ts";
import { stem } from "./house.ts";
import { loadLinter } from "./scan.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ACTOR_FIRST = resolveSettings([{ profile: "actor-first", lists: {} }]);
const FLOW = /^slopnuke\/(repeated-subject|choppy-run|island-sentence|stilted-negation|unrelated-join)$/;

test("stem: word forms -> one shared stem", () => {
  const cases: [string, string][] = [
    ["approves", "approv"],
    ["approval", "approv"],
    ["approved", "approv"],
    ["harnesses", "harness"],
    ["harness", "harness"],
    ["supplies", "supply"],
    ["neighbors", "neighb"],
    ["status", "status"],
  ];
  assert.deepEqual(
    cases.map(([word]) => stem(word)),
    cases.map(([, expected]) => expected),
  );
});

test("flow rules: paragraphs -> flow rule ids", async () => {
  const handle = await loadLinter([ROOT]);
  assert.ok(handle, "slopsift is installed in the repo");
  const cases: [string, string[]][] = [
    ["Atlas is a build server. It runs no tests. It coordinates the workers that do, on one machine or across hosts.", ["repeated-subject", "stilted-negation"]],
    ["The operator stays in charge. The operator steers a goal with amendments.", ["repeated-subject"]],
    ["The operator stays in charge and steers each goal with amendments.", []],
    [
      "The broker stores jobs in an encrypted SQLite file. Clients reach the broker over a Unix socket. Per-harness adapters connect the harnesses. Clients send each job to the broker as JSON.",
      ["choppy-run", "island-sentence"],
    ],
    ["The broker stores jobs in an encrypted SQLite file, and clients reach it over a Unix socket. Because each harness speaks its own protocol, a per-harness adapter connects it to the broker.", []],
    ["1. A worker claims the job.\n2. A worker edits the code.\n3. A worker submits the result.\n4. A worker reports progress.", []],
    ["relayd signals no process at that point.", ["stilted-negation"]],
    ["Per-harness adapters connect the harnesses, and operators use a native cockpit window.", ["unrelated-join"]],
    ["The broker stores jobs in SQLite, and clients read those jobs over a socket.", []],
    ["The CALL contract is in one file, harness onboarding is in another, and the store reference is in a third.", []],
    ["The broker stores each job in an encrypted SQLite file on the host. Clients send each job to the broker over a Unix socket.\n\nPlacing the run tree outside the workspace has two results for every agent.", []],
    ["The operator approves each new neighbor in a native dialog on the host.\n\nThe operator steers each goal with amendments over the whole run.\n\nThe operator decides on each change that an orchestrator suggests to it.", ["repeated-subject", "repeated-subject"]],
    ["Each op name starts with a category prefix such as `context.`, `mutate.` or `verify.` in the request. The daemon groups each op by that category prefix.", []],
    ["The operator approves each new neighbor in a native dialog. Each approval opens a dialog that no harness can answer.\n\nThe operator also steers each goal with amendments over time.", []],
  ];
  const actual: string[][] = [];
  for (const [text] of cases) {
    const lints = await handle.linter.lint("case.md", `${text}\n`, "prose", ACTOR_FIRST);
    actual.push(lints.filter((lint) => FLOW.test(lint.ruleId)).map((lint) => lint.ruleId.slice("slopnuke/".length)).sort());
  }
  assert.deepEqual(actual, cases.map(([, expected]) => expected));
});

test("flow and load rules: choppy paragraph, then the same facts in two joined sentences -> findings, then none", async () => {
  const handle = await loadLinter([ROOT]);
  assert.ok(handle, "slopsift is installed in the repo");
  const watched = /^(slopnuke\/(repeated-subject|choppy-run|island-sentence)|reader-first\/sentence-load)$/;
  const cases: [string, string[]][] = [
    ["relayd starts at boot. It reads the config. It opens the socket. It waits for clients.", ["slopnuke/choppy-run", "slopnuke/repeated-subject", "slopnuke/repeated-subject"]],
    ["relayd starts at boot, reads the config and then opens the socket. After that, it waits for clients on that socket.", []],
  ];
  const actual: string[][] = [];
  for (const [text] of cases) {
    const lints = await handle.linter.lint("case.md", `${text}\n`, "prose", ACTOR_FIRST);
    actual.push(lints.filter((lint) => watched.test(lint.ruleId)).map((lint) => lint.ruleId).sort());
  }
  assert.deepEqual(actual, cases.map(([, expected]) => expected));
});

test("thing-possessive: owners by nearest noun -> findings only for data owners", async () => {
  const handle = await loadLinter([ROOT]);
  assert.ok(handle, "slopsift is installed in the repo");
  const cases: [string, number][] = [
    ["A choppy paragraph is flagged, and its joined rewrite gets no finding.", 1],
    ["The worker edits in its own git worktree.", 0],
    ["The daemon reads the config and its policy file.", 1],
    ["The file's owner can read it.", 1],
    ["The operator's token opens a session.", 0],
    ["Users keep their keys in the agent.", 0],
  ];
  const actual: number[] = [];
  for (const [text] of cases) {
    const lints = await handle.linter.lint("case.md", `${text}\n`, "prose", ACTOR_FIRST);
    actual.push(lints.filter((lint) => lint.ruleId === "slopnuke/thing-possessive").length);
  }
  assert.deepEqual(actual, cases.map(([, expected]) => expected));
});

test("missing-object and vague-verb: verbs with and without objects -> rule ids", async () => {
  const handle = await loadLinter([ROOT]);
  assert.ok(handle, "slopsift is installed in the repo");
  const watched = /^slopnuke\/(missing-object|vague-verb)$/;
  const cases: [string, string[]][] = [
    ["The worker edits in its own git worktree.", ["slopnuke/missing-object"]],
    ["The worker edits the files in a git worktree.", []],
    ["relayd reads and writes the config.", []],
    ["The files that the hook writes stay on disk.", []],
    ["relayd reads the config at boot.", []],
    ["The probe passes.", ["slopnuke/missing-object"]],
    ["relayd passes the calibration check.", []],
    ["Users keep their keys in the agent.", ["slopnuke/vague-verb"]],
    ["The agent stores the keys of each user.", []],
    ["The daemon handles requests from clients.", ["slopnuke/vague-verb"]],
    ["Nobody ever wrote to the new location on the disk.", []],
    ["Tessera never writes through the link to the workspace.", []],
  ];
  const actual: string[][] = [];
  for (const [text] of cases) {
    const lints = await handle.linter.lint("case.md", `${text}\n`, "prose", ACTOR_FIRST);
    actual.push(lints.filter((lint) => watched.test(lint.ruleId)).map((lint) => lint.ruleId).sort());
  }
  assert.deepEqual(actual, cases.map(([, expected]) => expected));
});

test("stilted-negation: verb plus no plus noun -> advice with does not and any", async () => {
  const handle = await loadLinter([ROOT]);
  assert.ok(handle, "slopsift is installed in the repo");
  const lints = await handle.linter.lint("case.md", "Tessera reports no error for a missing root.\n", "prose", ACTOR_FIRST);
  assert.deepEqual(lints.filter((lint) => lint.ruleId === "slopnuke/stilted-negation").map((lint) => lint.message), ['"reports no error" reads as stilted. Write the negation with "does not", for example "does not report any error".']);
});
