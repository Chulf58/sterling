---
description: Merge the current conductor-direct branch into the base and sweep merged branches (§8.2) — the human-invoked merge-to-main gate for direct work.
---

The conductor-direct counterpart to the run merge gate (merge-gate.mjs). Invoking this IS the merge-to-main decision — Sterling's second gate — so run it only once the change is committed and every affected article reconciled. From the feature branch:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/direct-merge.mjs"
```

It merges the current branch `--no-ff` into the base (the default branch; `--into <b>` to override), deletes that branch, sweeps every other fully-merged branch (`git branch -d` — refuses unmerged, never loses work; a merged branch pinned by a worktree is skipped, not a failure), then **pushes the base to origin** (`--no-push` opts out; no origin skips loud) — work has not landed until consumers can fast-forward to it. It refuses during an active run (a run merges through `merge-gate.mjs`, which keeps the disposal/promotion gate), on a dirty tree, when already on the base, when — since decision 9df61181 — open `reconcile_needed` maintenance items cover files the branch changed (the reconcile precondition is enforced, not just stated: `knowledge_update` the owning article, which auto-drains the item, then rerun), or — decision be9168e8, gate-enforced since 2026-08-05 — when the branch changes files beyond the generated projections without moving BOTH version fields together (`.claude-plugin/plugin.json` + `package.json`; 0.x rule: breaking → MINOR, additive → PATCH; `--allow-same-version` is the deliberate escape). Report the merged branch, the swept list, and whether the push landed.

Read the first line before reacting to a non-zero exit: it does **not** always mean the merge failed. When the merge lands but a post-merge step does not — stale bundles after git auto-merged `hooks/*.mjs`, a `npm run build` failure on the merged tree, or a failed branch sweep — the gate exits non-zero with `THE MERGE SUCCEEDED` first and the remedy after. Re-running or hand-merging in that state is wrong; do the named remedy on the base branch instead.
