> **RETIRED 2026-07-12** (R2-AUDIT board c7053df5, the b7ce8798 precedent): build-era
> document, NOT authoritative — the knowledge base is king. The milestone it stages
> ran long ago (r-0001 onward); its `.mcp.json` wiring was superseded by decision
> c825ae8f (option D — plugin-manifest MCP declaration, no per-project .mcp.json)
> and its `mcp__sterling__*` tool naming by decision 097851ed
> (`mcp__plugin_sterling_sterling__*`). Kept verbatim below for history only.

# §16.1 First-feature milestone — PREPARED, NOT RUN

The spine's first real feature runs interactively with the human at the two
gates. Everything is staged; do not fold this run into a step report.

## Scratch target (hand-initialized; /sterling:init itself is step 11)

`C:\Users\cuj\sterling-milestone\` — git repo (branch `main`, clean tree),
`package.json` (type module), `src/placeholder.mjs`.

- `.sterling/config.json`: defaults + node toolchain baked via
  `resolveToolchains` (static_wiring live) + `backup_path` configured.
- `.mcp.json`: sterling MCP server (`packages/mcp-server/dist/main.js
  --store .sterling/sterling.db`) — verified `✔ Connected`.
- `.claude/agents/`: all 9 roster agents installed via
  `scripts/install-agents.mjs` (NODE/HOOKS_DIR baked, headers intact);
  runtime visibility check passes; fresh-session listing shows all nine.
- Plugin hooks live via `--plugin-dir` (verified: H10's capture nag fired in
  a probe session — see step-10.5 commit for the bundle bug it surfaced).

## How to run it (interactive)

```
cd C:\Users\cuj\sterling-milestone
.\sterling-claude.cmd
```

(The wrapper exists because launching plain `claude` here loses the plugin:
`/sterling:*` then fails with "Unknown command" — reproduced and verified
2026-06-11 on CLI 2.1.173. Accept the folder-trust dialog on first
interactive launch.)

Then `/sterling:feature <a small real feature>` and drive:
intake → grill-intent → planning → grill-plan → ★ GATE (human) →
run branch → prep → test-writer → red → coder → green → completeness
(--final) → capture → dispose-run → ★ MERGE GATE (human).

Suggested first feature: "a CLI `sum` command in src/sum.mjs wired into
src/placeholder.mjs" — small blast radius, one phase, real TDD loop.

Prerequisites already satisfied: `npm run build` artifacts, `npm run
build:hooks` bundles, `npm run build:tui` bundle (optional split pane:
`node packages/tui/bundle/sterling-tui.mjs --store
C:\Users\cuj\sterling-milestone\.sterling\sterling.db`).

Known seams to watch during the run: spawned-agent MCP tool naming
(`mcp__sterling__*` assumes the server name `sterling` from .mcp.json);
H6 fills under live agents; H8 counters on respawn.
