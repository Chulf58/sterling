---
description: Force-pipeline override — start the intake → grill → planning → gate sequence for a feature. Conversation is the normal entry; this skips mode selection.
---

Run the pipeline front half in order: intake conversation on the user's request, then the `grill-intent` skill, then the `planning` skill, then the `grill-plan` skill. At THE GATE, present the locked brief (ACs, scope, difficulty/risk flags) for explicit human approval. On approval: create the run record via the store, start the run branch (`scripts/lib/branch-manager.mjs` semantics — clean tree required), and begin phase 1 with prep:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/prep.mjs" --run <id> --phase <id>
```

From there the brain governs (§5.2 routing): abnormal exits → `run_signal` immediately; a non-terminal step's `complete` → consume and proceed (`node "${CLAUDE_PLUGIN_ROOT}/scripts/consume-exit.mjs" --run <id> --step <label>`); the phase-boundary `complete` → `run_signal` → execute exactly the returned action.
