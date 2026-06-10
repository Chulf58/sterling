---
description: Enter the Sterling debug play (§8.3) — root-cause SOP with verification fan-out; never a pipeline.
---

Invoke the `debug` skill and follow its six steps exactly. Before any edit, register the explorer's map as the debug scope:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/debug-scope.mjs" register --path <p> [--path <p>...]
```

H3 will deny edits outside the map ("confirm or expand the map"). At capture (step 6), clear it:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/debug-scope.mjs" clear
```
