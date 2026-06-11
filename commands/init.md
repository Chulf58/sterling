---
description: Initialize Sterling in this project (§12) — store, config, CLAUDE.md, agents, launcher, MCP wiring. Asks before assuming.
---

Run the §12 mini-grill, ONE question at a time (ask, don't guess; recommend where you can):

1. Stack tags (`techStackLabels` — they mount domain knowledge stores).
2. Toolchain declaration(s): path globs → adapter (registered adapters: see `agent-templates`/`scripts/adapters/registry.json`; e.g. `node:**/*.mjs,**/*.js`).
3. Backup path (recommended: a synced folder OUTSIDE the repo) — or an explicit opt-out the user states themselves.

Then execute the manifest:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" --target "<project dir>" --project-name "<name>" --stack-tags <a,b> --toolchain <adapter>:<glob,glob> (--backup-path <p> | --backup-opt-out)
```

Relay the report and the RESTART instruction prominently — the first pipeline run is blocked until a restarted session passes the agent-visibility gate (start-run enforces it).
