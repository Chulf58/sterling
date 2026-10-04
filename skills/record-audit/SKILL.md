---
name: record-audit
description: Run the periodic sampled audit of knowledge records — the part of record upkeep that code cannot check, such as one decision quietly contradicting another or a hazard record whose hazard was fixed. Use when the user asks to audit the knowledge store or a record type, or when the conductor judges the store is due one. Not for the dead paths and findability lint that bin/check-record-hygiene.mjs already lists.
---

# Record audit SOP

Decision `record-audit-dead-records-superseded-stale-findings-by-age-report-arm-plus-sampled-audit` (user-ruled 2026-10-03). It rules two arms. The reporting arm is code and runs inside `npm run check`: dead `file_keys` and locations, acceptance criteria without a `live_test_ref`, dead test paths, and the findability lint. It never fails a merge. This SOP is the second arm, a sampled audit of every record type for what code cannot see. Method: finding `first-audit-of-all-knowledge-record-types-and-article-tests-october-2026`.

## When to run it

On demand only (user-ruled 2026-10-03, through the question form). Run it when the user asks, or when the conductor judges the store is due and says why. There is no schedule, no reminder and no mechanism that starts it.

## 1. Run the report arm first

```
node "${CLAUDE_PLUGIN_ROOT}/bin/check-record-hygiene.mjs" . --all
```

Run it from the project root. The `.` names the project to audit; without it the script audits the plugin's own directory. It reads a snapshot of the store and lists every dead path, missing test ref and findability problem. Those records are already known. Work them as ordinary fixes (step 4) and keep them out of the sample, so the audit spends its attention on defects code cannot find.

## 2. Draw the sample

Per record type: `decision`, `anti_pattern`, `research_finding`, `reference_material`, `open_question`, `disconfirmed_hypothesis`, and `feature_article`. Take `knowledge_query` with the type filter and `projection:"digest"`, paging until `capped` is false, because a capped page is a window, not the population. Take 8 records per type by default (user-ruled 2026-10-03), so results stay comparable with the first audit. Whoever starts the audit may state a different number in the brief. Spread the sample across record age, oldest to newest. Do not take the newest records only. In the first audit every sampled record from before the 2026-09-19 takeover had a defect, so old records are where defects sit.

Write down the population per type and anything left out (a type with no records, a type skipped). The finding states them in step 5.

## 3. Check each sampled record

Dispatch a `researcher`. It is read-only and holds no store-write grant, which is what an audit wants. The brief names the sampled ids and asks for the verdict per record, with the evidence behind each. Before acting on a verdict, the conductor opens the record with `knowledge_get` itself, because a digest locates and does not prove.

For each record, with `knowledge_get` in full:

- **Is the subject still there?** Open each path in `file_keys`, `files[]` or `location` at HEAD. A record whose fixed hazard, dropped design or deleted draft is gone has no subject.
- **Does it still hold?** Read the cited code or document and compare it with the record's claim. An anti-pattern whose hazard was fixed, or a decision that describes a design the code no longer has, fails here.
- **Does a later record contradict it?** Query the store by the record's own terms and `file_keys`. A decision contradicted by a later user-ruled decision but never superseded is the defect to find. This is the check no script runs.
- **Is it still open?** An `open_question` already settled by a ruling is dead.
- **Does an acceptance criterion's test still test it?** For a `feature_article`, open the `live_test_ref` and read what the test asserts against the criterion.

The researcher returns one verdict per record: `holds`, `fix forward`, `dead`, `duplicate` or `unclear`, each with a `file:line` or record id as evidence.

## 4. Act on each verdict

- **Holds.** Nothing to write.
- **Fix forward.** The claim is partly wrong or a path moved. `knowledge_update` the record, because the correction supersedes the error. Keep the narrow fields (title, statement, trigger) short and subject-dense and put evidence in `guidance` or `rationale`, per decision `make-records-findable-authoring-rule-disclosure-lint-then-blind-experiment`.
- **Dead.** The subject is gone. Supersede the record with a short record saying what happened, so delivery stops and the history stays readable. Do not keep a dead record active and do not retire it. The agent does the clear cases unattended. An unclear case goes to the user through the question form. `knowledge_supersede` works for decision, anti_pattern and research_finding, which are replaced by a record of their own type. A dead reference_material, open_question or disconfirmed_hypothesis is closed with `knowledge_supersede` too: pass `type: 'decision'` or `'research_finding'` and the closing note's complete `fields`. An open_question that was answered is not dead: close it with `knowledge_update`, setting `resolution_status: 'closed'` and `closed_into`. A dead feature_article is not superseded (user-ruled 2026-10-03, because an article keeps its own lifecycle): set its `state` to `deprecated` with `knowledge_update`, and the cleanup run removes its files.
- **Contradicted by a later record.** Supersede the older record when the later ruling replaces it. When the two are both live and the store does not say which governs, put the conflict to the user through the question form. A ruling exists only if it came through that form.
- **Duplicate.** `knowledge_retire(id, in_favor_of)` only for a true duplicate, never for a record that is merely wrong.
- **Stale finding.** A `research_finding` past its volatility clock already surfaces as a `stale_research` queue item. Drain it with `/sterling:drain` instead of re-verifying it here.
- **Unclear.** Do not guess. Put the record and the evidence to the user through the question form.

Before any write, run `knowledge_preflight` on the record's subject, phrased in the store's own terms. Write the closing note and any rewritten prose plainly, and run `sterling:de-ai-writing` over them first.

## 5. Record the result

The result is a `research_finding`, as the first audit's was. The `answer` states the sample size, the population per type, what the audit left out, the defect rate per type and the ids of the records changed. A finding that measured only part of the store says so, because an unstated gap reads as having measured all of it. Cite the decision above by slug.

A defect pattern the audit keeps finding (the same kind of record dying the same way) is a candidate for a check or an authoring rule. Put it to the user. Do not add a gate on the strength of one audit.
