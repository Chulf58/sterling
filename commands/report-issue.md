---
description: File a Sterling defect as a scrubbed GitHub issue on Chulf58/sterling, or flush and list the queued reports.
---

Use this when the project hits a defect in Sterling itself: a hook, MCP tool, agent or command that misbehaves. File it without asking the user first. Run it from the project root:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/report-issue.mjs" --title "<what broke, max 120 chars>" --component "<the hook, tool, agent or command>" --severity BLOCKED|WORKAROUND|FRICTION --observed "<what happened, max 600>" --expected "<what should have happened, max 400>" --evidence "<line>" [--evidence "<line>" ...]
```

- `--severity`: BLOCKED stops the work, WORKAROUND has a way around it, FRICTION slows it down.
- `--evidence` (1 to 12 lines, 300 chars each): each line is a Sterling repo-relative `path:line` that Sterling ships (for example `scripts/hooks/h1-session-start.mjs:419`) or a "double-quoted message" Sterling printed. The script refuses anything else and names the line.
- The repo is public. Never put this project's source, file contents, paths, names or record titles in any field. The script scrubs absolute paths, non-Sterling paths and ids, but it cannot recognize a project name or a record title inside a quoted message.
- Add `--dry-run` to print the scrubbed body without sending it.

The script prints the body before and after it sends. It searches the repo for the report's fingerprint first: an open match gets a comment, a closed match gets a new issue that says which one it recurs after, and no match gets a new issue. Relay the issue URL it prints.

When gh is missing or not logged in, the script exits 1, says so in one line, and queues the report in `.sterling/pending-issue-reports.jsonl`; session start then states the pending count. `node "${CLAUDE_PLUGIN_ROOT}/bin/report-issue.mjs" --flush` sends the queue once gh works, and every new report flushes it first. `--list` prints the open `sterling-report` issues and the local pending count.
