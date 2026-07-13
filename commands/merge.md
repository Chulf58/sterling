---
description: Merge the current conductor-direct branch into the base and sweep merged branches (§8.2) — the human-invoked merge-to-main gate for direct work.
---

The conductor-direct counterpart to the run merge gate (merge-gate.mjs). Invoking this IS the merge-to-main decision — Sterling's second gate — so run it only once the change is committed and every affected article reconciled. From the feature branch:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/direct-merge.mjs"
```

It merges the current branch `--no-ff` into the base (the default branch; `--into <b>` to override), deletes that branch, then sweeps every other fully-merged branch (`git branch -d` — refuses unmerged, never loses work). It refuses during an active run (a run merges through `merge-gate.mjs`, which keeps the disposal/promotion gate), on a dirty tree, when already on the base, or — since decision 9df61181 — when open `reconcile_needed` maintenance items cover files the branch changed (the reconcile precondition is enforced, not just stated: `knowledge_update` the owning article, which auto-drains the item, then rerun). Report the merged branch and the swept list.
