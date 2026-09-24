---
description: Initialize Sterling in this project (§12) — store, config, AGENTS.md, CLAUDE.md, agents, launcher, MCP wiring. Asks before assuming.
---

Run the §12 setup questions, ONE question at a time (ask, don't guess; recommend where you can):

1. Stack tags (`techStackLabels` — they mount domain knowledge stores).
2. Toolchain declaration(s): path globs → adapter (registered adapters: see `scripts/adapters/registry.json`; e.g. `node:**/*.mjs,**/*.js`).
3. Backup path (recommended: a synced folder OUTSIDE the repo) — or an explicit opt-out the user states themselves.

Then execute the manifest:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" --target "<project dir>" --project-name "<name>" --stack-tags <a,b> --toolchain <adapter>:<glob,glob> (--backup-path <p> | --backup-opt-out)
```

Init is an ENSURE operation (§12): re-running it is safe and needs no flags — declarations are read back from `.sterling/config.json`. Per item it creates what is absent, skips what matches, and leaves-and-reports anything hand-edited (a pre-existing AGENTS.md or CLAUDE.md is never clobbered — relay the report's merge instruction). A legacy pre-split CLAUDE.md is migrated automatically when its head matches a historical Sterling template render (the boundary is the end of that match — no marker line involved); otherwise the report says `manual` and relay the preview diff path. Skip the setup questions when the project already has a recorded config; only ask for what a fresh config needs.

Init also prepares the project for engineers who do not have Sterling: portable OpenCode agents in `.opencode/agents/` (implementor, researcher, scout) and the handoff projection (`architecture.md` and `rulings.md` indexes at the root, full records under `docs/sterling/`), generated from this project's own store. Tell the user these files are meant to be committed. A `refused` handoff row wrote nothing: relay its reason (a secondary, missing or empty store, or a hand-written file in the way).

Relay the per-item report table and the RESTART instruction prominently — a newly installed or synced agent is not visible to a session that was already running, so dispatch nothing until the session restarts (verify with `node scripts/check-agents-visible.mjs --target <dir> --session-started <iso>` if unsure).
