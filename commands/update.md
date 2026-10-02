---
description: Update this machine's Sterling clone to origin's default branch — fast-forward, rebuild, re-bake machine artifacts, sync agents across every registered project.
---

Run the update executor and report its output to the user verbatim:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/update.mjs"
```

(The script ships with the plugin and updates the Sterling clone it lives in — never the project you invoked it from. A bare `scripts/` path only resolves inside the Sterling repo itself.)

Flags, when the user asks for them: `--check` (currency report only — it still fetches and prunes origin's refs, but changes nothing else), `--force` (rebuild and re-sync even when already current), `--no-test` (skip the ~90s battery), `--no-projects` (skip the per-project agent sync), `--no-fetch` (skips only the fetch — every other step runs against the last fetched state). `--check --no-fetch` is the report-only, offline combination.

**The authoring machine** (`machine_role: "authoring"` in the clone's `.sterling/config.json`) is the exception (decision `sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone`, point 5): work lands in that clone, so the update does no fetch, merge, `npm ci`, build, check, test or store migration. It prints `AUTHORING clone — nothing to pull; syncing <project> only` and runs `sync-agents` and a dry-run `stamp-contract` for the **invoking project only** — no registry fan-out, no handoff projection, no launchers. The invoking project is `CLAUDE_PROJECT_DIR` when set, else the directory the command was run from, and it must be a registered project or inside one (nearest registered ancestor wins); anything else is refused with exit 2 and nothing synced. When the project is the clone itself, sync-agents runs and the contract check prints that the clone's contract files are hand-maintained and skips. A stamp-contract run that checked nothing ("0 project(s) processed") for a registered project is a failure (exit 1). The completion marker is never written (it attests the full sequence, which did not run). Flags on this machine: `--check` fetches nothing, syncs nothing and prints **no currency line**, by design, because there is nothing to pull; `--no-projects` makes the run a stated no-op (the project sync is the whole update); `--force` is stated as meaningless and the sync still runs. Relay its output verbatim; a refused agent sync is exit 2 as below.

**Every other machine is a pure consumer of the default branch.** The update is a fast-forward or a refusal — never a merge, never a rebase, and never a file-by-file comparison against GitHub.

- **Exit 0**: updated, or already current. Relay the restart instruction prominently — the MCP server and every project subagent load at session start, so until the session restarts, the code on disk is not the code running.
- **Exit 2 — refused**: the pre-flight found divergence (dirty tracked files, local commits, a non-default branch, detached HEAD, no origin) and **mutated nothing**. Show the refusal exactly as printed. Do not merge, rebase, reset, or "reconcile" the working copy yourself — the message names where it gets fixed, and that decision is the user's. Exit 2 also covers a per-project refusal in a registered project — a `sync-agents` refusal (a locally modified agent, an unsafe path), an invalid `mode`, or an actionable handoff-projection refusal: same rule, relay verbatim. Every run, already-current included, refreshes each registered project once by its current mode, so the next run retries it on its own; a standing projection refusal (a secondary store) is a ⚠ line, not a failure.
- **Exit 1 — a step failed**: the fast-forward stands but a build, check, or test step failed with its output shown. A failed build or check stops the sequence there. A failed TEST battery skips store migration only: agent sync and the later steps still run, and no completion marker is written (decision `update-red-test-battery-still-syncs-agents-skips-store-migration`), so rerun once the battery is green. Report it as a failure of *this machine*, not of main — a consumer machine that cannot build what main builds is the finding.

A project's `mode` is local to each machine (untracked `.sterling/config.json`; set it in the TUI System tab) — see `/sterling:init` for how it relates to `machine_role` and `store_authority`. After switching a project to work, `/sterling:update` is what writes both the OpenCode agents and the handoff files.

Do not paraphrase the per-project sync lines or the currency line (`sterling: <describe> (<sha>) on <branch> · <upstream> · <N behind>`) — that line is the answer to "is this machine current?", which is the whole reason the command exists.
