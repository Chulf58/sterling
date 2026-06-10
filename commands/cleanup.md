---
description: Start a Sterling cleanup run (§8.4) — gated deletion; the anti-accretion mechanism.
---

Run the deletion-evidence script and present its output, then invoke the `cleanup` skill:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/cleanup-plan.mjs"
```

Walk the human through each candidate (grill: confirm or strike, one at a time). Execute confirmed deletions as a gated pipeline using `fs-remove` (contract-checked) — never raw deletion, never inside a feature phase.
