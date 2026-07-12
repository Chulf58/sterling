---
name: drain
description: Drain the maintenance queue (§3.2.7) — work each system item to its fulfilling artifact, then remove it. Delegates the gated reasons (deletion → cleanup, promotion → human-gated) to their own SOPs; never removes an item it did not actually fulfil.
---

# Drain the queue SOP (§3.2.7)

Trigger: /sterling:drain, the H1 banner maintenance count, or a TUI queue review. Scope: the **SYSTEM maintenance queue** (`maintenance_query`, i.e. `board_query` source `system`) **outside an active run** — a live run's reconciliation is H9 / dispose-run territory, not this. The user board (source `user`) is the human's own surface — never auto-removed; report its count only.

The one rule the queue runs on: an item leaves only **after** its fulfilling artifact actually exists (P4 — done = removed by the artifact-write; system removals are logged to the queue-drain audit trail). For the two drift lanes (`reconcile_needed`, `refresh_reference`) the fulfilling `knowledge_update` **is** the removal — the server auto-drains any open item whose `feature_link` sits in the updated record's supersede chain (decision `8ecd435f`); a `board_remove` after a genuine reconcile therefore throws `board_remove: no record`. Every other lane leaves via `board_remove`. Removing an item you have not fulfilled makes the store lie — the exact drift the queue exists to prevent.

1. **Snapshot first, act second.** `run_state` — if a run is active, stop (its queue is not yours to drain). Then `maintenance_query`, group the items by `system_reason`, and report the counts before touching anything.

2. **Fulfil the knowledge-debt items** — one item → one fulfilling artifact → `board_remove`:
   - `reconcile_needed` — first **resolve `feature_link` forward to the ACTIVE record** (chase `superseded_by` to the head of the version chain): the link is pinned to whatever version was current when H7 fired, which may be several supersessions stale, and you must never read against — or `knowledge_update` — a superseded record. Then check **whether the debt is already paid** before touching anything: a `reconcile_needed` item routinely outlives the reconcile that should have closed it (the article was updated but the item never `board_remove`d), and for a file CO-OWNED by several articles the change may have been reconciled into a *different* owner than the one named here. The mechanical "already reconciled?" signal is the content baseline (decision `57d9a52d`): a `knowledge_query` of the owning article that does **not** raise `verify_before_use` for the touched file means its `file_baselines` already matches the file's current bytes — i.e. the article was last reconciled against exactly this content. For a co-owned file, run that check on the article that actually owns the changed behavior (`knowledge_query file_keys:["<path>"] types:["feature_article"]` lists every co-owner).
     - **Already reconciled** (baseline matches / `verify_before_use` not raised, and the prose covers the change) → confirm the owning toolchain is green, then `board_remove` with **NO** `knowledge_update`. A no-op version bump whose history entry claims a reconcile that added nothing is itself drift — the closing rule forbids it.
     - **Genuinely behind** (baseline differs or is absent, or the prose lags the code) → **verify the code is green first** (run the owning toolchain's tests; never reconcile an article to describe broken code), then `knowledge_update` **every affected** article (what_it_does, ACs, files[], a history entry), following `relies_on` / `relied_by` — not only the one named. The update auto-drains the item (decision `8ecd435f`); `board_remove` only a **survivor** — an item still open because the change was reconciled into a *different* co-owning article whose supersede chain does not cover this item's `feature_link`.
   - `capture_owed` — capture the session's knowledge **born structured** (`decision` / `anti_pattern` / `research_finding`, or article reconciliation), never parked in a note. Then `board_remove`.
   - `research_owed` — write the durable knowledge record (`research_finding`, or `decision` if the finding resolves a design question) from the queries the item text carries. Then `board_remove`. If the user states nothing durable was learned from those queries, `board_remove` without creating a record — the item text carries the queries so the decision is traceable.
   - `article_missing` — `knowledge_create` the owning `feature_article` (or, for a governing doc, the repo-located `reference_material`) for the unowned `file_keys`. Then `board_remove`.
   - `refresh_reference` — re-read the cited reference, confirm it still holds, `knowledge_update` to clear the stale flag — the update auto-drains the item (decision `8ecd435f`); `board_remove` only a survivor.
   - `stale_research` — re-verify the `research_finding`'s claim (dispatch a `researcher` if it needs the web), update both clocks. Then `board_remove`.
   - `wire_in_dormant` — wire the dormant article's feature in; if it is genuinely abandoned, route to cleanup instead. `board_remove` once resolved.

3. **Delegate the gated items — never auto-resolve them inside a drain** (P1: keep the gate where being wrong is costly):
   - `deletion_candidate` → hand to `/sterling:cleanup` (the §8.4 gated deletion SOP). Leave the item; cleanup's deletion artifact removes it.
   - `promotion_review` → present the candidate to the human as a keep-or-promote decision; only on yes run `knowledge_promote` (promoting drains the matching review). Never auto-promote.

4. **Verify + close.** `npm run check` and the touched toolchains' tests green. `maintenance_query` again: the queue is empty, or holds only the gated items you delegated and reported. State what was drained (the drain log is the audit) and what was handed off, to whom.

Drain is never a place to invent a reconciliation or claim a capture you did not perform — and never a back door around the cleanup or promotion gates.
