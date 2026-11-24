import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { accepts, appendAccept, loadAccept, loadShown, normalize, type AcceptList, type AcceptEntry, type ShownFinding } from "./accept.ts";
import { projectRoot } from "./store.ts";

export const DECISIONS = ["Rewrite finding", "Accept text", "Accept rule for repo"] as const;
export type Decision = (typeof DECISIONS)[number];
export const MAX_REVIEW = 10;
const EXCERPT_LIMIT = 160;

export interface ReviewForm {
  message: string;
  requestedSchema: {
    type: "object";
    properties: Record<string, { type: "string"; title: string; description: string; enum: Decision[]; default?: Decision }>;
  };
}

export type ReviewAnswer =
  | { kind: "answered"; entries: AcceptEntry[]; rewrite: ShownFinding[] }
  | { kind: "declined" }
  | { kind: "cancelled" }
  | { kind: "invalid"; reason: string };

export interface ReviewSelection {
  items: ShownFinding[];
  unknown: string[];
  rest: string[];
}

const excerpt = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_LIMIT ? `${flat.slice(0, EXCERPT_LIMIT - 3)}...` : flat;
};

export function fieldTitle(item: ShownFinding): string {
  const places = item.count > 1 ? `, ${item.count} places` : "";
  return `${item.place || "finding"} ${item.ruleId}${places}`;
}

const shownInFull = (item: ShownFinding): boolean => {
  const flat = normalize(item.text);
  return flat.length > 0 && flat.length <= EXCERPT_LIMIT;
};

// Choices for one finding with Accept text only for a nonempty text that the form shows in full.
export function choicesFor(item: ShownFinding): Decision[] {
  return shownInFull(item) ? [...DECISIONS] : DECISIONS.filter((decision) => decision !== "Accept text");
}

export function fieldDescription(item: ShownFinding): string {
  const label = shownInFull(item) ? "Text" : "Text, first part";
  return [item.message, `${label}: ${excerpt(item.text)}`].filter(Boolean).join(" ");
}

export function selectItems(shown: Map<string, ShownFinding>, ids: readonly string[] | undefined, accepted: AcceptList): ReviewSelection {
  const wanted = ids && ids.length > 0 ? [...new Set(ids)] : [...shown.keys()];
  const unknown = wanted.filter((id) => !shown.has(id));
  const open = wanted.flatMap((id) => shown.get(id) ?? []).filter((item) => !accepts(accepted, item.ruleId, item.text));
  return { items: open.slice(0, MAX_REVIEW), unknown, rest: open.slice(MAX_REVIEW).map((item) => item.id) };
}

export function reviewForm(items: readonly ShownFinding[], root: string, defaults: boolean): ReviewForm {
  const properties: ReviewForm["requestedSchema"]["properties"] = {};
  for (const item of items) {
    properties[item.id] = { type: "string", title: fieldTitle(item), description: fieldDescription(item), enum: choicesFor(item), ...(defaults ? { default: "Rewrite finding" as const } : {}) };
  }
  return { message: `slopnuke findings in ${root}`, requestedSchema: { type: "object", properties } };
}

export function parseReviewAnswer(items: readonly ShownFinding[], response: unknown): ReviewAnswer {
  const action = (response as { action?: unknown } | null)?.action;
  if (action === "decline") return { kind: "declined" };
  if (action === "cancel") return { kind: "cancelled" };
  if (action !== "accept") return { kind: "invalid", reason: "the response has no accept, decline or cancel action" };
  const content = (response as { content?: unknown }).content;
  if (content === null || typeof content !== "object" || Array.isArray(content)) return { kind: "invalid", reason: "the accepted response has no form content" };
  const entries: AcceptEntry[] = [];
  const rewrite: ShownFinding[] = [];
  for (const item of items) {
    const value = (content as Record<string, unknown>)[item.id] ?? "Rewrite finding";
    const choices = choicesFor(item);
    if (typeof value !== "string" || !(choices as string[]).includes(value)) return { kind: "invalid", reason: `the answer for ${item.id} is not one of ${choices.join(", ")}` };
    if (value === "Accept text") entries.push({ ruleId: item.ruleId, text: item.text });
    else if (value === "Accept rule for repo") entries.push({ ruleId: item.ruleId, text: null });
    else rewrite.push(item);
  }
  return { kind: "answered", entries, rewrite };
}

export type ReviewRepo = { kind: "repo"; root: string } | { kind: "invalid"; reason: string };

export function parseRepo(value: unknown): ReviewRepo {
  if (typeof value !== "string" || !isAbsolute(value)) return { kind: "invalid", reason: "repo must be an absolute path" };
  try {
    if (!statSync(value).isDirectory()) return { kind: "invalid", reason: `${value} is not a directory` };
  } catch {
    return { kind: "invalid", reason: `${value} does not exist` };
  }
  return { kind: "repo", root: projectRoot(value) };
}

const listLine = (item: ShownFinding): string => `  [${item.id}] ${fieldTitle(item)}: ${excerpt(item.text)}`;

export interface ReviewResult {
  text: string;
  error: boolean;
}

// One review round through a host question function with accept list writes only on an accepted answer.
export interface ReviewHost {
  ask: ((form: ReviewForm) => Promise<unknown>) | null;
  defaults: boolean;
  acceptCommand: string;
}

export async function runReview(repo: unknown, ids: readonly string[] | undefined, host: ReviewHost): Promise<ReviewResult> {
  const parsed = parseRepo(repo);
  if (parsed.kind === "invalid") return { text: `slopnuke review: ${parsed.reason}`, error: true };
  const selection = selectItems(loadShown(parsed.root), ids, loadAccept(parsed.root));
  const unknownLine = selection.unknown.length > 0 ? [`slopnuke review: no finding with id ${selection.unknown.join(", ")} in the last round of ${parsed.root}`] : [];
  if (selection.items.length === 0) return { text: [...unknownLine, `slopnuke review: no findings to review in ${parsed.root}`].join("\n"), error: selection.unknown.length > 0 };
  if (host.ask === null) {
    return {
      text: [
        ...unknownLine,
        "slopnuke review: this client has no form support. Ask the user about each finding in chat.",
        ...selection.items.map(listLine),
        `For each finding that the user approves with no change, run: ${host.acceptCommand} <id>`,
      ].join("\n"),
      error: false,
    };
  }
  const answer = parseReviewAnswer(selection.items, await host.ask(reviewForm(selection.items, parsed.root, host.defaults)));
  const restLine = selection.rest.length > 0 ? [`slopnuke review: ${selection.rest.length} more finding(s) need a decision. Call review again with ids ${selection.rest.join(" ")}.`] : [];
  switch (answer.kind) {
    case "declined":
      return { text: [...unknownLine, "slopnuke review: the user declined the review. Rewrite the findings."].join("\n"), error: false };
    case "cancelled":
      return { text: [...unknownLine, "slopnuke review: the user closed the review with no answer. Rewrite the findings or ask in chat."].join("\n"), error: false };
    case "invalid":
      return { text: [...unknownLine, `slopnuke review: ${answer.reason}. The accept list has no change.`].join("\n"), error: true };
    case "answered": {
      const added = answer.entries.length > 0 ? appendAccept(parsed.root, answer.entries) : [];
      return {
        text: [
          ...unknownLine,
          ...added.map((line) => `slopnuke review: accepted ${line}`),
          answer.rewrite.length > 0 ? "slopnuke review: the user wants these findings rewritten:" : "slopnuke review: no findings to rewrite.",
          ...answer.rewrite.map(listLine),
          ...restLine,
          answer.rewrite.length > 0 ? "Rewrite those findings, then run the slopnuke next command." : "Run the slopnuke next command.",
        ].join("\n"),
        error: false,
      };
    }
  }
}
