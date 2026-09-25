---
description: Refresh init-installed Sterling agents when plugin templates change (hash compare; refuses to overwrite local modifications).
---

Run the Sterling agent sync script and report its output to the user verbatim:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-agents.mjs" --target "<current project directory>"
```

- Exit 0: report each agent's status (`up_to_date`, `refreshed`, `installed`, `locally_modified_up_to_date`, `header_repaired`, `machine_rebaked`, `retired`, `config_drift`).
- `config_drift` (exit 0, nothing written): the installed agent's `model`/`effort` differs from the project's `config.models`, so the config change is not live. Relay the line as printed. It names the installed and configured values and the fix: `node scripts/install-agents.mjs` (`--target <dir>` for a sibling), then restart the session. Sync never rewrites this case.
- Exit 2: a registered agent was refused (`foreign_file`, `refused_local_modification`), or a retired Sterling-marked file was preserved (`retired_unrecognized`, `retired_but_modified`, `retired_identity_mismatch`, `retired_read_failed`, `retired_delete_failed`, `retired_scan_failed`). Show its instructions exactly as printed. For retirement, the user must archive it outside `.claude/agents/`, adopt it as a custom agent by removing the Sterling header, or delete it.
- Lines naming `.opencode/agents/<name>.md` are the portable OpenCode copies of implementor, researcher and scout, committed for engineers without Sterling. They follow the same ownership rules (`foreign_file` and `refused_local_modification` exit 2) and need no restart. The Sterling clone itself gets none, and the output says so.
- If anything changed (`installed`, `refreshed`, `header_repaired`, `machine_rebaked`, or `retired`), relay the restart instruction prominently: project subagents load at session start, so the user must restart the session before the changes are live. `machine_rebaked` matters most — it is the dead-hooks recovery, and a missed restart leaves the old baked paths running.
