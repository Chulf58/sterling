# Corrections to the dome-farmer assessments (2026-08-28 and 2026-08-29)

**Measured against:** Sterling `v0.13.0` (`.claude-plugin/plugin.json`), clone HEAD `00fbb154` on branch `feedback/consumer-2026-08-28`, 2026-09-01.

Your three assessment/retrospective pairs were triaged in full: the 2026-08-28 pair into 27 board items, the 2026-08-29 pair into 23 findings (6 duplicates, 9 extending existing items, 8 new items or checks). A fix campaign — *consumer-feedback-2026-08-28* — covers all of it and is still running.

This document is the **correction half**: findings below describe a Sterling that did not exist when you measured, or capabilities that already existed and were missed. None of it weakens the reports' value — several of them relocated real defects (discoverability, version-visibility) that are themselves now fixed. The last section lists what your findings actually shipped.

---

## 1. Already existed when you measured

1. **`knowledge_preflight` — your #1 structural ask.** You wrote that "no pre-write 'what governs this subject' query exists; the `same_subject` echo arrives after the create." It shipped **2026-08-10** (commits `c0219fd`, extended `1ce158d`), eighteen days before your 2026-08-28 session. It is exactly the operation you described: pre-write, subject-not-path, four governed record types, an `ungoverned` verdict usable as a real absence answer, and a batch agenda mode (`texts`). Your own blind-spot list (§7) names it among the tools you did not exercise.
   *What we fixed on our side:* nothing routed you to it at the deciding moment. The consumer contract template now names it at both decision points — asking the user a question, and drafting a record — with this incident attached (commit `34bca3e`), and an **AskUserQuestion pre-ask deny** now stops a strongly-governed question before it reaches the user at all (decision *AskUserQuestion deny-once pre-step*, `68332e4b`, shipped 2026-08-24).

2. **8-char id prefix resolution.** "`knowledge_get` cannot resolve 8-char prefixes" — resolution shipped **29 days before** your session (decision *knowledge_get resolves 8-char id prefixes across mounted stores; ambiguity refuses loudly*, `27f148c2`, later widened by *one id-resolution ladder for the whole knowledge surface*, `2debab53`). Full uuid, exact slug, and unambiguous 8-char prefix all resolve across the read/update surface (`get`, `append`, `edit`, `update`, `retire`, `link`). Destructive calls (`board_remove`, `maintenance_remove`) still demand the full id — deliberately, not as an oversight.

3. **test-writer `Edit` grant.** "test-writer has no Edit" — granted **17 days before** your session (decision *test-writer gains Edit + MultiEdit, and H18's matcher widens in the same change*, `cc3af9db`). The grant and its guarding wall moved together, which is why it is one decision and not two.

4. **`board_query` `objective` filter — your #1 cheap fix in the 2026-08-29 list.** You reported "no objective filter… had to page all ~306 items and filter client-side." The parameter exists and works (re-verified in live use 2026-08-31). It exact-matches the objective grouping key; `objective:"standalone"` selects ungrouped items.

5. **Knowledge-side staleness signal.** Your ask was a `knowledge_verify(id)` or a "⚠ owned files changed" marker. `knowledge_query` results already carry `baseline_drift {changed[], unverifiable?[], note}` per record whose owned files moved since the bytes it was written against, and the envelope's `provenance` states whether that check ran at all — so an *absent* annotation is disclosed as unavailable rather than implying freshness. A read-only recompute-on-demand beyond this stays on our board in case the annotation proves insufficient.

6. **Create-time conflict surfacing.** The `same_subject` echo on `knowledge_create` and `knowledge_preflight` before it are the designed pair — preflight is the correctly-timed half. The `check_skipped: dedup-merge (not_built)` line you quoted refers to a further unbuilt merge-assist, **not** to the conflict check itself.

7. **Direct-mode `agent_exit` / `handoff_write` refusal.** "Roster agents report 'no run is active'." The loud, explanatory refusal is deliberate (decision *agent_exit/handoff_write/handoff_read name conductor-direct explicitly when no run is active*, `391fae4f`) — a silent no-op could swallow a real pipeline exit. Since your report the refusal **text** has been shortened to a one-line shape (commit `322595e`) so it costs less context while still naming conductor-direct mode. The live half of your finding — agents still burning the call despite template instructions — is real, reproduced at HEAD, and boarded for a mode-aware tool-availability ruling.

---

## 2. Already fixed before you measured — the report-currency class

8. At least three of the 2026-08-28 claims describe **pre-fix code your clone was running**: the two grant/resolution items above plus the pre-write query. We measured the root cause and fixed it (research_finding *agent sync reaches only registered projects*, `73429a21`): `/sterling:update`'s per-project agent sync only visited projects present in the shared project registry, so a project with Sterling agents installed but absent from that registry stayed frozen at its install date **indefinitely** while its clone fast-forwarded normally. It was neither clone lag nor the locally-modified refusal — the sync simply never ran there, silently, in both directions.
   *Shipped since:* the session-start banner now compares every installed agent's template hash against the clone and warns per project, and the update fan-out reports installed-but-unregistered projects (merged at `eebac64`).

---

## 3. Going forward — stamp the version you measured

9. The consumer contract template now carries a standing rule (commit `34bca3e`, `templates/target-claude-md.md`): **any report about Sterling's behavior states the version and commit it was measured against** — the `version` field in your clone's `.claude-plugin/plugin.json` (the same value the session-start banner prints) plus the clone's HEAD commit — and runs `/sterling:update` first if the clone might be behind. An unstamped report cannot be triaged; it can only be re-verified claim by claim, which is exactly the tax both sides paid this round. This document carries its own stamp at the top for the same reason.

---

## 4. How to consume this document

1. In your Sterling clone, run **`/sterling:update`**. It fast-forwards to origin's default branch (or refuses — it never hand-merges), rebuilds, re-bakes machine artifacts, and syncs installed agents across every registered project.
2. **Relaunch the CLI** so the updated plugin, hooks and MCP server are the ones actually running. An updated clone in an old session is the same staleness class as §2 above.
3. Confirm the banner's version line, then read this document.
4. If a project of yours has Sterling agents installed but never appears in the session-start project listing, it is unregistered and its agents are frozen — re-run `/sterling:init` there (or tell us) so the sync reaches it.
5. **For your next report:** stamp it (§3). We can then triage it against the exact bytes you ran.

---

## 5. Since your report — fixes your findings drove

Not a changelog; these are the items traceable to your two reports.

**Shipped:**

- **Queue truth-at-read** — reconcile items now annotate whether their drift still reproduces, and keyless items gain a measured age, so an already-paid item reads as closeable instead of as work (your board-staleness and queue-noise findings; commit `c3ab5c2`).
- **Stale delivery payloads** — lifecycle status now flows through one shared formatter, and the drain re-resolves through current render recipes, so a stale payload is never served silently (`7acfcce`).
- **H17 misclassification** — the "ENVIRONMENT DEFECT" label after a Pre-arm denial (you confirmed it at HEAD) is reclassified as *missing Pre-evidence*, with the templates retrained and the stale registration prose fixed (`cfa06e7`).
- **Agent-template staleness warning + unregistered-project reporting** — see §2.
- **Version-stamp rule + `knowledge_preflight` routing prose** in the consumer contract template (`34bca3e`) — see §1.1 and §3.
- Adjacent campaign work your findings sit beside: the review-receipt ledger's refuse-flip and external-review verbs, the `open_question` record type, a read-only `git` wrapper, and a leaner H23 output-axis payload (your drop recommendation was pre-checked — one "save" in the tally came from a different mechanism, but one is structurally output-only, so the ruling landed on *raise the threshold and cut the payload to one pointer*, not *drop*).

**Boarded, ruling pending:**

- **H26 overlap advisory** firing on read-only lanes and on ⛔-FORBIDDEN files — accepted as a scoping defect, with your 9-for-9 measurement as the corpus.
- Mode-aware tool availability for direct-mode roster agents (§1.7).
- The resource-claim primitive, `knowledge_render` for external reviewers, and a verified-facts dispatch channel.

---

*Questions on any item here are welcome — reply against the numbered sections.*
