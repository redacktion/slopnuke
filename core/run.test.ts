import assert from "node:assert/strict";
import test from "node:test";
import { advance, MAX_ROUNDS, MAX_STALLS, parseRun, start } from "./run.ts";
import type { Action, Event, FileResult, Note, Phase, Run, ScanFailure, Step } from "./run.ts";

// Fixtures

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const uniq = <T>(items: readonly T[]): T[] => [...new Set(items)];
const sorted = (items: readonly string[]): string[] => [...items].sort();

function fr(file: string, count: number): FileResult {
  return {
    file,
    findings: Array.from({ length: count }, (_, i) => ({ line: i + 1, column: 1, ruleId: "rule", message: "msg", text: "txt" })),
  };
}

const sum = (results: readonly FileResult[]): number => results.reduce((n, r) => n + r.findings.length, 0);

// Spec oracles

function validResults(files: readonly string[], results: readonly FileResult[]): FileResult[] {
  const seen = new Set<string>();
  const out: FileResult[] = [];
  for (const r of results) {
    if (!files.includes(r.file) || r.findings.length === 0 || seen.has(r.file)) continue;
    seen.add(r.file);
    out.push(r);
  }
  return out;
}

function validFailures(files: readonly string[], failures: readonly ScanFailure[]): ScanFailure[] {
  const seen = new Set<string>();
  const out: ScanFailure[] = [];
  for (const f of failures) {
    if (!files.includes(f.file) || seen.has(f.file)) continue;
    seen.add(f.file);
    out.push(f);
  }
  return out;
}

function idleOf(run: Run): Action {
  const phase = run.phases[0];
  switch (run.stage.kind) {
    case "listing":
      return { kind: "list", phase };
    case "scanning":
      return { kind: "scan", phase, files: run.stage.files, round: run.round };
    case "rewriting":
      return { kind: "await", phase, round: run.round };
  }
}

// Invariant checker

interface Ctx {
  given: Phase[];
  rewrites: Map<Phase, number>;
}

const seen = new Set<string>();

function checkShape(ctx: Ctx, step: Step, entered: boolean): void {
  const { run, action } = step;
  assert.equal(run === null, action.kind === "finish", "run is null exactly when action is finish");
  if (run === null) return;
  const given = uniq(ctx.given);
  assert.ok(run.phases.length > 0, "live run has phases");
  assert.deepEqual(run.phases, given.slice(given.length - run.phases.length), "phases are an ordered suffix of the deduplicated input");
  const phase = run.phases[0];
  assert.ok(Number.isInteger(run.round) && run.round >= 0 && run.round <= MAX_ROUNDS, "round within 0..MAX_ROUNDS");
  assert.ok(Number.isInteger(run.stalls) && run.stalls >= 0 && run.stalls < MAX_STALLS, "live stalls below MAX_STALLS");
  assert.ok(run.last === null || (Number.isInteger(run.last) && run.last >= 1), "last is null or a positive total");
  assert.equal(run.round === 0, run.last === null, "last is null exactly in round 0");
  switch (run.stage.kind) {
    case "listing":
      assert.deepEqual(action, { kind: "list", phase });
      assert.equal(run.round, 0);
      assert.equal(run.last, null);
      assert.equal(run.stalls, 0);
      break;
    case "scanning":
      assert.ok(run.stage.files.length > 0, "scanning stage has files");
      assert.deepEqual(action, { kind: "scan", phase, files: run.stage.files, round: run.round });
      break;
    case "rewriting":
      assert.ok(run.stage.files.length > 0, "rewriting stage has files");
      assert.ok(run.round >= 1, "rewriting stage is past round 0");
      if (entered) {
        assert.equal(action.kind, "rewrite");
        assert.deepEqual(sorted((action as Extract<Action, { kind: "rewrite" }>).results.map((r) => r.file)), sorted(run.stage.files));
      } else {
        assert.deepEqual(action, { kind: "await", phase, round: run.round });
      }
      break;
  }
  assert.deepEqual(parseRun(clone(run)), run, "parseRun round-trips a reachable run");
}

function expectEndRun(run: Run, next: Step): void {
  const rest = run.phases.slice(1);
  const expected = rest.length === 0 ? null : { phases: rest, stage: { kind: "listing" }, round: 0, last: null, stalls: 0 };
  assert.deepEqual(next.run, expected, "phase end moves to next phase or finishes");
}

// Rewriting-stage entry check.
function checkTransition(run: Run, event: Event, next: Step): boolean {
  const stage = run.stage;
  const phase = run.phases[0];
  if (event.kind === "aborted") {
    assert.deepEqual(next, { run: null, notes: [{ kind: "aborted" }], action: { kind: "finish" } });
    return false;
  }
  if (event.kind === "failed") {
    assert.deepEqual(next, { run: null, notes: [{ kind: "failed", error: event.error }], action: { kind: "finish" } });
    return false;
  }
  const fits =
    (stage.kind === "listing" && event.kind === "listed") ||
    (stage.kind === "scanning" && event.kind === "scanned") ||
    (stage.kind === "rewriting" && event.kind === "rewritten");
  if (!fits) {
    assert.deepEqual(next, { run, notes: [], action: idleOf(run) }, "misfit event changes nothing");
    return false;
  }
  if (event.kind === "listed") {
    if (event.files.length === 0) {
      assert.deepEqual(next.notes, [{ kind: "empty", phase }]);
      expectEndRun(run, next);
      return false;
    }
    assert.deepEqual(next.notes, []);
    const ns = next.run?.stage;
    if (ns?.kind !== "scanning") assert.fail("after a listed event with files, the stage is scanning");
    assert.deepEqual(sorted(uniq(ns.files)), sorted(uniq(event.files)));
    assert.deepEqual(next.run!.phases, run.phases);
    return false;
  }
  if (event.kind === "rewritten") {
    const files = (stage as Extract<Run["stage"], { kind: "rewriting" }>).files;
    assert.deepEqual(next, {
      run: { ...run, stage: { kind: "scanning", files } },
      notes: [],
      action: { kind: "scan", phase, files, round: run.round },
    });
    return false;
  }
  // Scanned event
  const files = (stage as Extract<Run["stage"], { kind: "scanning" }>).files;
  const valid = validResults(files, event.results);
  const fails = validFailures(files, event.failures);
  const total = sum(valid);
  const pre: Note[] = fails.length > 0 ? [{ kind: "unscanned", phase, failures: fails }] : [];
  if (total === 0) {
    assert.deepEqual(next.notes, [...pre, { kind: "clean", phase }]);
    expectEndRun(run, next);
    return false;
  }
  const stalls = run.last !== null && total >= run.last ? run.stalls + 1 : 0;
  const stalled = stalls >= MAX_STALLS;
  const limit = run.round >= MAX_ROUNDS;
  if (stalled || limit) {
    assert.deepEqual(next.notes.slice(0, pre.length), pre);
    assert.equal(next.notes.length, pre.length + 1);
    const stop = next.notes[pre.length] as Extract<Note, { kind: "stopped" }>;
    assert.deepEqual({ ...stop, reason: undefined }, { kind: "stopped", phase, total, rounds: run.round, reason: undefined });
    const reasons = [...(stalled ? ["stalled"] : []), ...(limit ? ["round-limit"] : [])];
    assert.ok(reasons.includes(stop.reason), `stop reason ${stop.reason} in ${reasons}`);
    expectEndRun(run, next);
    return false;
  }
  assert.deepEqual(next.notes, pre);
  assert.deepEqual(next.action, { kind: "rewrite", phase, round: run.round + 1, results: valid, total });
  assert.ok(next.run !== null);
  assert.equal(next.run.round, run.round + 1);
  assert.ok(next.run.round <= MAX_ROUNDS);
  assert.equal(next.run.last, total);
  assert.equal(next.run.stalls, stalls);
  assert.deepEqual(next.run.phases, run.phases);
  assert.equal(next.run.stage.kind, "rewriting");
  const rewritten = (next.run.stage as Extract<Run["stage"], { kind: "rewriting" }>).files;
  assert.ok(rewritten.length > 0 && rewritten.every((f) => files.includes(f)), "rewriting files are a non-empty subset of scanned files");
  assert.deepEqual(sorted(rewritten), sorted(valid.map((r) => r.file)));
  return true;
}

function record(prev: Run, next: Step): void {
  for (const n of next.notes) seen.add(n.kind === "stopped" ? `stopped:${n.reason}` : n.kind);
  if (next.action.kind === "rewrite" || next.action.kind === "await") seen.add(next.action.kind);
  if (next.run !== null && next.notes.length === 0 && JSON.stringify(next.run) === JSON.stringify(prev)) seen.add("noop");
}

function driveInner(ctx: Ctx, prev: Step, event: Event): Step {
  const run = prev.run!;
  const runBefore = JSON.stringify(run);
  const eventBefore = JSON.stringify(event);
  const next = advance(run, event);
  assert.equal(JSON.stringify(run), runBefore, "advance mutated its run");
  assert.equal(JSON.stringify(event), eventBefore, "advance mutated its event");
  assert.equal(JSON.stringify(advance(JSON.parse(runBefore), event)), JSON.stringify(next), "advance is deterministic");
  const entered = checkTransition(run, event, next);
  checkShape(ctx, next, entered);
  if (next.action.kind === "rewrite") {
    const count = (ctx.rewrites.get(next.action.phase) ?? 0) + 1;
    ctx.rewrites.set(next.action.phase, count);
    assert.ok(count <= MAX_ROUNDS, `phase emits at most MAX_ROUNDS rewrites (${count})`);
    assert.equal(next.action.round, count, "rewrite round counts the phase's rewrites");
  }
  record(run, next);
  return next;
}

function drive(ctx: Ctx, prev: Step, event: Event): Step {
  try {
    return driveInner(ctx, prev, event);
  } catch (cause) {
    throw new Error(`given=${JSON.stringify(ctx.given)} run=${JSON.stringify(prev.run)} event=${JSON.stringify(event)}\n${(cause as Error).message}`, { cause });
  }
}

function begin(given: Phase[]): { ctx: Ctx; step: Step } {
  const ctx: Ctx = { given, rewrites: new Map() };
  const step = start(given);
  const phases = uniq(given);
  assert.deepEqual(step, {
    run: { phases, stage: { kind: "listing" }, round: 0, last: null, stalls: 0 },
    notes: [],
    action: { kind: "list", phase: phases[0] },
  });
  checkShape(ctx, step, false);
  return { ctx, step };
}

// Exhaustive enumeration

const ALPHABET: Event[] = [
  { kind: "listed", files: [] },
  { kind: "listed", files: ["a", "b", "a"] },
  { kind: "scanned", results: [fr("a", 2), fr("b", 1)], failures: [] },
  { kind: "scanned", results: [fr("a", 1)], failures: [] },
  { kind: "scanned", results: [fr("a", 0), fr("b", 0), fr("z", 4)], failures: [{ file: "c", error: "x" }] },
  { kind: "scanned", results: [], failures: [{ file: "a", error: "x" }] },
  { kind: "scanned", results: [fr("a", 1), fr("a", 1), fr("z", 5)], failures: [{ file: "z", error: "x" }] },
  { kind: "scanned", results: [fr("b", 3)], failures: [{ file: "a", error: "x" }] },
  { kind: "rewritten" },
  { kind: "aborted" },
  { kind: "failed", error: "boom" },
];

function walk(ctx: Ctx, step: Step, depth: number): number {
  if (depth === 0 || step.run === null) return 0;
  let nodes = 0;
  for (const event of ALPHABET) {
    const rewrites = new Map(ctx.rewrites);
    const next = drive(ctx, step, event);
    nodes += 1 + walk(ctx, next, depth - 1);
    ctx.rewrites = rewrites;
  }
  return nodes;
}

test("advance: every event sequence to depth 6 -> no invariant violation after any step", () => {
  const { ctx, step } = begin(["own", "own", "cc"]);
  const nodes = walk(ctx, step, 6);
  assert.ok(nodes > 100000, `enumerated ${nodes} steps`);
});

// Seeded random sequences

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOL = ["a", "b", "c", "d", "e"];

function subset(rand: () => number): string[] {
  return POOL.filter(() => rand() < 0.5);
}

function anyEvent(rand: () => number): Event {
  const k = Math.floor(rand() * 3);
  if (k === 0) return { kind: "listed", files: subset(rand) };
  if (k === 1) return { kind: "scanned", results: subset(rand).map((f) => fr(f, Math.floor(rand() * 3))), failures: [] };
  return { kind: "rewritten" };
}

function genEvent(rand: () => number, run: Run, descend: boolean): Event {
  const r = rand();
  if (!descend) {
    if (r < 0.03) return { kind: "aborted" };
    if (r < 0.05) return { kind: "failed", error: `e${Math.floor(rand() * 9)}` };
    if (r < 0.12) return anyEvent(rand);
  }
  switch (run.stage.kind) {
    case "listing": {
      if (!descend && rand() < 0.15) return { kind: "listed", files: [] };
      const files = descend ? POOL : subset(rand);
      if (files.length === 0) return { kind: "listed", files: ["a"] };
      return { kind: "listed", files: rand() < 0.3 ? [...files, files[0]] : files };
    }
    case "scanning": {
      const files = run.stage.files;
      if (descend) return { kind: "scanned", results: [fr(files[0], run.last === null ? 80 : Math.max(1, run.last - 1))], failures: [] };
      const results: FileResult[] = [];
      const failures: ScanFailure[] = [];
      const allZero = rand() < 0.2;
      for (const file of files) {
        const x = rand();
        if (x < 0.55) results.push(fr(file, allZero ? 0 : Math.floor(rand() * 4)));
        else if (x < 0.75) failures.push({ file, error: `x${file}` });
      }
      if (rand() < 0.3) {
        results.push(fr("zz", 3));
        failures.push({ file: "yy", error: "out" });
      }
      if (results.length > 0 && rand() < 0.3) results.push(clone(results[0]));
      return { kind: "scanned", results, failures };
    }
    case "rewriting":
      return !descend && rand() < 0.1 ? anyEvent(rand) : { kind: "rewritten" };
  }
}

function randomPhases(rand: () => number): Phase[] {
  const all: Phase[] = ["own", "cc", "md"];
  return Array.from({ length: 1 + Math.floor(rand() * 5) }, () => all[Math.floor(rand() * 3)]);
}

function sequence(seed: number, steps: number): number {
  const rand = rng(seed);
  const descend = seed % 4 === 0;
  let count = 0;
  while (count < steps) {
    const { ctx, step: first } = begin(randomPhases(rand));
    let step = first;
    while (step.run !== null && count < steps) {
      step = drive(ctx, step, genEvent(rand, step.run, descend));
      count += 1;
    }
  }
  return count;
}

test("advance: 24 seeded random sequences of 1000 steps -> no invariant violation after any step", () => {
  const counts: number[] = [];
  for (let seed = 1; seed <= 24; seed++) counts.push(sequence(seed, 1000));
  assert.deepEqual(counts, Array.from({ length: 24 }, () => 1000));
});

// Round limit

test("advance: strictly falling totals -> MAX_ROUNDS rewrites then round-limit stop", () => {
  const { ctx, step: first } = begin(["own"]);
  let step = drive(ctx, first, { kind: "listed", files: ["a"] });
  let n = 80;
  let last: Step = step;
  while (step.run !== null) {
    last = drive(ctx, step, { kind: "scanned", results: [fr("a", n--)], failures: [] });
    step = last.run !== null ? drive(ctx, last, { kind: "rewritten" }) : last;
  }
  assert.deepEqual(
    { rewrites: ctx.rewrites.get("own"), notes: last.notes },
    { rewrites: MAX_ROUNDS, notes: [{ kind: "stopped", phase: "own", total: 40, rounds: MAX_ROUNDS, reason: "round-limit" }] },
  );
});

// Duplicate failures

test("advance: scanned event with duplicate failure files -> one unscanned note entry per file", () => {
  const dup: ScanFailure = { file: "a", error: "x" };
  const { ctx, step } = begin(["own"]);
  const scanning = drive(ctx, step, { kind: "listed", files: ["a", "b"] });
  const next = advance(scanning.run!, { kind: "scanned", results: [], failures: [dup, { ...dup }, { file: "b", error: "y" }] });
  assert.deepEqual(next.notes, [
    { kind: "unscanned", phase: "own", failures: [dup, { file: "b", error: "y" }] },
    { kind: "clean", phase: "own" },
  ]);
});

// Coverage

test("advance: enumeration and random runs -> each note kind and action kind at least once", () => {
  assert.deepEqual(sorted([...seen]), [
    "aborted",
    "await",
    "clean",
    "empty",
    "failed",
    "noop",
    "rewrite",
    "stopped:round-limit",
    "stopped:stalled",
    "unscanned",
  ]);
});

// parseRun

test("parseRun: valid runs from a table -> same run", () => {
  const runs: Run[] = [
    { phases: ["own"], stage: { kind: "listing" }, round: 0, last: null, stalls: 0 },
    { phases: ["own", "cc", "md"], stage: { kind: "scanning", files: ["a", "b"] }, round: 0, last: null, stalls: 0 },
    { phases: ["cc", "md"], stage: { kind: "rewriting", files: ["a"] }, round: 7, last: 12, stalls: 1 },
    { phases: ["md"], stage: { kind: "scanning", files: ["a"] }, round: MAX_ROUNDS, last: 3, stalls: 0 },
  ];
  assert.deepEqual(runs.map((run) => parseRun(clone(run))), runs);
});

test("parseRun: malformed inputs -> null", () => {
  const good = { phases: ["own"], stage: { kind: "scanning", files: ["a"] }, round: 1, last: 2, stalls: 0 };
  const inputs: unknown[] = [
    null,
    undefined,
    5,
    "run",
    true,
    {},
    { ...good, phases: [] },
    { ...good, phases: "own" },
    { ...good, phases: ["zzz"] },
    { ...good, phases: ["own", "own"] },
    { ...good, phases: [1] },
    { ...good, stage: null },
    { ...good, stage: { kind: "bogus" } },
    { ...good, stage: { kind: "listing", files: ["a"] }, round: -1 },
    { ...good, stage: { kind: "scanning" } },
    { ...good, stage: { kind: "scanning", files: "a" } },
    { ...good, stage: { kind: "scanning", files: [1] } },
    { ...good, stage: { kind: "rewriting" } },
    { ...good, stage: { kind: "rewriting", files: [null] } },
    { ...good, round: -1 },
    { ...good, round: 1.5 },
    { ...good, round: MAX_ROUNDS + 1 },
    { ...good, round: "1" },
    { ...good, round: undefined },
    { ...good, last: -1 },
    { ...good, last: "x" },
    { ...good, last: undefined },
    { ...good, stalls: -1 },
    { ...good, stalls: MAX_STALLS },
    { ...good, stalls: "0" },
    { ...good, stalls: undefined },
  ];
  assert.deepEqual(inputs.map((input) => parseRun(input)), inputs.map(() => null));
});
