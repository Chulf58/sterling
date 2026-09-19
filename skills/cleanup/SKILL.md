---
name: cleanup
description: Gated deletion run SOP (§8.4) — the anti-accretion mechanism. Deletion earns full plan→grill→execute→review rigor; never a side-job inside a feature phase.
---

# Cleanup SOP (§8.4)

Trigger: /sterling:cleanup or maintenance-queue review. Input: `deprecated`/`dormant` articles + `deletion_candidate` queue entries. The articles' file/dependency data is the evidence that makes deletion safe.

1. **Deletion plan:** from the candidate articles, list exactly which files/exports die and which articles claim dependents. No dependents = deletable; any active `relied_by` = blocked until released. Tracing which files/exports die is repo-grounded read-only investigation — Codex is the default engine for that piece (decision `codex-preferred-for-read-shaped-analysis`); which articles claim dependents needs the store's `relied_by` data, so that piece stays on a Claude agent — Codex has no knowledge tools.
2. **Confirm:** "these N dormant features own these files with no active dependents — confirm each." One at a time; the human confirms or strikes per item.
3. **Execute carefully:** use the confirmed deletion map as the boundary. Remove files through `scripts/fs-remove.mjs` when its project bookkeeping applies, and keep file keys coherent.
4. **Verify:** run the relevant build and tests, inspect the deletion diff, and obtain an independent review appropriate to the risk before committing.
5. **Retirement:** the articles' traced tests retire with them; articles remain as superseded history (never hard-deleted knowledge); board/queue entries are removed by the deletion artifact (P4). Removal operations take the exact full UUID, never a prefix.

Cleanup is never a side-job inside a feature phase — a coder told to "tidy while you're at it" blows the contract by design.
