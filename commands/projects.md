---
description: List the shared project registry — every /sterling:init'd project, with its stack tags (shared domains), toolchains, and last-seen activity.
---

Run the registry list script: `node "${CLAUDE_PLUGIN_ROOT}/bin/list-projects.mjs"` (the script ships with the plugin, not the project — a bare `scripts/` path only resolves inside the Sterling repo itself).

It reads the machine-global project registry (`~/.sterling/registry.db`) — every project that has run `/sterling:init`, with its `stack_tags` (the shared domains it joins), toolchains, Sterling version, and first-init / last-init / last-seen timestamps. `last_seen` is touched each session start, so it reflects activity, not just init recency.

Projects whose repo path no longer exists are flagged **MISSING** (stale-at-read; the registry stores no liveness, by design — no background sweep). Removal is human-gated, never automatic: to drop only the missing entries, run `node "${CLAUDE_PLUGIN_ROOT}/bin/list-projects.mjs" --prune-missing` (it never removes a live project).

## Removing a project's store

To delete a project's knowledge store (`<path>/.sterling`) while its folder stays, registered or not:

1. Run the dry run: `node "${CLAUDE_PLUGIN_ROOT}/bin/list-projects.mjs" --remove <path>`. It changes nothing. It prints the exact directory to delete, the registry entry (or "not registered"), record counts by type and open board items, the other entries inside `.sterling`, the files init left outside it (AGENTS.md, CLAUDE.md, `.opencode`, launchers), the backup destination, and every reason `--apply` would refuse. It exits 0 only when `--apply` would proceed.
2. Show the user that output and ask through the question form whether to delete. Do not run `--apply` without that answer.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/list-projects.mjs" --remove <path> --apply`. It checks everything again, copies `.sterling` to `<backup_path>/removed-<name>-<UTC time>/`, verifies the copy, deletes `.sterling` and removes the registry entry. It prints each step's outcome as JSON and stops at the first failure; if the backup fails, nothing is deleted.

When the path matches exactly one registry entry and has no `.sterling` at all, the store is already gone: the dry run says "store already removed; --apply only unregisters <name>", and `--apply` only removes the registry entry, with no backup and no open check because nothing is deleted. This is also how to finish a removal whose unregister step failed. With no `.sterling` and no registry entry, it refuses with "nothing to remove".

It refuses: a path that is missing, a symlink or not a directory; a `.sterling` that is a symlink or not a directory; several registry entries for the path; no `.sterling/config.json`; a Postgres-backed project; no `backup_path`; another registered project mounting a domain store inside the target; any process on this machine with the store's database open (close that session first); and any process running as the current user whose open files cannot be read (EACCES or EPERM), because a Sterling session runs as the user. The open check reads `/proc` and is best effort: processes of other users that cannot be inspected are counted in the dry run and do not refuse, a process that exits during the scan is skipped, it cannot see a Windows-side handle or a session started afterwards, and it refuses where `/proc` is unreadable. The dry run never deletes or creates a file in the target; when a `-wal` exists without a `-shm` it skips the record counts instead of opening the database. Files outside `.sterling` are listed, never deleted; a leftover `.opencode` is still active, because OpenCode loads ancestor configs into nested projects.

Any agent with a shell can run `--apply`; nothing distinguishes the conductor from a subagent. The question-form step above is the only gate.

Report the listing as-is. This is the cross-project awareness surface — the session-start banner already shows the sibling count; this is the on-demand detail.
