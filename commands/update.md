---
description: Update this machine's Sterling clone to origin's default branch — fast-forward, rebuild, re-bake machine artifacts, sync agents across every registered project.
---

Run the update executor and report its output to the user verbatim:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/update.mjs"
```

(The script ships with the plugin and updates the Sterling clone it lives in — never the project you invoked it from. A bare `scripts/` path only resolves inside the Sterling repo itself.)

Flags, when the user asks for them: `--check` (currency report only, mutates nothing), `--force` (rebuild and re-sync even when already current), `--no-test` (skip the ~90s battery), `--no-projects` (skip the per-project agent sync), `--no-fetch` (report against the last fetch, offline).

**Every machine but the authoring one is a pure consumer of the default branch.** The update is a fast-forward or a refusal — never a merge, never a rebase, and never a file-by-file comparison against GitHub.

- **Exit 0**: updated, or already current. Relay the restart instruction prominently — the MCP server and every project subagent load at session start, so until the session restarts, the code on disk is not the code running.
- **Exit 2 — refused**: the pre-flight found divergence (dirty tracked files, local commits, a non-default branch, detached HEAD, no origin) and **mutated nothing**. Show the refusal exactly as printed. Do not merge, rebase, reset, or "reconcile" the working copy yourself — the message names where it gets fixed, and that decision is the user's. Exit 2 also covers a per-project refusal in a registered project — a `sync-agents` refusal (a locally modified agent, an unsafe path), an invalid `mode`, or an actionable handoff-projection refusal: same rule, relay verbatim. Every run, already-current included, refreshes each registered project once by its current mode, so the next run retries it on its own; a standing projection refusal (a secondary store) is a ⚠ line, not a failure.
- **Exit 1 — a step failed**: the fast-forward stands but a build, check, or test step failed with its output shown. A failed build or check stops the sequence there. A failed TEST battery skips store migration only: agent sync and the later steps still run, and no completion marker is written (decision `update-red-test-battery-still-syncs-agents-skips-store-migration`), so rerun once the battery is green. Report it as a failure of *this machine*, not of main — a consumer machine that cannot build what main builds is the finding.

A project's `mode` is local to each machine (untracked `.sterling/config.json`; set it in the TUI System tab) — see `/sterling:init` for how it relates to `machine_role` and `store_authority`. After switching a project to work, `/sterling:update` is what writes both the OpenCode agents and the handoff files.

Do not paraphrase the per-project sync lines or the currency line (`sterling: <describe> (<sha>) on <branch> · <upstream> · <N behind>`) — that line is the answer to "is this machine current?", which is the whole reason the command exists.
