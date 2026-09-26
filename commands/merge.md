---
description: Merge the current conductor-direct branch into the base and sweep merged branches (§8.2) — the human-invoked merge-to-main gate for direct work.
---

Invoking this is the merge-to-main decision, so run it only once the change is committed and every affected article is reconciled. From the feature branch:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/direct-merge.mjs"
```

It merges the current branch `--no-ff` into the base (the default branch; `--into <b>` to override), deletes that branch, sweeps every other fully merged branch (`git branch -d` refuses unmerged branches), then pushes the base to origin (`--no-push` opts out; no origin skips loudly). It refuses on a dirty tree, when already on the base, when open `reconcile_needed` maintenance items cover changed files, or when files beyond generated projections changed without both version fields moving together (`.claude-plugin/plugin.json` and `package.json`; `--allow-same-version` is the deliberate escape). Report the merged branch, swept list, and whether the push landed.

Before the merge action, the gate also runs the `npm run check` consistency battery (skipped, loud, on a project with no `check` script) and refuses on failure. Two of its checks surface as their own refusals rather than a generic battery failure: a STALE BUILD (`src` newer than `dist` — validating a stale build proves nothing; run `npm run build` first) and STALE GENERATED PROJECTIONS (`architecture.md` / `rulings.md` no longer match the knowledge base they're generated from — regenerate and commit them).

**Project mode decides the flow** (`mode` in `.sterling/config.json`, switched in the TUI System tab; a missing key is `hobby`, any other value refuses with exit 2 before anything runs).

- **Hobby** — everything above: the direct merge into the base.
- **Work** — the same preflight (dirty tree, reconcile items, version fields, `npm run check`), then it pushes the feature branch and opens a PR with `gh pr create --repo <host/owner/repo> --head <branch> --base <base>`, its title and body taken from the branch commits and ending with the PR attribution line. An open PR for the same repo, head AND base is reused: the push updates it and no second PR is created; more than one such PR refuses (exit 1). It never checks out, merges into or pushes the base, never sweeps branches and never runs the post-merge repairs; a human merges the PR.
  - **The repo comes from origin.** It is parsed from origin's fetch URL (https, `ssh://` or `host:owner/repo`), never from gh's default repo, and passed to every `gh` call. Every effective push destination (`git remote get-url --push --all origin`, so `pushurl` and `pushInsteadOf` included) must be that same repo, or it refuses with exit 2 before pushing and names each destination.
  - **The push is pinned** to the SHA the preflight and battery checked (`git push origin <sha>:refs/heads/<branch>`, upstream set as config), so a commit that lands during the battery never ships. `--branch` must name a local branch.
  - **A failed `gh pr create` is followed by a lookup** for the repo, head and base: a PR found there is reported as reused (exit 0); otherwise the PR state is UNKNOWN (exit 1, never "no PR"), with the check command. Rerunning is safe: it reuses an open PR or creates one, and the push is a no-op.
  - **Refusals** with exit 2, before the battery: an invalid `mode`, `--no-push` (a PR needs a pushed branch), `gh` missing or not logged in for origin's host (run `gh auth login`), no GitHub-shaped `origin`, mismatched push destinations, or a `--branch` that is not a local branch.
  - **Stdout is one JSON object on every work-mode exit**, success or refusal: `{"mode":"work","ok":…,"stage":…,"error":…,"exit":…,"branch":…,"pushed":…,"pr_url":…,"pr_number":…,"created":…}`. `stage` names where it stopped (`done` on success); human text goes to stderr. The one exception is an exit before the mode is known (a bad `--target` argument, or an unreadable or invalid `mode`): it prints on stderr only, as in hobby.

  Report the PR URL and whether it was created or reused. The next step is the PR review loop (Sol before the PR, then Copilot on GitHub); its skill is slice S3, not yet built.

Read the first line before reacting to a non-zero exit: it does **not** always mean the merge failed. When the merge lands but a post-merge step does not — stale bundles after git auto-merged `hooks/*.mjs`, a `npm run build` failure on the merged tree, or a failed branch sweep — the gate exits non-zero with `THE MERGE SUCCEEDED` first and the remedy after. Re-running or hand-merging in that state is wrong; do the named remedy on the base branch instead.
