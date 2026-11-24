---
name: slopnuke-all
description: Sweep every code comment, markdown file, code string and name, and test name in the repo for AI writing slop with SlopSift and rewrite every finding until a rescan is clean. Use when the user asks to remove AI slop, AI-isms, or AI writing patterns from comments, markdown, code strings and names, and test names.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/slopnuke.ts" *) mcp__plugin_slopnuke_slopnuke__review
---

Scope: code comments, then markdown files, then code strings and names, then test names, under the working directory.

1. Run this command from the project directory, with a 10-minute timeout:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/scripts/slopnuke.ts" start all --session "${CLAUDE_SESSION_ID}"
   ```

   When `${CLAUDE_PLUGIN_ROOT}` appears literally, replace it with the plugin root: the directory two levels above this SKILL.md. When `${CLAUDE_SESSION_ID}` appears literally, drop the `--session` argument.

2. slopnuke prints findings as `path:line:column rule`, a message, and the flagged text. Rewrite each flagged span in place. Read the region first: line numbers after an edit differ from the scan output.

3. For a finding that is correct as written, call the slopnuke `review` tool with the repo path and the finding id. The user picks rewrite or accept in a form. When the user approves a finding in chat with no change, run the `accept` command that slopnuke prints. Give that command the id of the finding. Never accept a finding without the user's approval.

4. Run the `next` command that slopnuke prints. Repeat steps 2 to 4 until slopnuke prints `slopnuke: done`, `slopnuke: no active run`, or `slopnuke: error`.

The first run installs slopsift into `~/.slopnuke/runtime` and downloads its model into `~/.cache/slopsift`.
