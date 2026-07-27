---
description: Update this machine's Sterling clone to origin's default branch — fast-forward, rebuild, re-bake machine artifacts, sync agents across every registered project.
---

Run the update executor and report its output to the user verbatim:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/update.mjs"
```

(The script ships with the plugin and updates the Sterling clone it lives in — never the project you invoked it from. A bare `scripts/` path only resolves inside the Sterling repo itself.)

Flags, when the user asks for them: `--check` (currency report only, mutates nothing), `--force` (rebuild and re-sync even when already current), `--no-test` (skip the ~90s battery), `--no-projects` (skip the per-project agent sync), `--no-fetch` (report against the last fetch, offline).

**Every machine but the authoring one is a pure consumer of the default branch** (decision e6240afe-e94b-4c1f-8eed-bafe32fb4d89). The update is a fast-forward or a refusal — never a merge, never a rebase, and never a file-by-file comparison against GitHub.

- **Exit 0**: updated, or already current. Relay the restart instruction prominently — the MCP server and every project subagent load at session start, so until the session restarts, the code on disk is not the code running.
- **Exit 2 — refused**: the pre-flight found divergence (dirty tracked files, local commits, a non-default branch, detached HEAD, no origin) and **mutated nothing**. Show the refusal exactly as printed. Do not merge, rebase, reset, or "reconcile" the working copy yourself — the message names where it gets fixed, and that decision is the user's. Exit 2 also covers a `sync-agents` refusal in a consuming project (a locally modified agent): same rule, relay verbatim.
- **Exit 1 — a step failed**: the fast-forward stands but a build, check, or test step failed with its output shown. Report it as a failure of *this machine*, not of main — a consumer machine that cannot build what main builds is the finding.

Do not paraphrase the per-project sync lines or the currency line (`sterling: <describe> (<sha>) on <branch> · <upstream> · <N behind>`) — that line is the answer to "is this machine current?", which is the whole reason the command exists.
