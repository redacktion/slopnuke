#!/usr/bin/env python3
"""Report assistant turns with a tool call that has the name "user"."""

import json
import sys
from pathlib import Path

SESSION_ROOT = Path.home() / ".pi" / "agent" / "sessions"
TOOL_NAME = "user"


def project_dir():
    slug = "--" + str(Path.cwd()).lstrip("/").replace("/", "-") + "--"
    candidate = SESSION_ROOT / slug
    return candidate if candidate.is_dir() else SESSION_ROOT


def newest_session(root):
    files = sorted(root.rglob("*.jsonl"), key=lambda path: path.stat().st_mtime)
    if not files:
        sys.exit("no session file under " + str(root))
    return files[-1]


def scan(path):
    user_turns = 0
    fabricated = []
    for number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        message = entry.get("message") or {}
        content = message.get("content")
        if not isinstance(content, list):
            continue
        role = message.get("role")
        if role == "user":
            user_turns += 1
            continue
        if role != "assistant":
            continue
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") != "toolCall" or part.get("name") != TOOL_NAME:
                continue
            arguments = part.get("arguments")
            text = arguments.get("content") if isinstance(arguments, dict) else None
            fabricated.append((number, str(text or "{}")))
    return user_turns, fabricated


def main():
    root = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else project_dir()
    path = root if root.is_file() else newest_session(root)
    user_turns, fabricated = scan(path)
    print("session: " + str(path))
    print("user turns: " + str(user_turns))
    print("assistant turns with a tool call that has the name " + repr(TOOL_NAME) + ": " + str(len(fabricated)))
    for number, text in fabricated:
        print("  line " + str(number) + ": " + text[:100].replace("\n", " "))
    if fabricated:
        print("FAIL: the assistant wrote turns that pose as user input")
        return 1
    print("OK: no such turns")
    return 0


if __name__ == "__main__":
    sys.exit(main())
