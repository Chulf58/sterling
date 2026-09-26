---
name: cleanup
description: Gated deletion run SOP — the anti-accretion mechanism. Deletion earns full plan, execution, and review rigor, as its own unit of work rather than a side-job inside another change.
---

# Cleanup SOP

Trigger: /sterling:cleanup or maintenance-queue review. Input: `deprecated`/`dormant` articles + `deletion_candidate` queue entries. The articles' file/dependency data is the evidence that makes deletion safe.

1. **Deletion plan:** from the candidate articles, list exactly which files/exports die and which articles claim dependents. No dependents = deletable; any active `relied_by` = blocked until released. Tracing which files/exports die is repo-grounded read-only investigation that can go to a read-only lane; which articles claim dependents needs the store's `relied_by` data, so that piece stays on a Claude agent — Codex has no knowledge tools.
2. **Confirm the map once:** present the whole deletion map — "these N dormant features own these files with no active dependents" — and the human confirms it in one answer, striking any item they want kept (decision `skill-ceremony-scaled-to-risk-after-2026-09-26-audit`).
3. **Execute carefully:** use the confirmed deletion map as the boundary. Remove files through `node "${CLAUDE_PLUGIN_ROOT}/scripts/fs-remove.mjs" <path>...` — never raw deletion — so the removal is registered and owning articles get reconciled, and keep file keys coherent.
4. **Verify:** run the relevant build and tests, inspect the deletion diff, and obtain an independent review appropriate to the risk before committing.
5. **Retirement:**
   - **Tests.** Never delete a mechanism's test file wholesale (anti-pattern `deleted-test-file-takes-coverage-of-surviving-code-with-it`). Split its assertions into those whose subject is gone and those that exercise code that still ships; port the second set to a surviving test file, then delete the rest.
   - **Articles.** `knowledge_update` each owning article to say what happened: `state: "deprecated"` (or the article's ownership rewritten when only part of it died), with the dead paths dropped from `files[]` and a history entry. `knowledge_retire` is for a genuine duplicate only, never for a feature that was deleted.
   - **Board and queue.** Entries are removed by the deletion artifact (P4). Removal operations take the exact full UUID, never a prefix.

Cleanup is its own unit of work — an implementor told to "tidy while you're at it" is out of scope by design.
