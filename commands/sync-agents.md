---
description: Refresh init-installed Sterling agents when plugin templates change (hash compare; refuses to overwrite local modifications).
---

Run the Sterling agent sync script and report its output to the user verbatim:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync-agents.mjs" --target "<current project directory>"
```

- Exit 0: report each agent's status (`up_to_date`, `refreshed`, `installed`, `locally_modified_up_to_date`, `header_repaired`, `machine_rebaked`).
- Exit 2: at least one agent was refused because it was locally modified after install. Show the refusal instructions exactly as printed — do not overwrite, merge, or "fix" the agent file yourself. The user decides between keeping their changes (manual review against the new template) or discarding them (delete and re-run this command).
- If anything changed (`installed`, `refreshed`, `header_repaired`, or `machine_rebaked` — everything except `up_to_date`/`locally_modified_up_to_date`), relay the restart instruction prominently: project subagents load at session start, so the user must restart the session before the changes are live. `machine_rebaked` matters most — it is the dead-hooks recovery, and a missed restart leaves the old baked paths running.
