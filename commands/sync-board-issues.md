---
description: Mirror this project's user board tasks one way to GitHub issues in its origin repo; --dry-run prints the plan and writes nothing.
---

Follow the `sync-board-issues` skill (`skills/sync-board-issues/SKILL.md`). From the project:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/sync-board-issues.mjs" --dry-run [--project <dir>]
```

Show the user what the dry run prints. When they agree, run the same command without `--dry-run`. Tasks with a board objective get an `objective:<objective>` label. When the repo is near the ceiling (200 unless `issue_mirror.ceiling` in the project config sets it; the skill's section 6 has the values, and `exclude_prefixes`, which closes the issue of a task excluded after it was mirrored and shows as `would close … (excluded)`), new issues go by priority then age, and the dry run lists the left-out tasks in that order (`would skip (ceiling)`). The skill's "Stable contract" section documents the issue footer and a regex for tools that read it. Relay the summary line, any `WARNING`, `text drift` or `CEILING` line, and the exit code: 0 done, 1 refused or failed, 2 a usage error or an invalid `issue_mirror` setting, 3 done but some tasks got no issue because the repo reached a finite ceiling.
