---
description: Enter the Sterling debug play (§8.3) — root-cause SOP with verification fan-out.
---

Invoke the `debug` skill and follow its six steps exactly. Before any edit, have the scout locate the relevant code and register that observed scope:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/debug-scope.mjs" register --path <p> [--path <p>...]
```

`debug-scope` is observation and capture metadata, not edit enforcement. At capture (step 6), clear it:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/debug-scope.mjs" clear
```
