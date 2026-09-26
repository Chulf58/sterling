---
description: Start a Sterling cleanup run — gated deletion; the anti-accretion mechanism.
---

Run the deletion-evidence script and present its output, then invoke the `cleanup` skill:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/cleanup-plan.mjs"
```

Present the whole deletion map for one confirmation; the human may strike any item from it. Execute confirmed deletions through `node "${CLAUDE_PLUGIN_ROOT}/scripts/fs-remove.mjs" <path>...` — never raw deletion, and never as a side-job inside another change.
