import { advance, type FileResult, type Note, type Phase, type ScanFailure, type Step } from "./run.ts";

export interface Host {
  list(phase: Phase): Promise<string[]>;
  scan(phase: Phase, files: string[], round: number): Promise<{ results: FileResult[]; failures: ScanFailure[] }>;
  note(note: Note): void;
}

const message = (error: unknown): string => String((error as Error)?.message ?? error).slice(0, 400);

// Action loop for list and scan steps up to a rewrite or the end of the run.
export async function drive(initial: Step, host: Host): Promise<Step> {
  let step = initial;
  for (;;) {
    for (const note of step.notes) host.note(note);
    const { run, action } = step;
    if (run === null || action.kind === "rewrite" || action.kind === "await" || action.kind === "finish") return { ...step, notes: [] };
    try {
      if (action.kind === "list") step = advance(run, { kind: "listed", files: await host.list(action.phase) });
      else step = advance(run, { kind: "scanned", ...(await host.scan(action.phase, action.files, action.round)) });
    } catch (error) {
      step = advance(run, { kind: "failed", error: message(error) });
    }
  }
}
