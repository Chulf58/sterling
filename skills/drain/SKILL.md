---
name: drain
description: Drain the maintenance queue (§3.2.7) — work each system item to its fulfilling artifact, then remove it. Delegates the gated reasons (deletion → cleanup, promotion → human-gated) to their own SOPs; never removes an item it did not actually fulfil.
---

# Drain the queue SOP (§3.2.7)

Trigger: /sterling:drain, the H1 banner maintenance count, or a TUI queue review. Scope: the **SYSTEM maintenance queue** (`maintenance_query`, i.e. `board_query` source `system`) **outside an active run** — a live run's reconciliation is H9 / dispose-run territory, not this. The user board (source `user`) is the human's own surface — never auto-removed; report its count only.

The one rule the queue runs on: an item leaves **only** via `board_remove`, and only **after** its fulfilling artifact actually exists (P4 — done = removed by the artifact-write; system removals are logged to the queue-drain audit trail). Removing an item you have not fulfilled makes the store lie — the exact drift the queue exists to prevent.

1. **Snapshot first, act second.** `run_state` — if a run is active, stop (its queue is not yours to drain). Then `maintenance_query`, group the items by `system_reason`, and report the counts before touching anything.

2. **Fulfil the knowledge-debt items** — one item → one fulfilling artifact → `board_remove`:
   - `reconcile_needed` — read the owning article (`feature_link`) and the touched files. **Verify the code is green first** — run the owning toolchain's tests; never reconcile an article to describe broken code. Then `knowledge_update` **every affected** article (what_it_does, ACs, files[], a history entry), following `relies_on` / `relied_by` — not only the one named. Then `board_remove`.
   - `capture_owed` — capture the session's knowledge **born structured** (`decision` / `anti_pattern` / `research_finding`, or article reconciliation), never parked in a note. Then `board_remove`.
   - `article_missing` — `knowledge_create` the owning `feature_article` (or, for a governing doc, the repo-located `reference_material`) for the unowned `file_keys`. Then `board_remove`.
   - `refresh_reference` — re-read the cited reference, confirm it still holds, `knowledge_update` to clear the stale flag. Then `board_remove`.
   - `stale_research` — re-verify the `research_finding`'s claim (dispatch a `researcher` if it needs the web), update both clocks. Then `board_remove`.
   - `wire_in_dormant` — wire the dormant article's feature in; if it is genuinely abandoned, route to cleanup instead. `board_remove` once resolved.

3. **Delegate the gated items — never auto-resolve them inside a drain** (P1: keep the gate where being wrong is costly):
   - `deletion_candidate` → hand to `/sterling:cleanup` (the §8.4 gated deletion SOP). Leave the item; cleanup's deletion artifact removes it.
   - `promotion_review` → present the candidate to the human as a keep-or-promote decision; only on yes run `knowledge_promote` (promoting drains the matching review). Never auto-promote.
   - `known_gap` → route to `/sterling:debug` or a feature follow-up; leave the item for that work to clear.

4. **Verify + close.** `npm run check` and the touched toolchains' tests green. `maintenance_query` again: the queue is empty, or holds only the gated items you delegated and reported. State what was drained (the drain log is the audit) and what was handed off, to whom.

Drain is never a place to invent a reconciliation or claim a capture you did not perform — and never a back door around the cleanup or promotion gates.
