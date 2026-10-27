---
description: Mirror this project's user board tasks one way to GitHub issues in its origin repo; --dry-run prints the plan and writes nothing.
---

Follow the `sync-board-issues` skill (`skills/sync-board-issues/SKILL.md`). From the project:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/sync-board-issues.mjs" --dry-run [--project <dir>]
```

Show the user what the dry run prints. When they agree, run the same command without `--dry-run`. Tasks with a board objective get an `objective:<objective>` label. When the repo is near 200 issues, new issues go by priority then age, and the dry run lists the left-out tasks in that order (`would skip (ceiling)`). The skill's "Stable contract" section documents the issue footer and a regex for tools that read it. Relay the summary line, any `WARNING`, `text drift` or `CEILING` line, and the exit code: 0 done, 1 refused or failed, 2 a usage error, 3 done but some tasks got no issue because the repo reached 200 issues.
