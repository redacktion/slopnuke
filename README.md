# Slopnuke

You wake up, check your social feed and see that models are now solving Millennium problems - "Wow," you say, "..how can that be? I can't even get this SOTA model that I use to build things to not narrate LOTR to me in code!"

Those days are now behind you.

Slopnuke, built off of Slopsift with some extra sauce underneath the hood, allows even Deepseek v4.1 Flash to de-slop your repo - after scanning, it flags writing patterns that language models love to overuse: stock words, hedges, giving agency to inanimate objects, narrating prose as code, wandering narration - then triggers a run that presents the findings to your coding agent as a rewrite task. 

After the agent rewrites the flagged text, Slopnuke scans the files again, and triggers another turn until they are clean. 

It works in Pi, Claude Code and Codex - all on your machine with no API calls; after months of experimentation, Slopnuke seems to work best when you start a run via the / commands below targeting what you want, then invoke a /goal (or its equivalent) stating the following:

"You will complete this goal when all Slopnuke findings are rewritten all output that each scan finds. Under no circumstances will an accept_id be added for findings unless the user explicitly approves them."

Point your agent of choice at this repo, have it install it, reload your plugins/extensions, fire off a run aimed at the slop that most annoys you - then watch in awe as SOTA models magically remember how to write coherent code comments, test cases, UI labels, and documentation!

## Scopes

| Scope | Pi command | Claude Code skill | Codex skill | Files |
|---|---|---|---|---|
| Comments and markdown | `/slopnuke` | `/slopnuke:slopnuke` | `$slopnuke:slopnuke` | code comments, then `.md` and `.mdx` files, under the working directory |
| Edited files | `/slopnuke-edited` | `/slopnuke:slopnuke-edited` | `$slopnuke:slopnuke-edited` | every file with an agent edit after the last clean scan of that file |
| Code comments | `/slopnuke-cc` | `/slopnuke:slopnuke-cc` | `$slopnuke:slopnuke-cc` | comments in source files under the working directory |
| Markdown | `/slopnuke-md` | `/slopnuke:slopnuke-md` | `$slopnuke:slopnuke-md` | `.md` and `.mdx` files under the working directory |
| Code strings and names | `/slopnuke-code` | `/slopnuke:slopnuke-code` | `$slopnuke:slopnuke-code` | error and log messages, UI strings and declared identifiers in code files under the working directory |
| Test names | `/slopnuke-tests` | `/slopnuke:slopnuke-tests` | `$slopnuke:slopnuke-tests` | test names and test group names in code files under the working directory |
| All | `/slopnuke-all` | `/slopnuke:slopnuke-all` | `$slopnuke:slopnuke-all` | code comments, markdown, code strings and names, then test names, under the working directory |

## Rules

Slopnuke runs the SlopSift `ai-style` and `reader-first` rulepacks, plus its own `slopnuke` rulepack, which reads the dependency parse of each sentence and also checks markdown table cells, amongst other things detailed below. 

With the `standard` profile, Slopnuke runs `slopnuke/banned-word` and `slopnuke/banned-phrase` with a generic AI word list. If selected, the `actor-first` profile runs every `slopnuke` rule and also bans intensifiers.

| Rule | Flags | Examples |
|---|---|---|
| `slopnuke/inanimate-subject` | data noun, a process noun such as registration, or a code value after a determiner, as the subject of an action verb | `the request waits`, ``its `token` names`` |
| `slopnuke/agentless-passive` | passive verb or participle clause with no actor | `a result is named`, `once granted` |
| `slopnuke/participle-after-noun` | participle phrase after a noun | `a group led by the owner`, `files written by the hook` |
| `slopnuke/figurative-verb` | figurative verb for a result | `lands`, `carries`, `earns`, `reaches`, `crawls`, `leads`, `sits on`, `belongs to`, `closes in` |
| `slopnuke/banned-word` | word from the ban list | `delve`, `leverage`, `seamless`, `myriad`, `meticulous`, `hold` |
| `slopnuke/banned-phrase` | stock phrase | `it's worth noting`, `at its core`, `when it comes to` |
| `slopnuke/arrow` | unicode arrow in prose | `→`, `⇒` |
| `slopnuke/written-mark` | mark that people write but never say aloud: a semicolon, a slash pair of words, `e.g.`, `i.e.` or `etc.`. Slash pairs of acronyms such as TCP/IP and text in code spans pass | `read/edit`, `; the client waits` |
| `slopnuke/repeated-subject` | two sentences in a row with the same opening subject | `The server starts at boot. The server reads the config.` |
| `slopnuke/choppy-run` | four or more sentences of 10 words or fewer in a row, with no link word | `The server starts. It reads the config. It opens a socket. It waits.` |
| `slopnuke/island-sentence` | a sentence with no content word in common with the two sentences on either side of it, and with no back reference at the start of it | `Section 14 is the document index.` after a paragraph about a number store |
| `slopnuke/stilted-negation` | verb with a "no" object | `runs no tests`, `sends no reply` |
| `slopnuke/unrelated-join` | an and or while between two full clauses without a content word in common | `The parser builds a tree, and users open a settings window.` |
| `slopnuke/thing-possessive` | its, their or 's with a data noun as the nearest noun before it, which turns one thing into the owner of another | `the config and its policy file`, `the file's owner` |
| `slopnuke/missing-object` | a transitive verb such as `edit`, `write`, `read`, `check`, `pass` or `verify` with no object | `The worker edits in a git worktree.` |
| `slopnuke/vague-verb` | `keep`, `handle`, `manage`, `maintain`, `ensure`, `facilitate`, `utilize`, `own` and `possess`, with a literal verb in the message for each | `Users keep their keys in the agent.` |
| `slopnuke/animate-subject` | a subject other than a person with a verb of intent or cognition, such as `tries`, `learns`, `decides`, `chooses`, `knows` or `finds`. In a doc comment, a component noun with an action verb: an `-er` or `-or` noun, or a noun such as engine, pipeline, gate, model or kernel, unless the noun is an actor | `The profiler finds a slow function.`, `The converter chooses the output format.`, `The pipeline transforms each record.` |

Slopnuke drops its own findings inside double quotes, for ease of flagging/comparison on follow up.

To avoid choppiness, Slopnuke will ignore sentences of 11 to 23 words alone. For sentences exceeding 24 words, SlopSift's `reader-first/sentence-load` reviews a sentence, and Slopnuke's `slopnuke/choppy-run` flags sentences of 10 words or fewer. Two joined short sentences with a link word is allowed if the total number of words is under 24; this gives codebases that are full of choppy prose a fix that passes both rules.

### Writing Contract

Slopnuke settles rule conflicts with a simple test: would a human being say a flagged sentence out loud in normal conversation? 

Because this test is the first line of the rewrite prompt, when two findings conflict, the agent writes the version that they believe a person would say and Slopnuke marks this for a follow up pass.

All rule messages and rewrite prompts are derived from `core/contract.ts`:

| Part | Advice |
|---|---|
| Spoken test |first line of each rewrite prompt |
| Marks | no semicolons, no dashes or brackets around asides and no slash pairs |
| Length | 11 to 23 words in each sentence |
| Links | a repeated noun, that, this or then to tie the second half of a split sentence to the first, and so or because only for a cause |
| No actor | a copula sentence in markdown, and the golden noun phrase in comments |
| SlopSift advice | Slopnuke swaps the advice sentence of `comma-splice`, `agentless-opener`, `passive-actor-hiding`, `passive-voice-density`, `headline-fragment`, `agentless-rationale`, `corrective-antithesis`, `fragment-chain`, `label-led-explanation`, `aside-pileup` and `sentence-load` for contract advice |
| Profile defaults | `ai-style/evidence-cluster` is off in `actor-first`, because SlopSift counts other findings again for that rule. Setting it to `"warn"` in `rules` turns it back on |

Slopnuke compares sentences inside one paragraph for `repeated-subject`, `choppy-run` and `island-sentence` - this enables an agent to open a new paragraph on a new topic, or with the same subject as the paragraph before it. A run of one-sentence paragraphs counts as one paragraph - this can be adjusted via `core/contract.ts`

For the SlopSift markdown rules, Slopnuke puts a placeholder word where SlopSift blanks inline code; that way SlopSift still sees a subject in each sentence with a code name at the start.

Before extraction, Slopnuke replaces each bare `<` with `‹`. Without that swap, SlopSift 0.11 masks every line from a bare `<` to the next `>` as one HTML tag.

## Prose in Code

The code and test scopes read JS, TS, JSX, TSX, Python, Rust, Go and Swift files. Slopnuke drops comments first, then finds prose in the code.

| Prose | Source |
|---|---|
| Test names | string names in `test`, `it`, `@Test` and `t.Run`, group names in `describe` and `@Suite`, and `test_*`, `Test*` and `test*` functions, split into words |
| Messages | the first string argument of a call with a name word such as error, failure, fail, violation, warning, log, panic, usage, output, print or message |
| UI strings | SwiftUI `Text`, `Button`, `Label`, `Toggle`, `TextField`, `Section`, `Menu`, `.navigationTitle`, `.alert` and `.help`, the last string argument of each call in `descriptionCalls`, plus JSX text, button text, `aria-label`, `title`, `placeholder` and `alt` |
| Identifiers | names in function, type, class, constant and variable declarations |


Slopnuke then checks each span with the `slopnuke` rules and with the rules in this table:

| Rule | Flags |
|---|---|
| `slopnuke/test-name-format` | a string test name outside the `subject: input -> outcome` shape |
| `slopnuke/agentless-passive` | in test names and messages, also a participle outcome with no actor, such as `waiter granted at close` |
| `slopnuke/ui-label` | a label with more than four words, or a label with a verb as its first word |
| `slopnuke/ui-button` | button text that is not a verb and an object |
| `slopnuke/ui-description` | help text built on a verb. A description is a noun phrase that says what the value is and what it applies to, such as `The total amount of concurrent slots for a loaded model.` |
| `slopnuke/ui-tone` | greetings, apologies, reasons and exclamation marks in UI strings |
| `slopnuke/identifier-word` | a banned or figurative word inside an identifier, such as `leverageCache` |

To ensure that mechanical error messages aren't overwritten, Slopnuke skips a message with no space between words, or with `key=value` pairs, as data. Interpolation holes such as `${id}` and `\\(id)` become one placeholder word.

## Config

 `~/.slopnuke/config.json`, then `.slopnuke.json` at read in that order at the repo root. For the user-defined profile and the rule levels, Slopnuke takes the repo value over the user value, and merges the lists of both files.

```json
{
  "profile": "actor-first",
  "rules": { "slopnuke/arrow": "off", "slopnuke/ui-tone": "warn", "reader-first/fragment-chain": { "cc": "off" } },
  "ignore": ["file/path/to/ignore/**", "*.generated.py"],
  "bannedWords": ["synergy"],
  "allowedWords": ["hold"],
  "bannedPhrases": ["going forward"],
  "allowedPhrases": ["in summary"],
  "dataNouns": ["lease", "manifest"],
  "actorNouns": ["job"],
  "terms": ["shared", "exclusive"],
  "intentVerbs": ["ponder"],
  "descriptionCalls": [".value", ".toggle"]
}
```

| Key | Effect |
|---|---|
| `profile` | `standard` (default) or `actor-first` |
| `rules` | `"off"` or `"warn"` per rule id, or an object with a level for each scope: `md`, `cc`, `code` and `tests`. `"off"` also turns off a Slopnuke rule |
| `ignore` | gitignore-style globs relative to the repo root - skips a matching file, and every file under a matching directory |
| `bannedWords`, `allowedWords` | words to add to the ban list, or to take off it |
| `bannedPhrases`, `allowedPhrases` | stock phrases to add, or to take off |
| `dataNouns`, `actorNouns` | nouns that count as data, or as actors, for `slopnuke/inanimate-subject` and `slopnuke/animate-subject`. By default, the actors are people, `command`, `process`, `program`, `cli`, `server`, `daemon` and `shell` |
| `intentVerbs` | verbs to add to the intent and cognition list found at `slopnuke/animate-subject` |
| `descriptionCalls` | call names, such as `.value` or `Setting`. slopnuke reads the last string argument of each call as a UI description and checks it with `slopnuke/ui-description` |
| `terms` | domain words, such as the class `shared`. slopnuke reads each term as a name, never as a verb or a participle |

In markdown, Slopnuke also counts every inline code identifier in the file as a term. A config file with an unknown key, a bad value or invalid JSON ends the run with `slopnuke: error` and the file path.

## Accept List

As not every generation is slop, the plugin prints a 10-character id with each finding. When the user approves a finding with no change, the agent puts it on the accept list and then runs the next scan:

```sh
node scripts/slopnuke.ts accept <id> [<id> ...]
node scripts/slopnuke.ts accept <rule> [flagged text]
```

In Pi, `/slopnuke-accept` takes the same arguments.

Slopnuke writes `<rule> <flagged text>` lines into `.slopnuke-accept` at the repo root. For a line with only a rule, slopnuke turns that rule off for the repo. slopnuke drops accepted findings from every scan. When a rescan turns up only accepted findings, slopnuke counts the files as clean and ends the run with `slopnuke: done`.

## Review Form

Slopnuke additionally includes a `review` tool for findings that are correct as written. The agent passes the ids of those findings to the tool. In a form, the user picks one choice for each finding: `Rewrite finding`, `Accept text` or `Accept rule for repo`. The form offers `Accept text` only for a text that it shows in full, up to 160 characters. slopnuke writes the accepted choices to `.slopnuke-accept` and returns the findings to rewrite to the agent.

| Host | Form | Tool |
|---|---|---|
| Claude Code | MCP elicitation dialog, interactive sessions | `review` on the `slopnuke` plugin MCP server, with a `repo` argument |
| Codex | MCP elicitation prompt | `review` on the `slopnuke` plugin MCP server, with a `repo` argument |
| Pi | one `select` dialog per finding | `slopnuke_review`, and the `/slopnuke-review [id...]` command |

The form takes at most 10 findings and leaves out findings already on the accept list. For any findings past that limit, Slopnuke lists the ids in the tool result for the next call, and writes the accept list only when the user submits the form. After a declined form, a closed form, an answer outside the three choices or an unknown id, it leaves the file as it was. A client without form support gets the list of findings instead, with the `accept` command for each approval in chat.

Codex rejects the review form when `approval_policy.granular.mcp_elicitations` is `false`. In Claude Code, an `Elicitation` hook can answer the form from a script, which helps in headless runs.

The plugin starts the server with `node scripts/slopnuke.ts mcp`. Claude Code reads the server entry from `.claude-plugin/plugin.json`, and Codex reads `mcp/codex.json`.

## Install

Install needs Node.js 24 or newer.

Pi:

```sh
pi install git:github.com/redacktion/slopnuke
```

Claude Code:

```text
/plugin marketplace add redacktion/slopnuke
/plugin install slopnuke@slopnuke
```

Codex:

```sh
codex plugin marketplace add redacktion/slopnuke
codex plugin add slopnuke@slopnuke
```

Codex asks for a trust review of new plugin hooks. Open `/hooks` in the CLI and trust the three slopnuke hooks after a read of `hooks/hooks.json` and `scripts/slopnuke.ts`.

On the first sweep in Claude Code or Codex, Slopnuke installs Slopsift into `~/.slopnuke/runtime/<version range>` with npm.

Following install, SlopSift downloads its parser model into `~/.cache/slopsift` on first use.

## Sweep loop

1. Slopnuke lists the files in scope and scans each one with the `ai-style` and `reader-first` rulepacks, warning level and above.
2. Slopnuke sends at most 60 findings to the agent, each with the file, line, column, rule and flagged text.
3. The agent rewrites each flagged span.
4. Slopnuke rescans only the files that had findings.
5. Slopnuke ends the phase on a clean scan, after two rounds with no drop in findings, or after 40 rounds.

Slopnuke reports each file that it cannot scan in one line, and will never mark a file clean that it has not scanned - in the edited-files scope, Slopnuke stores only the hash of the content that it scanned as clean.

### Pi

The extension drives the loop in-process, and sends each round to the agent as a hidden follow-up message. When the user aborts an agent turn, the extension stops the run.

### Claude Code and Codex

The skill runs `scripts/slopnuke.ts start <scope> --session <id>` and prints round 1. Claude Code fills in the session id. Codex runs start with no session id, and the first Stop hook or edit of a flagged file links the run to its Slopnuke session. The agent rewrites the flagged text, then runs `scripts/slopnuke.ts next` for each later round, until the output prints `slopnuke: done`, `slopnuke: no active run`, or `slopnuke: error`. 

A repo can have one open run at a time: `start` from another session outputs a cancel command and `slopnuke: error`.

Three hooks enable this loop:

| Hook | Event | Job |
|---|---|---|
| `hook edit` | PostToolUse on Write, Edit, MultiEdit, NotebookEdit, apply_patch | Slopnuke records the paths that an agent edits inside the repo, for the edited-files scope. It ties an unbound run to the session that edits a flagged file |
| `hook stop` | Stop | Blocks the turn end while a run is open, and cancels the run after two blocked stops with no `next`. Slopnuke ties an unbound run to a session with the `start` command in the transcript |
| `hook prompt` | UserPromptSubmit | Adds a reminder of the open run, with the `accept`, `next` and `cancel` commands, to each new prompt in the same session |

Every hook exits 0 and prints JSON only. On an internal error, a hook prints a `systemMessage` and lets the turn continue. With no open run, each hook returns in milliseconds.

`node scripts/slopnuke.ts cancel` ends the open run for the current repo.

## State

| Path | Host | Contents |
|---|---|---|
| `~/.slopnuke/runs/` | Claude Code, Codex | one open run per repo, under a hash of the repo root |
| `~/.slopnuke/edited/` | Claude Code, Codex | edited paths per repo, with the content hash of the last clean scan |
| `~/.slopnuke/cache.json` | Claude Code, Codex | findings per file, under the content hash |
| `~/.slopnuke/shown/` | all hosts | finding ids of the last round per repo, for `accept` |
| `<repo>/.slopnuke-accept` | all hosts | the accept list, a file for the repo history |
| `~/.slopnuke/config.json` | all hosts | user config |
| `<repo>/.slopnuke.json` | all hosts | repo config |
| `~/.pi/agent/slopnuke-cache.json` | Pi | findings per file, under the content hash |
| `~/.pi/agent/slopnuke.key` | Pi | 32-byte key for the edited-file ledger |

Set `SLOPNUKE_HOME` to move `~/.slopnuke` elsewhere - each state file is written with mode 0600 through a temp file and a rename. An upgrade or a config edit makes slopnuke rescan every file, as the cache key includes the underlying Slopsift version, the lint options and the config.

### Pi edited-file ledger

- Each write or edit adds a link to a hash chain, `link = HMAC(key, prev, id, content MAC)`.
- `id` is an HMAC of the path, `enc` is the AES-256-GCM ciphertext of the path, content hashes are HMACs.
- The extension stores the links in the Pi session file, and restores the ledger in a resumed session.
- On a broken link or a path that it cannot decrypt, the extension stops the restore at the last valid entry.
- The extension sets session directories to 0700 and the session file to 0600 on session start and after each agent run.

## Comments in code

Slopnuke reads each comment block in a code file as a separate passage, so a finding never spans code. Before it lints a comment it blanks:

- Doc comment markers after the comment delimiter, such as the third `/` of `///`.
- Pragma comments, such as `MARK:`, `TODO`, `swiftlint:`, `eslint-disable` and `noqa`.
- License and authorship comment lines, and the whole comment header block at the top of a file with such a line.

For doc comments, Slopnuke exempts three shapes from the fragment and flow rules: `reader-first/fragment-chain`, `ai-style/headline-fragment`, `ai-style/agentless-rationale`, `ai-style/evidence-cluster`, `slopnuke/island-sentence` and `slopnuke/repeated-subject`.

| Shape | Example |
|---|---|
| noun phrase | `Top border with the title.` |
| condition | `Condition: The cache has an entry for this key.` |
| copula sentence | `The stored values are the keys of one cache entry.` |

## Discovery

- `git ls-files -co --exclude-standard`, with a filter on extension and without symbolic links.
- Slopnuke skips paths in dependency, build and third-party directories such as `vendor`, `3rdparty` and `third_party`.
- Slopnuke skips every path that matches a glob in the `ignore` config.
- Outside a git repo: a directory walk that skips dependency and build directories and honors the root `.gitignore`.
- Skips files over 512 KiB.
- Masks markdown table rows before linting.

## Development

```sh
npm install
npm test
```

The run state machine, scanner, house rules, writing contract, code prose extractor and text output are in `core/`. The Pi adapter is in `extensions/slopnuke.ts`, and Claude Code and Codex command-line tool and hook entry can be found in `scripts/slopnuke.ts`.

## Session audit

```sh
python3 scripts/session-audit.py [session-file]
```

The script exits 1 and outputs the line numbers when an assistant turn in a Pi session has a tool call with the name `user`.
