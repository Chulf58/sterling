---
description: Merge the current conductor-direct branch into the base and sweep merged branches (§8.2) — the human-invoked merge-to-main gate for direct work.
---

Invoking this is the merge-to-main decision, so run it only once the change is committed and every affected article is reconciled. From the feature branch:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/direct-merge.mjs"
```

It merges the current branch `--no-ff` into the base (the default branch; `--into <b>` to override), deletes that branch, sweeps every other fully merged branch (`git branch -d` refuses unmerged branches), then pushes the base to origin (`--no-push` opts out; no origin skips loudly). It refuses on a dirty tree, when already on the base, when open `reconcile_needed` maintenance items cover changed files, or when files beyond generated projections changed without both version fields moving together (`.claude-plugin/plugin.json` and `package.json`; `--allow-same-version` is the deliberate escape). Report the merged branch, swept list, and whether the push landed.

Before the merge action, the gate also runs the `npm run check` consistency battery (skipped, loud, on a project with no `check` script) and refuses on failure. Two of its checks surface as their own refusals rather than a generic battery failure: a STALE BUILD (`src` newer than `dist` — validating a stale build proves nothing; run `npm run build` first) and STALE GENERATED PROJECTIONS (`architecture.md` / `rulings.md` no longer match the knowledge base they're generated from — regenerate and commit them).

Read the first line before reacting to a non-zero exit: it does **not** always mean the merge failed. When the merge lands but a post-merge step does not — stale bundles after git auto-merged `hooks/*.mjs`, a `npm run build` failure on the merged tree, or a failed branch sweep — the gate exits non-zero with `THE MERGE SUCCEEDED` first and the remedy after. Re-running or hand-merging in that state is wrong; do the named remedy on the base branch instead.
