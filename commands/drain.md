---
description: Drain the maintenance queue (§3.2.7) — work each system item to its fulfilling artifact, then remove it; gated items routed to their SOPs.
---

Confirm there is no active run (`run_state` — if a run is live, stop; a run's queue is H9 / dispose-run territory), then list the maintenance queue (`maintenance_query`) and report the counts grouped by `system_reason`. Invoke the `drain` skill to work each knowledge-debt item to its fulfilling artifact and `board_remove` it. Delegate `deletion_candidate` to `/sterling:cleanup` and `promotion_review` to a human-gated `knowledge_promote`; never auto-delete or auto-promote inside a drain. The user board (source `user`) is never auto-removed — report its count only.
