import { createHash, randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptLock, shownFile, withLock, writePrivate } from "./store.ts";

export const ACCEPT_FILE = ".slopnuke-accept";
const RULE_ID = /^[a-z0-9-]+\/[a-z0-9-]+$/;
const ID = /^[0-9a-f]{10}$/;
const HEADER = "# slopnuke accept list. One entry per line: <rule> for the whole rule, or <rule> <flagged text>.\n";

export interface AcceptList {
  rules: Set<string>;
  texts: Set<string>;
}

export interface AcceptEntry {
  ruleId: string;
  text: string | null;
}

export const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();
const key = (ruleId: string, text: string): string => `${ruleId}\0${normalize(text)}`;

export function fingerprint(ruleId: string, text: string): string {
  return createHash("sha256").update(key(ruleId, text)).digest("hex").slice(0, 10);
}

export function parseAccept(text: string): AcceptList {
  const list: AcceptList = { rules: new Set(), texts: new Set() };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const [ruleId, ...rest] = line.split(/\s+/);
    if (!RULE_ID.test(ruleId)) continue;
    if (rest.length === 0) list.rules.add(ruleId);
    else list.texts.add(key(ruleId, rest.join(" ")));
  }
  return list;
}

export function accepts(list: AcceptList, ruleId: string, text: string): boolean {
  return list.rules.has(ruleId) || list.texts.has(key(ruleId, text));
}

export const formatEntry = (entry: AcceptEntry): string => (entry.text === null ? entry.ruleId : `${entry.ruleId} ${normalize(entry.text)}`);

const acceptPath = (root: string): string => join(root, ACCEPT_FILE);

function readAccept(root: string): string {
  try {
    return readFileSync(acceptPath(root), "utf8");
  } catch {
    return "";
  }
}

export const loadAccept = (root: string): AcceptList => parseAccept(readAccept(root));

// Append of new entries to the repo accept file through a temp file and rename.
export function appendAccept(root: string, entries: AcceptEntry[]): string[] {
  const file = acceptPath(root);
  return withLock(acceptLock(root), () => {
    const current = readAccept(root);
    const list = parseAccept(current);
    const added: string[] = [];
    for (const entry of entries) {
      if (entry.text !== null && normalize(entry.text) === "") continue;
      const already = entry.text === null ? list.rules.has(entry.ruleId) : accepts(list, entry.ruleId, entry.text);
      if (already) continue;
      if (entry.text === null) list.rules.add(entry.ruleId);
      else list.texts.add(key(entry.ruleId, entry.text));
      added.push(formatEntry(entry));
    }
    if (added.length === 0) return added;
    const base = current.length === 0 ? HEADER : current.endsWith("\n") ? current : `${current}\n`;
    const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temp, `${base}${added.join("\n")}\n`, { mode: 0o644 });
    renameSync(temp, file);
    return added;
  });
}

export interface ShownFinding {
  id: string;
  ruleId: string;
  text: string;
  place: string;
  message: string;
  count: number;
}

export function saveShown(root: string, shown: ShownFinding[]): void {
  writePrivate(shownFile(root), JSON.stringify(Object.fromEntries(shown.map(({ id, ...entry }) => [id, entry]))));
}

export function loadShown(root: string): Map<string, ShownFinding> {
  const shown = new Map<string, ShownFinding>();
  try {
    const value = JSON.parse(readFileSync(shownFile(root), "utf8"));
    for (const [id, entry] of Object.entries<any>(value ?? {})) {
      if (!ID.test(id) || typeof entry?.ruleId !== "string" || !RULE_ID.test(entry.ruleId) || typeof entry.text !== "string") continue;
      const count = Number.isInteger(entry.count) && entry.count > 0 ? entry.count : 1;
      shown.set(id, { id, ruleId: entry.ruleId, text: entry.text, place: typeof entry.place === "string" ? entry.place : "", message: typeof entry.message === "string" ? entry.message : "", count });
    }
  } catch {}
  return shown;
}

export type AcceptRequest = { kind: "ids"; ids: string[] } | { kind: "rule"; entry: AcceptEntry } | { kind: "invalid" };

export function parseAcceptArgs(args: string[]): AcceptRequest {
  if (args.length === 0) return { kind: "invalid" };
  if (RULE_ID.test(args[0])) return { kind: "rule", entry: { ruleId: args[0], text: args.length > 1 ? args.slice(1).join(" ") : null } };
  return args.every((arg) => ID.test(arg)) ? { kind: "ids", ids: args } : { kind: "invalid" };
}

export interface AcceptOutcome {
  added: string[];
  unknown: string[];
}

export function acceptRequest(root: string, request: Exclude<AcceptRequest, { kind: "invalid" }>): AcceptOutcome {
  if (request.kind === "rule") return { added: appendAccept(root, [request.entry]), unknown: [] };
  const shown = loadShown(root);
  const unknown = request.ids.filter((id) => !shown.has(id));
  const entries = request.ids.flatMap((id) => {
    const entry = shown.get(id);
    return entry ? [{ ruleId: entry.ruleId, text: entry.text }] : [];
  });
  return { added: entries.length > 0 ? appendAccept(root, entries) : [], unknown };
}
