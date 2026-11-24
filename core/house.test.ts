import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { resolveSettings } from "./config.ts";
import { loadLinter } from "./scan.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ACTOR_FIRST = resolveSettings([{ profile: "actor-first", lists: {} }]);

const CASES: [string, string[]][] = [
  ["The child leads a new process group.", ["figurative-verb"]],
  ["Registration under a name makes a harness a neighbor.", ["inanimate-subject"]],
  ["When a result is named attestation, relayd sends that object.", ["agentless-passive"]],
  ["relayd grants a lease when its `token` names a live lease.", ["animate-subject", "inanimate-subject"]],
  ["The client attaches to a group led by a descendant of the owner.", ["participle-after-noun"]],
  ["When a connection reaches EOF, relayd releases every lease on it.", ["figurative-verb", "inanimate-subject"]],
  ["Granted at once.", ["agentless-passive"]],
  ["Otherwise the overlap is recorded.", ["agentless-passive"]],
  ["When a new file fails to decode, relayd keeps the previous config.", ["inanimate-subject", "vague-verb"]],
  ["This change seamlessly leverages the cache.", ["banned-word", "banned-word", "inanimate-subject"]],
  ["It's worth noting that relayd restarts.", ["banned-phrase"]],
  ["relayd moves the lease from the queue → the group.", ["arrow"]],
  ["| method | params |\n|---|---|\n| `paused` | `lease` — answer to `yield`, sent once no GPU work is in flight |", ["participle-after-noun"]],
  ["Privilege order: `background` < `exclusive` < `shared`.\n\nWhen a connection reaches EOF, relayd releases every lease.\n\n| path | content |\n|---|---|\n| `<dir>/relayd.sock` | socket |", ["figurative-verb", "inanimate-subject"]],
  ["relayd releases every lease on the connection.", []],
  ["The client sends the request line with sendmsg.", []],
  ["Keys are snake_case.", []],
  ["relayd applies a rule only when all of its fields match the client.", ["thing-possessive"]],
  ["Claude Code runs the hook after each edit.", []],
  ["Run the tests before each commit.", []],
  ["The lease has an attached process group.", []],
  ["Work runs through jobs in five steps.", ["inanimate-subject"]],
  ["The orchestrator accepts each attestation from a worker.", []],
  ["When the root no longer exists, Tessera treats the key as absent.", []],
  ["Tessera treats a missing root as an absent key.", []],
  ["relayd reads the config at boot; the client waits for it.", ["written-mark"]],
  ["Tessera is a read/write cache for builds on one machine.", ["written-mark"]],
  ["relayd reads the config, the policy and the ledger at boot, etc.", ["written-mark"]],
  ["Tessera speaks Transport Layer Security (TLS) over `a/b` paths and TCP/IP.", []],
];

test("house rules: markdown cases -> slopnuke rule ids", async () => {
  const handle = await loadLinter([ROOT]);
  assert.ok(handle, "slopsift is installed in the repo");
  const actual: string[][] = [];
  for (const [text] of CASES) {
    const lints = await handle.linter.lint("case.md", `${text}\n`, "prose", ACTOR_FIRST);
    actual.push(lints.filter((lint) => lint.ruleId.startsWith("slopnuke/")).map((lint) => lint.ruleId.slice("slopnuke/".length)).sort());
  }
  assert.deepEqual(actual, CASES.map(([, expected]) => expected));
});

const PROFILE_CASES: [string, string[]][] = [
  ["If `gpq` is not on `PATH`, add its directory to `PATH`.", []],
  ["gpq forwards `SIGTERM` to the child, and `SIGTERM` stops the child.", []],
  ["relayd reads the ledger through `coalition_info_resource_usage` once per sample.", []],
];

test("profile rules: inline code identifiers in markdown -> no SlopSift findings on code", async () => {
  const handle = await loadLinter([ROOT]);
  assert.ok(handle, "slopsift is installed in the repo");
  const actual: string[][] = [];
  for (const [text] of PROFILE_CASES) {
    const lints = await handle.linter.lint("case.md", `${text}\n`, "prose", ACTOR_FIRST);
    actual.push(lints.filter((lint) => !lint.ruleId.startsWith("slopnuke/")).map((lint) => lint.ruleId).sort());
  }
  assert.deepEqual(actual, PROFILE_CASES.map(([, expected]) => expected));
});
