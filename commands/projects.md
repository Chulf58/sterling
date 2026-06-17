---
description: List the shared project registry — every /sterling:init'd project, with its stack tags (shared domains), toolchains, and last-seen activity (decision 8f9e6db2).
---

Run the registry list script from the project root: `node scripts/list-projects.mjs`

It reads the machine-global project registry (`~/.sterling/registry.db`) — every project that has run `/sterling:init`, with its `stack_tags` (the shared domains it joins), toolchains, Sterling version, and first-init / last-init / last-seen timestamps. `last_seen` is touched each session start, so it reflects activity, not just init recency.

Projects whose repo path no longer exists are flagged **MISSING** (stale-at-read; the registry stores no liveness, by design — no background sweep). Removal is human-gated, never automatic: to drop only the missing entries, run `node scripts/list-projects.mjs --prune-missing` (it never removes a live project).

Report the listing as-is. This is the cross-project awareness surface — the session-start banner already shows the sibling count; this is the on-demand detail.
