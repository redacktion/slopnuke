// Profile and word list settings from the user config file and the repo config file.

import { PROFILE_SLOPSIFT_OFF } from "./contract.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BANNED_PHRASES, DATA_NOUNS, DEFAULT_ACTORS, DEFAULT_INTENT_VERBS, GENERIC_BANNED_WORDS, HOUSE_RULE_IDS, PERSONAL_BANNED_WORDS, type HouseSettings, type Lexicon } from "./house.ts";
import { stateHome } from "./store.ts";

export const REPO_CONFIG = ".slopnuke.json";
export const PROFILES = ["standard", "actor-first"] as const;
export type Profile = (typeof PROFILES)[number];
export const SCOPES = ["md", "cc", "code", "tests"] as const;
export type Scope = (typeof SCOPES)[number];
type Level = "off" | "warn";
export type RuleSetting = Level | Partial<Record<Scope, Level>>;

export const CODE_RULE_IDS = ["slopnuke/test-name-format", "slopnuke/ui-tone", "slopnuke/identifier-word"] as const;
const STANDARD_RULES = ["slopnuke/banned-word", "slopnuke/banned-phrase"];
const PROFILE_RULES: Record<Profile, readonly string[]> = {
  standard: STANDARD_RULES,
  "actor-first": [...HOUSE_RULE_IDS, ...CODE_RULE_IDS],
};

const RULE_ID = /^[a-z0-9-]+\/[a-z0-9-]+$/;
const CALL_NAME = /^\.?[A-Za-z_][\w.]*$/;
const LIST_KEYS = ["bannedWords", "allowedWords", "bannedPhrases", "allowedPhrases", "dataNouns", "actorNouns", "terms", "intentVerbs"] as const;
type ListKey = (typeof LIST_KEYS)[number];

export interface ConfigLayer {
  profile?: Profile;
  rules?: Record<string, RuleSetting>;
  ignore?: string[];
  descriptionCalls?: string[];
  lists: Partial<Record<ListKey, string[]>>;
}

export interface ScopeRules {
  enabled: Set<string>;
  slopsiftOff: string[];
}

export interface Settings {
  profile: Profile;
  scopes: Record<Scope, ScopeRules>;
  lexicon: Lexicon;
  ignorePatterns: string[];
  ignore: (relativePath: string) => boolean;
  descriptionCalls: string[];
  hash: string;
}

export interface ScopedSettings extends HouseSettings {
  slopsiftOff: string[];
}

export const forScope = (settings: Settings, scope: Scope): ScopedSettings => ({ lexicon: settings.lexicon, ...settings.scopes[scope] });

// Config module error for unreadable or malformed config files.
export class ConfigError extends Error {}

const isLevel = (value: unknown): value is Level => value === "off" || value === "warn";

function parseRuleSetting(value: unknown, id: string, source: string): RuleSetting {
  if (isLevel(value)) return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ConfigError(`${source}: rules.${id} is not "off", "warn" or an object of scopes`);
  const scoped: Partial<Record<Scope, Level>> = {};
  for (const [scope, level] of Object.entries(value)) {
    if (!(SCOPES as readonly string[]).includes(scope)) throw new ConfigError(`${source}: rules.${id}.${scope} is not one of ${SCOPES.join(", ")}`);
    if (!isLevel(level)) throw new ConfigError(`${source}: rules.${id}.${scope} is not "off" or "warn"`);
    scoped[scope as Scope] = level;
  }
  return scoped;
}

export function parseConfigLayer(text: string, source: string): ConfigLayer {
  let value: any;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${source}: ${(error as Error).message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ConfigError(`${source}: the config is not a JSON object`);
  const layer: ConfigLayer = { lists: {} };
  for (const [key, entry] of Object.entries<any>(value)) {
    if (key === "$schema") continue;
    if (key === "profile") {
      if (!PROFILES.includes(entry)) throw new ConfigError(`${source}: profile is not one of ${PROFILES.join(", ")}`);
      layer.profile = entry;
    } else if (key === "rules") {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new ConfigError(`${source}: rules is not an object`);
      const rules: Record<string, RuleSetting> = {};
      for (const [id, setting] of Object.entries<unknown>(entry)) {
        if (!RULE_ID.test(id)) throw new ConfigError(`${source}: rules key ${id} is not a rule id`);
        rules[id] = parseRuleSetting(setting, id, source);
      }
      layer.rules = rules;
    } else if (key === "ignore") {
      if (!Array.isArray(entry) || !entry.every((item) => typeof item === "string" && item.trim().length > 0)) throw new ConfigError(`${source}: ignore is not a list of nonempty strings`);
      const bad = entry.find((item: string) => item.trim().startsWith("!"));
      if (bad !== undefined) throw new ConfigError(`${source}: ignore pattern ${bad} uses "!", which slopnuke does not support`);
      layer.ignore = entry.map((item: string) => item.trim());
    } else if (key === "descriptionCalls") {
      if (!Array.isArray(entry) || !entry.every((item) => typeof item === "string" && CALL_NAME.test(item.trim()))) throw new ConfigError(`${source}: descriptionCalls is not a list of call names such as ".help" or "Setting"`);
      layer.descriptionCalls = entry.map((item: string) => item.trim());
    } else if ((LIST_KEYS as readonly string[]).includes(key)) {
      if (!Array.isArray(entry) || !entry.every((item) => typeof item === "string" && item.trim().length > 0)) throw new ConfigError(`${source}: ${key} is not a list of nonempty strings`);
      layer.lists[key as ListKey] = entry.map((item: string) => item.trim().toLowerCase());
    } else {
      throw new ConfigError(`${source}: unknown key ${key}`);
    }
  }
  return layer;
}

const phrasePattern = (phrases: Iterable<string>): RegExp | null => {
  const list = [...phrases];
  if (list.length === 0) return null;
  return new RegExp(`\\b(?:${list.map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "['’]")).join("|")})\\b`, "gi");
};

// Gitignore-style glob to a path regex where a match on a directory also covers every path under it.
export function globToPathRegExp(pattern: string): RegExp {
  let body = pattern.replace(/\/+$/, "");
  const anchored = body.startsWith("/") || body.includes("/");
  body = body.replace(/^\/+/, "");
  const source = body
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\/\*\*$/g, "\u0001")
    .replace(/\*\*/g, "\u0002")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, "(?:/.*)?")
    .replace(/\u0002/g, ".*");
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${source}(?:/.*)?$`);
}

// Inflected forms of configured verbs for the animate-subject rule.
function verbForms(verb: string): string[] {
  const forms = [verb];
  if (verb.endsWith("s") || verb.endsWith("ed")) return forms;
  forms.push(verb.endsWith("y") ? `${verb.slice(0, -1)}ies` : /(?:s|x|z|ch|sh)$/.test(verb) ? `${verb}es` : `${verb}s`);
  forms.push(verb.endsWith("e") ? `${verb}d` : verb.endsWith("y") ? `${verb.slice(0, -1)}ied` : `${verb}ed`);
  return forms;
}

// Later layers override the profile and per-rule levels and extend every list.
export function resolveSettings(layers: readonly ConfigLayer[]): Settings {
  const profile = layers.reduce<Profile>((current, layer) => layer.profile ?? current, "standard");
  const levels = new Map<string, Partial<Record<Scope, Level>>>();
  const lists = Object.fromEntries(LIST_KEYS.map((key) => [key, new Set<string>()])) as Record<ListKey, Set<string>>;
  const ignorePatterns: string[] = [];
  const descriptionCalls: string[] = [];
  for (const layer of layers) {
    for (const [id, setting] of Object.entries(layer.rules ?? {})) {
      const current = levels.get(id) ?? {};
      const next = typeof setting === "string" ? Object.fromEntries(SCOPES.map((scope) => [scope, setting])) : setting;
      levels.set(id, { ...current, ...next });
    }
    for (const key of LIST_KEYS) for (const item of layer.lists[key] ?? []) lists[key].add(item);
    for (const pattern of layer.ignore ?? []) if (!ignorePatterns.includes(pattern)) ignorePatterns.push(pattern);
    for (const call of layer.descriptionCalls ?? []) if (!descriptionCalls.includes(call)) descriptionCalls.push(call);
  }
  const scopes = Object.fromEntries(
    SCOPES.map((scope) => {
      const enabled = new Set(PROFILE_RULES[profile]);
      const slopsiftOff = new Set(PROFILE_SLOPSIFT_OFF[profile]);
      for (const [id, byScope] of levels) {
        const level = byScope[scope];
        if (level === undefined) continue;
        if (!id.startsWith("slopnuke/")) {
          if (level === "off") slopsiftOff.add(id);
          else slopsiftOff.delete(id);
        } else if (level === "off") enabled.delete(id);
        else enabled.add(id);
      }
      return [scope, { enabled, slopsiftOff: [...slopsiftOff].sort() }];
    }),
  ) as Record<Scope, ScopeRules>;
  const banned = new Set([...GENERIC_BANNED_WORDS, ...(profile === "actor-first" ? PERSONAL_BANNED_WORDS : []), ...lists.bannedWords]);
  for (const word of lists.allowedWords) banned.delete(word);
  const phrases = new Set([...BANNED_PHRASES, ...lists.bannedPhrases]);
  for (const phrase of lists.allowedPhrases) phrases.delete(phrase);
  const dataNouns = new Set([...DATA_NOUNS, ...lists.dataNouns]);
  for (const noun of lists.actorNouns) dataNouns.delete(noun);
  const intentVerbs = new Set([...DEFAULT_INTENT_VERBS, ...[...lists.intentVerbs].flatMap(verbForms)]);
  const actorNouns = new Set([...DEFAULT_ACTORS, ...lists.actorNouns]);
  const lexicon: Lexicon = { bannedWords: banned, phrases: phrasePattern(phrases), dataNouns, actorNouns, terms: lists.terms, intentVerbs };
  const matchers = ignorePatterns.map(globToPathRegExp);
  const canonical = JSON.stringify({
    profile,
    scopes: SCOPES.map((scope) => [scope, [...scopes[scope].enabled].sort(), scopes[scope].slopsiftOff]),
    banned: [...banned].sort(),
    phrases: [...phrases].sort(),
    dataNouns: [...dataNouns].sort(),
    actorNouns: [...actorNouns].sort(),
    intentVerbs: [...intentVerbs].sort(),
    terms: [...lists.terms].sort(),
    descriptionCalls: [...descriptionCalls].sort(),
  });
  return {
    profile,
    scopes,
    lexicon,
    ignorePatterns,
    ignore: (relativePath) => matchers.some((matcher) => matcher.test(relativePath)),
    descriptionCalls,
    hash: createHash("sha256").update(canonical).digest("hex").slice(0, 16),
  };
}

function readLayer(file: string): ConfigLayer | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError(`${file}: ${(error as Error).message}`);
  }
  return parseConfigLayer(text, file);
}

export const userConfigFile = (): string => join(stateHome(), "config.json");

export function loadSettings(root: string): Settings {
  const layers = [readLayer(userConfigFile()), readLayer(join(root, REPO_CONFIG))].filter((layer): layer is ConfigLayer => layer !== null);
  return resolveSettings(layers);
}
