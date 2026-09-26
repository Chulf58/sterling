---
description: Drain the maintenance queue — work each system item to its fulfilling artifact, then remove it; gated items routed to their SOPs.
---

List the maintenance queue (`maintenance_query`, paged until `capped` is false) and report the counts grouped by `system_reason`. Invoke the `drain` skill to work each knowledge-debt item to its fulfilling artifact and close it the way its lane closes (a `resolves` claim on the fulfilling write, or `board_remove` after it). Delegate `deletion_candidate` to `/sterling:cleanup` and `promotion_review` to a human-gated `knowledge_promote`; never auto-delete or auto-promote inside a drain. The user board (source `user`) is never auto-removed — report its count only.
