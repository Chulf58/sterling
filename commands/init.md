---
description: Initialize Sterling in this project — store, config, AGENTS.md, CLAUDE.md, agents, launcher, MCP wiring. Asks before assuming.
---

Run the setup questions, ONE question at a time (ask, don't guess; recommend where you can):

1. Stack tags (`stack_tags` in `.sterling/config.json`, passed as `--stack-tags` — they mount domain knowledge stores).
2. Toolchain declaration(s): path globs → adapter (registered adapters: see `"${CLAUDE_PLUGIN_ROOT}/scripts/adapters/registry.json"`; e.g. `node:**/*.mjs,**/*.js`).
3. Backup path (recommended: a synced folder OUTSIDE the repo) — or an explicit opt-out the user states themselves.
4. Project mode, NEW projects only (no `.sterling/config.json` yet): ask ONE AskUserQuestion form, header "Mode", with exactly two options — "Hobby": work ships by direct merge to main; "Work": work ships as a PR with a Sol then Copilot review loop. The mode decides only how work ships. Pass the answer as `--mode hobby` or `--mode work`. On a re-init or ensure of an existing project, do NOT ask and pass no `--mode`: the recorded mode is kept (init never overwrites it; switching is done in the TUI System tab).

5. Domain descriptions. Every declared domain (each stack tag, plus the `sterling` domain init always adds) gets a knowledge store, and a store that does not exist yet is created with a description saying which knowledge belongs in it. For each stack tag whose store is missing (`~/.sterling/domains/<tag>/sterling.db`, or the `domain_paths` override), ask ONE question for its description, with a short suggested wording drawn from the tag. A domain whose store already exists is not asked about: init leaves it untouched. The `sterling` domain ships a default description (Sterling plugin behaviour, Claude Code and OpenCode host facts, and workflow knowledge that applies to every project using Sterling); ask only if the user wants to change it. Pass each answer as `--domain-description <domain>=<text>`.

Then execute the manifest:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/init.mjs" --target "<project dir>" --project-name "<name>" --stack-tags <a,b> --toolchain <adapter>:<glob,glob> (--backup-path <p> | --backup-opt-out) [--mode <hobby|work>] [--domain-description <domain>=<text>]...
```

`--domain-description` is repeatable, one per new domain, and the text is everything after the first `=`. Init refuses before writing anything when a new domain has no description, and the refusal names the flag to pass. A description given for a domain whose store already exists is not applied (the report row says so); an existing store's description is changed in the store itself. On a re-init no description is needed unless a recorded domain's store has gone missing.

`--mode` is for NEW projects only: pass the Mode answer on a first init, and never on a re-init or ensure.

Init writes `mode` into the new config. Relay the report's `mode:` line (`set by --mode`, `kept`, or `defaulted` to hobby when no `--mode` was passed). Any other `--mode` value refuses with exit 2. On an existing project a differing `--mode` is not applied and prints a `⚠ --mode … NOT applied` notice: relay it.

Init is an ENSURE operation: re-running it is safe and needs no flags — declarations are read back from `.sterling/config.json`. Per item it creates what is absent, skips what matches, and leaves-and-reports anything hand-edited (a pre-existing AGENTS.md or CLAUDE.md is never clobbered — relay the report's merge instruction). A legacy pre-split CLAUDE.md is migrated automatically when its head matches a historical Sterling template render (the boundary is the end of that match — no marker line involved); otherwise the report says `manual` and relay the preview diff path. Skip the setup questions when the project already has a recorded config; only ask for what a fresh config needs.

**Handoff files are a separate setting, off by default.** When `handoff.enabled` is true in `.sterling/config.json`, init also prepares the project for engineers who do not have Sterling: portable OpenCode agents in `.opencode/agents/` (implementor, researcher, scout) and the handoff projection (`architecture.md` and `rulings.md` indexes at the root, full records under `docs/sterling/`), generated from this project's own store. It works the same in hobby and work mode. A new config starts with it off, unless the project already has portable agents tracked in git; an existing config with no `handoff` key is read the same way. Turn it on in the TUI System tab (the Handoff files row), then run `/sterling:update` (or init) to write the files; `sync-agents` alone refreshes only the portable agents. With it off, the report shows a `skipped` row and nothing is deleted. Tell the user these files are meant to be committed. A `refused` handoff row wrote nothing: relay its reason (a `handoff.enabled` that is not true or false, a secondary, missing or empty store, or a hand-written file in the way).

**Project mode and the handoff setting are per machine.** `mode` (`hobby` | `work`, missing = hobby) and `handoff.enabled` live in `.sterling/config.json`, which is untracked, so they are NOT carried by git: set them on EVERY machine that works on the project — the work machine included — in the TUI System tab. `machine_role` (does this clone author or consume Sterling), `mode` (how this project ships work), `handoff.enabled` (are the handoff files written) and `store_authority` (is this store the primary one) are independent: a work machine that CONSUMES Sterling may still hold the PRIMARY store for its work project.

Relay the per-item report table. A restart is required only when init says so: it prints the RESTART REQUIRED block when an agent was `installed`, `refreshed`, `header_repaired`, `machine_rebaked` or `retired`, or the conductor activation was newly written (then also `EXIT AND RELAUNCH`); otherwise it prints `no agent changes — no restart required`. When a restart is required, relay it prominently — a newly installed or synced agent is not visible to a session that was already running, so dispatch nothing until the session restarts (verify with `node "${CLAUDE_PLUGIN_ROOT}/bin/check-agents-visible.mjs" --target <dir> --session-started <iso>` if unsure).
