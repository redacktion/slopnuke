// Run state machine for one slopnuke sweep.

export type Phase = "own" | "cc" | "md" | "code" | "tests";

export const PHASES: readonly Phase[] = ["own", "cc", "md", "code", "tests"];
export const MAX_ROUNDS = 40;
export const MAX_STALLS = 2;

export interface Finding {
  line: number;
  column: number;
  ruleId: string;
  message: string;
  text: string;
}

export interface FileResult {
  file: string;
  findings: Finding[];
}

export interface ScanFailure {
  file: string;
  error: string;
}

export type Stage =
  | { kind: "listing" }
  | { kind: "scanning"; files: string[] }
  | { kind: "rewriting"; files: string[] };

export interface Run {
  phases: Phase[];
  stage: Stage;
  round: number;
  last: number | null;
  stalls: number;
}

export type Event =
  | { kind: "listed"; files: string[] }
  | { kind: "scanned"; results: FileResult[]; failures: ScanFailure[] }
  | { kind: "rewritten" }
  | { kind: "aborted" }
  | { kind: "failed"; error: string };

export type Note =
  | { kind: "empty"; phase: Phase }
  | { kind: "clean"; phase: Phase }
  | { kind: "stopped"; phase: Phase; total: number; rounds: number; reason: "stalled" | "round-limit" }
  | { kind: "unscanned"; phase: Phase; failures: ScanFailure[] }
  | { kind: "aborted" }
  | { kind: "failed"; error: string };

export type Action =
  | { kind: "list"; phase: Phase }
  | { kind: "scan"; phase: Phase; files: string[]; round: number }
  | { kind: "rewrite"; phase: Phase; round: number; results: FileResult[]; total: number }
  | { kind: "await"; phase: Phase; round: number }
  | { kind: "finish" };

export interface Step {
  run: Run | null;
  notes: Note[];
  action: Action;
}

function fresh(phases: Phase[]): Run {
  return { phases, stage: { kind: "listing" }, round: 0, last: null, stalls: 0 };
}

function idle(run: Run): Action {
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

function stay(run: Run): Step {
  return { run, notes: [], action: idle(run) };
}

function move(run: Run, notes: Note[] = []): Step {
  return { run, notes, action: idle(run) };
}

function endPhase(run: Run, notes: Note[]): Step {
  const phases = run.phases.slice(1);
  if (phases.length === 0) return { run: null, notes, action: { kind: "finish" } };
  return move(fresh(phases), notes);
}

function unique(files: string[]): string[] {
  return [...new Set(files)];
}

export function start(phases: readonly Phase[]): Step {
  const ordered = unique([...phases]) as Phase[];
  if (ordered.length === 0) throw new Error("slopnuke: start needs at least one phase");
  return move(fresh(ordered));
}

export function advance(run: Run, event: Event): Step {
  if (run.phases.length === 0) throw new Error("slopnuke: run with no phases");
  const phase = run.phases[0];
  switch (event.kind) {
    case "aborted":
      return { run: null, notes: [{ kind: "aborted" }], action: { kind: "finish" } };
    case "failed":
      return { run: null, notes: [{ kind: "failed", error: event.error }], action: { kind: "finish" } };
    case "listed": {
      if (run.stage.kind !== "listing") return stay(run);
      const files = unique(event.files);
      if (files.length === 0) return endPhase(run, [{ kind: "empty", phase }]);
      return move({ ...run, stage: { kind: "scanning", files } });
    }
    case "scanned": {
      if (run.stage.kind !== "scanning") return stay(run);
      const scanned = new Set(run.stage.files);
      const seen = new Set<string>();
      const results: FileResult[] = [];
      for (const result of event.results) {
        if (!scanned.has(result.file) || seen.has(result.file) || result.findings.length === 0) continue;
        seen.add(result.file);
        results.push(result);
      }
      const failures: ScanFailure[] = [];
      for (const failure of event.failures) {
        if (!scanned.has(failure.file) || seen.has(failure.file)) continue;
        seen.add(failure.file);
        failures.push(failure);
      }
      const notes: Note[] = failures.length > 0 ? [{ kind: "unscanned", phase, failures }] : [];
      const total = results.reduce((sum, result) => sum + result.findings.length, 0);
      if (total === 0) return endPhase(run, [...notes, { kind: "clean", phase }]);
      const stalls = run.last !== null && total >= run.last ? run.stalls + 1 : 0;
      if (stalls >= MAX_STALLS || run.round >= MAX_ROUNDS) {
        const reason = stalls >= MAX_STALLS ? "stalled" : "round-limit";
        return endPhase(run, [...notes, { kind: "stopped", phase, total, rounds: run.round, reason }]);
      }
      const next: Run = { ...run, stage: { kind: "rewriting", files: results.map((result) => result.file) }, round: run.round + 1, last: total, stalls };
      return { run: next, notes, action: { kind: "rewrite", phase, round: next.round, results, total } };
    }
    case "rewritten": {
      if (run.stage.kind !== "rewriting") return stay(run);
      return move({ ...run, stage: { kind: "scanning", files: run.stage.files } });
    }
  }
}

const isPhase = (value: unknown): value is Phase => (PHASES as readonly unknown[]).includes(value);
const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
const isPaths = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");

function parseStage(value: any): Stage | null {
  if (value?.kind === "listing") return { kind: "listing" };
  if ((value?.kind === "scanning" || value?.kind === "rewriting") && isPaths(value.files)) return { kind: value.kind, files: [...value.files] };
  return null;
}

export function parseRun(value: any): Run | null {
  if (value === null || typeof value !== "object") return null;
  const { phases, round, last, stalls } = value;
  if (!Array.isArray(phases) || phases.length === 0 || !phases.every(isPhase) || new Set(phases).size !== phases.length) return null;
  const stage = parseStage(value.stage);
  if (!stage || !isCount(round) || round > MAX_ROUNDS || !isCount(stalls) || stalls >= MAX_STALLS) return null;
  if (last !== null && !isCount(last)) return null;
  return { phases: [...phases], stage, round, last, stalls };
}
