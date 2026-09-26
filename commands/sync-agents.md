---
description: Refresh init-installed Sterling agents when plugin templates change (hash compare; refuses to overwrite local modifications).
---

Run the Sterling agent sync script and report its output to the user verbatim:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-agents.mjs" --target "<current project directory>"
```

- Exit 0: report each agent's status as printed, and the `conductor activation:` line.
- `config_drift` (exit 0, nothing written): the installed agent differs from what the project's config would install — its `model`/`effort` differs from `config.models`, or its tool grant differs (the line lists the `missing` and `unexpected` tools) — so the config change is not live. Relay the line as printed: it names the drift and the fix, `install-agents.mjs` — run it from the plugin as `node "${CLAUDE_PLUGIN_ROOT}/scripts/install-agents.mjs" --target <dir>` — then restart the session. Sync never rewrites this case.
- Exit 2: something was refused — a registered agent (for example `foreign_file`, `refused_local_modification`), a retired Sterling-marked file that was preserved (the `retired_*` statuses), or the conductor activation (`conductor activation: refused (<reason>)`: the conductor is installed but is NOT the main-session agent). The script's own output names each refusal and its remedy; show it exactly as printed rather than interpreting the status names. For retirement, the user must archive it outside `.claude/agents/`, adopt it as a custom agent by removing the Sterling header, or delete it.
- Lines naming `.opencode/agents/<name>.md` are the portable OpenCode copies of implementor, researcher and scout, committed for engineers without Sterling. They follow the same ownership rules (`foreign_file` and `refused_local_modification` exit 2) and need no restart. The Sterling clone itself gets none, and the output says so.
- If anything changed (`installed`, `refreshed`, `header_repaired`, `machine_rebaked`, or `retired`, or an `EXIT AND RELAUNCH` line for a newly written conductor activation), relay the restart instruction prominently: project subagents load at session start, so the user must restart the session before the changes are live. `machine_rebaked` matters most — it is the dead-hooks recovery, and a missed restart leaves the old baked paths running.
