import assert from "node:assert/strict";
import { test } from "node:test";
import { ignored, locate, maskTables, parseIgnore } from "./scan.ts";
import { editedPaths, parseRunRecord } from "./store.ts";

test("maskTables: markdown and source inputs -> blank table rows in markdown only", () => {
  const cases: [string, string, string][] = [
    ["a.md", "text\n| a | b |\n|---|---|\nmore", "text\n         \n         \nmore"],
    ["a.md", "  | x |\nend", "       \nend"],
    ["a.md", "no table | here", "no table | here"],
    ["a.ts", "| a |", "| a |"],
    ["A.MDX", "| a |", "     "],
  ];
  assert.deepEqual(
    cases.map(([file, text]) => maskTables(text, file)),
    cases.map(([, , expected]) => expected),
  );
});

test("locate: offsets across lines -> line and column numbers from 1", () => {
  const text = "ab\ncde\n\nf";
  const cases: [number, { line: number; column: number }][] = [
    [0, { line: 1, column: 1 }],
    [2, { line: 1, column: 3 }],
    [3, { line: 2, column: 1 }],
    [5, { line: 2, column: 3 }],
    [7, { line: 3, column: 1 }],
    [8, { line: 4, column: 1 }],
  ];
  assert.deepEqual(
    cases.map(([offset]) => locate(text, offset)),
    cases.map(([, expected]) => expected),
  );
});

test("ignore check: gitignore patterns -> true for matching paths", () => {
  const rules = parseIgnore("# comment\n*.log\n/build\ndocs/gen/\n!keep.log\n**/tmp/*.md\n");
  const cases: [string, boolean, boolean][] = [
    ["a.log", false, true],
    ["deep/b.log", false, true],
    ["build", true, true],
    ["sub/build", true, false],
    ["docs/gen", true, true],
    ["docs/gen", false, false],
    ["x/tmp/n.md", false, true],
    ["tmp/n.md", false, true],
    ["keep.md", false, false],
  ];
  assert.deepEqual(
    cases.map(([rel, isDirectory]) => ignored(rules, rel, isDirectory)),
    cases.map(([, , expected]) => expected),
  );
});

test("editedPaths: Claude and Codex tool inputs -> absolute edited paths", () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: docs/b.md\n+hi\n*** Update File: old.md\n*** Move to: new.md\n*** Delete File: gone.md\n*** End Patch";
  const cases: [unknown, unknown, string[]][] = [
    ["Write", { file_path: "/r/a.md" }, ["/r/a.md"]],
    ["Edit", { file_path: "rel/b.ts" }, ["/cwd/rel/b.ts"]],
    ["MultiEdit", { file_path: "/r/c.py" }, ["/r/c.py"]],
    ["NotebookEdit", { notebook_path: "/r/n.ipynb" }, ["/r/n.ipynb"]],
    ["apply_patch", { command: patch }, ["/cwd/src/a.ts", "/cwd/docs/b.md", "/cwd/old.md", "/cwd/new.md"]],
    ["Bash", { command: "echo hi > x.md" }, []],
    ["Write", { file_path: 4 }, []],
    ["Write", null, []],
    [undefined, {}, []],
  ];
  assert.deepEqual(
    cases.map(([tool, input]) => editedPaths(tool, input, "/cwd")),
    cases.map(([, , expected]) => expected),
  );
});

test("parseRunRecord: stored records -> record or null", () => {
  const run = { phases: ["md"], stage: { kind: "rewriting", files: ["/r/a.md"] }, round: 1, last: 3, stalls: 0 };
  const good = { version: 1, id: "r1", root: "/r", cwd: "/r", session: null, blocks: 0, reason: null, updated: 1, run };
  const cases: [unknown, boolean][] = [
    [good, true],
    [{ ...good, session: "s", reason: "go" }, true],
    [{ ...good, version: 2 }, false],
    [{ ...good, id: "" }, false],
    [{ ...good, root: "rel" }, false],
    [{ ...good, blocks: -1 }, false],
    [{ ...good, session: 3 }, false],
    [{ ...good, run: { ...run, phases: [] } }, false],
    [{ ...good, run: { ...run, stage: { kind: "rewriting", files: [] } } }, false],
    [null, false],
    ["text", false],
  ];
  assert.deepEqual(
    cases.map(([value]) => parseRunRecord(value) !== null),
    cases.map(([, expected]) => expected),
  );
});
