# Corrections to the dome-farmer assessments (2026-08-28 and 2026-08-29) — DRAFT

Status: DRAFT (campaign S0, 2026-08-31). Finalized and delivered in campaign S3. Measured against Sterling HEAD 3357192 (v0.13.0).

Your three assessment/retrospective pairs were triaged in full: the 2026-08-28 pair into 27 board items, the 2026-08-29 pair into 23 findings (6 duplicates, 9 extending existing items, 8 new items or checks). An active fix campaign covers all of it. This document is the correction half: the findings below describe a Sterling that did not exist when you measured, or capabilities that already existed and were missed. None of this weakens the findings' value — several relocated real defects (discoverability, version-visibility) that are themselves being fixed.

## Already existed when you measured

1. **`knowledge_preflight` — your #1 structural ask** ("no pre-write 'what governs this subject' query exists; the same_subject echo arrives after the create"). It shipped 2026-08-10 (commit c0219fd, extended 1ce158d; decisions 7491b0cf / e411eda9) — eighteen days before your 2026-08-28 session. It is the described operation: pre-write, subject-not-path, four governed types, an `ungoverned` verdict usable as a real absence answer, and a batch agenda mode (`texts`). Your own blind-spot list (§7) names it among the tools you did not exercise. What we fixed on our side: nothing routed you to it at the deciding moment — the consumer template now names it at both decision points (question-asking and record-drafting) with the incident attached, and an H20 pre-ask deny (shipped 2026-08-24) now stops a strongly-governed question before it reaches the user at all.
2. **8-char id prefix resolution** ("knowledge_get cannot resolve 8-char prefixes") — shipped 29 days before your session (27f148c2 + decision 2debab53). Full uuid, exact slug, and unambiguous 8-char prefix all resolve on the read/update surface; destructive calls still demand the full id on purpose.
3. **test-writer Edit grant** ("test-writer has no Edit") — granted 17 days before your session (decision cc3af9db).
4. **`board_query` `objective` filter — your #1 cheap fix in the 2026-08-29 list** ("no objective filter... had to page all ~306 items and filter client-side"). The parameter exists and works (verified in live use 2026-08-31); it exact-matches the objective grouping key, and `objective:"standalone"` selects ungrouped items.
5. **Knowledge-side staleness signal** (your `knowledge_verify(id)` / "⚠ owned files changed" ask): `knowledge_query` results already carry `baseline_drift {changed[], unverifiable?[], note}` per record where owned files moved since the record's baselines, and the envelope's `provenance` states whether that check ran — an absent annotation is disclosed as unavailable rather than implying freshness. A read-only recompute-on-demand beyond this is on our board if the annotation proves insufficient.
6. **Create-time conflict surfacing**: the `same_subject` echo on `knowledge_create` plus `knowledge_preflight` before it are the designed pair (preflight is the correctly-timed half). The `check_skipped: dedup-merge (not_built)` line you quoted refers to a further unbuilt merge-assist, not to the conflict check itself.
7. **Direct-mode `agent_exit`/`handoff_write` refusal** ("roster agents report 'no run is active'"): the loud, explanatory refusal you saw is deliberate (decision 391fae4f — a silent no-op could swallow a real pipeline exit). The live half of your finding — agents still burning the call despite template instructions — is real, reproduced on current templates, and boarded for a ruling (mode-aware tool availability).

## Already fixed before you measured (report-currency class)

8. At least three 2026-08-28 claims describe pre-fix code your clone was running: the two grant/resolution items above plus the pre-write query. Root cause on our side was measured and fixed: agent sync only reached registered projects, so installed agents could freeze at their install date while the clone updated cleanly. Shipped since: H1 now compares every installed agent's template hash against the clone at session start and warns per project, and the update fan-out reports installed-but-unregistered projects (merged at eebac64, 29 pinned arms).

## Going forward — version-stamped reports

9. The consumer template now carries a standing rule (commit 34bca3e): any report about Sterling's behavior states the version (`.claude-plugin/plugin.json`) and clone HEAD it measured, and runs `/sterling:update` first if the clone might be behind. An unstamped report can only be re-verified claim-by-claim — exactly the tax both sides paid this round.

## What we are building from your findings (highlights, not exhaustive)

- Queue truth-at-read: reconcile items whose drift no longer reproduces get annotated as closeable no-ops (your board-staleness and queue-noise findings; design settled, in build).
- H17 "ENVIRONMENT DEFECT" misclassification after a Pre-arm denial: confirmed at HEAD, being fixed (message/classification, not the mechanism).
- H26 overlap advisory firing on read-only lanes and ⛔-FORBIDDEN files: boarded as a scoping defect with your 9-for-9 measurement as the corpus.
- H23 output-axis: your drop recommendation was pre-checked — the save tally was overstated (one "save" came from a different mechanism), but one save is structurally output-only, so the ruling space is raise-threshold / fold / cut-payload rather than drop.
- The open-question record type, resource-claim primitive, `knowledge_render` for external reviewers, verified-facts dispatch channel, and the H14 read-only git grant are all boarded for rulings.
