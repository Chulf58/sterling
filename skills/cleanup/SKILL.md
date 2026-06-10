---
name: cleanup
description: Gated deletion run SOP (§8.4) — the anti-accretion mechanism. Deletion earns full plan→grill→execute→review rigor; never a side-job inside a feature phase.
---

# Cleanup SOP (§8.4)

Trigger: /sterling:cleanup or maintenance-queue review. Input: `deprecated`/`dormant` articles + `deletion_candidate` queue entries. The articles' file/dependency data is the evidence that makes deletion safe.

1. **Deletion plan:** from the candidate articles, list exactly which files/exports die and which articles claim dependents. No dependents = deletable; any active `relied_by` = blocked until released.
2. **Grill:** "these N dormant features own these files with no active dependents — confirm each." One at a time; the human confirms or strikes per item.
3. **Gated pipeline execution:** deletion is MORE dangerous than addition — run it as a pipeline (brief from the plan; the deletion diff is the contract; fs-remove through the contract-checked helper so file_keys stay coherent).
4. **Retirement:** the articles' traced tests retire with them; articles remain as superseded history (never hard-deleted knowledge); board/queue entries removed by the deletion artifact (P4).

Cleanup is never a side-job inside a feature phase — a coder told to "tidy while you're at it" blows the contract by design.
