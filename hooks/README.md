# hooks/ — bundled hook entrypoints

Every `.mjs` file here is an esbuild bundle of a source under `scripts/hooks/`; edit the source, never the bundle, then run `npm run build:hooks` (and `node scripts/check-bundles-fresh.mjs` refuses a stale bundle at the merge gate). This directory is the enforcement surface, so H3 refuses any agent write into it in every mode; only the conductor's own hand and the build step write here.

## `hooks.json` is NOT the full roster

`hooks.json` registers only the CONDUCTOR-side hooks — the events Claude Code fires for the main session. Agent-scoped hooks are registered in the agent templates' frontmatter (`agent-templates/*.md`, `hooks:` entries, installed into a project's `.claude/agents/`), by design: CLAUDE.md invariant 4 says H6 rides agent frontmatter so the conductor never legitimately reaches it, and the other agent-scoped guards (H4, H5, H14, H17, H18) follow the same route; H3, H7 and H13 are registered on BOTH surfaces.

Counts measured 2026-09-06 (branch `fix/issues-log-2026-09-05`):

| Surface | Distinct hook files |
|---|---|
| `hooks/*.mjs` bundles on disk | 32 |
| registered in `hooks.json` | 26 |
| registered in agent-template frontmatter | 9 (`h3-contract-gate`, `h4-read-wall`, `h5-frozen-tests`, `h6-context-watch`, `h7-file-touch`, `h13-reads-ledger`, `h14-bash-allowlist`, `h17-bash-write-sweep`, `h18-test-write-wall`) |
| frontmatter-only, never in `hooks.json` | 6 (`h4`, `h5`, `h6-context-watch`, `h14`, `h17`, `h18`) |

So a reader counting `hooks.json` sees 26 of 32 and should not conclude the other six are unregistered (a consuming project did exactly that, issue log 2026-09-01). To see the whole roster, grep both surfaces: `grep -l '^hooks:' agent-templates/*.md` for the frontmatter side and `hooks.json` for the conductor side; the knowledge-store article `hooks-suite` is the per-hook census.
