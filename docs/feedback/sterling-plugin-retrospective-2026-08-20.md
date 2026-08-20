# Sterling plugin retrospective — 2026-08-20

**Project:** dome-farmer (Godot 4.6 + GDScript + Blender, Windows).
**Session shape:** one large slice, start to commit. Branch `feat/asset-pack-swap`, `57d6d35` → `51a07ed`.
**Agents dispatched:** 9 (1 explorer recon, 1 debugger render, 1 explorer map, 1 coder across 5 resumes, 3 librarian passes, 1 explorer re-verify, 1 general-purpose measurement).
**Prior retrospectives exist** — 22 files in this series, 2026-08-14 through 2026-08-19. This is a fresh account, not a revision.

> **Focus requested by the user:** the article-length / oversize problem, which dome-farmer appears to be the only project to have hit, and which the user expects to worsen. That is treated in depth in the companion assessment file, §A of Part B. This file carries the session evidence.

---

## 1. Where it genuinely helped — with receipts

**The strongest cases this session were H20 deliveries that landed on my own briefs before a fan-out multiplied them.** That is the plugin working exactly as designed, and it happened four times.

### 1.1 H20 prevented me from shipping a wrong premise to a coder (the highest-value firing of the session)

I was about to instruct an agent to delete a socket-frame correction. H20 fired on the dispatch and delivered `770b6bdf`:

> *"REMOVING A HOLD-BACK BRANCH THAT SAT FIRST IN A CLASSIFIER DOES NOT RESTORE THE CORRECT CLASSIFICATION — it un-shadows nothing, because the rule that SHOULD have matched sits below and does not match either, so the row falls to a default that is wrong in a brand-new way."*

I turned that into an explicit question in the brief ("what value does the socket receive after withdrawal — the vendor's, or a default?"). The explorer proved the fallthrough was a bare assignment one line above, not a classifier arm, so the withdrawal was safe. **Without the delivery I would not have asked, and I would have shipped a 38-row asset re-export on an unchecked assumption.**

### 1.2 H20 delivered the record that told me to look for a governance clause

Same dispatch, `74e0345a`: *"ADJUDICATING A CHANGE WITHOUT READING THE TARGET FILE'S OWN GOVERNANCE CLAUSE."* I added a mandatory step-zero to the brief. The explorer found two clauses in `export_part_library.py` that nobody had cited in this campaign, and they **reversed the direction of the fix**. Verbatim, one of them:

> `STATIC   the socket is placed at 'local_blender' UNCHANGED, and 'part.corrected' is deliberately NOT subtracted. ⚠ THIS IS THE OPPOSITE OF WHAT THE STAGE-2 RE-ORIGIN LOOKS LIKE IT IMPLIES, and the first draft got it wrong`

**This is the single best thing the plugin did all session.** A record about a *class of mistake* caused a targeted search that found project-specific governance no query would have surfaced.

### 1.3 H20 validated a hold I had already made, at the moment I made it

I refused to rule four render plates because "the socket is inside the hull" and "the probe stopped drawing" explained the same blank image equally well. On the next dispatch H20 delivered `bfc53113`:

> *"RULING A ROW WHILE A KNOWN RENDER DEFECT IS STILL IN THE PIPELINE — the plate is evidence about the BUG, not about the part … the moment you notice you are CHOOSING between two explanations of the same image rather than being FORCED to one, you do not have evidence yet."*

The hold was already correct; the record supplied the *release condition* (fix the defect, re-render the same batch, open both) which I then used verbatim. **A retrospective note: this fired AFTER my decision, not before it. It confirmed rather than caused. That is still worth something, but it is a weaker mode than 1.1.**

### 1.4 H20 answered a live user question with an existing record

The user asked, mid-session, whether articles have to be so long. H20 had just delivered `4c7a977a`:

> *"A STALENESS WARNING WRITTEN INSIDE THE ARTIFACT IT WARNS ABOUT IS NOT A CONTROL — the tracker that opened with 'this item drifted by 40 rows, NEVER copy these numbers forward' then drifted by 60 more."*

Its prescribed remedy — *"DELETE THE NUMBER, KEEP THE COMMAND"* — is a concrete lever that makes records **shorter and more correct at once**. The store had already diagnosed a cause of its own obesity. Nothing consumes that diagnosis (see §13 of the assessment file).

### 1.5 H19 pointer delivery, on a Bash command, carried a load-bearing record

A `git`/`ls` command naming `tools/blender/mech_port/export_part_library.py` produced a pointer list including `0c94cc59` — *"a part plate renders GEOMETRY, so a corrected SOCKET is invisible in it."* That record governed the entire verification strategy for the session and would otherwise have been found late, after wasted renders.

---

## 2. Friction — where the plugin fought the task

### 2.1 The frontier/article-missing check has no ignore-file awareness. This is the top friction item and it is not new.

`tools/blender/out/` is gitignored (`.gitignore:74`), by explicit user ruling, precisely so ~2,900 generated plates are never committed. **H10 and H19 have no knowledge of that, and treat every file there as unowned territory needing an article.**

Counted from this session's transcript:
- **H10 article demands on `tools/blender/out/` paths: 4 separate firings**, naming `_withdraw_predict.py`, `_bumper_fbx_trace.py`, `_withdraw_bbox_check.py`, `_hs_traceback.py`, `_rule_smoke.py`, `_audit_new_manifest.py`.
- **H19 `FRONTIER SIGNAL … is UNOWNED` on plate PNGs: 7 firings**, one per image I opened to rule.

Every one is a false positive **by the project's own written ruling**. An article owning a gitignored scratch file is drift by construction: the record outlives the session, the file cannot.

**The cost was not just noise.** To stop re-litigating it every turn I had to author a `decision` record (`gitignored-scratch-under-tools-blender-out-gets-no-owning-ar`) whose entire content is *"the hook is wrong on this path"*. **That is a consuming project paying, in its own knowledge store, to document a plugin gap.** And it does not stop the firing — H10 demanded an article for an `out/` file again two turns after the decision was written.

**Fix shape:** `article_missing` and the frontier signal should consult the repo's ignore rules (`git check-ignore --quiet`) before raising. One call per path, and the check already exists in git.

### 2.2 Three articles are now too large for an agent to read at all

- `mech-part-export` — 67,557 chars non-history, **100,670 total**
- `probes-mech-assembled-plates` — **70,994 chars**
- `dev-toolchain-setup` — ~67,000 chars

A librarian reported verbatim: *"`mech-part-export`'s full body (100,670 chars / 67,557 chars non-history) overflowed `knowledge_get`; I worked from the saved overflow file plus targeted `Grep`/`knowledge_edit`."* On another it simply failed: *"could not fully open the 67KB record (chunking failed)."*

**Two concrete costs, both realised this session:**
1. A `capture_owed` maintenance item (`a9f30d3c`) **cannot be closed**, because its target article cannot be opened to verify the capture landed. The queue now contains an item that is structurally undrainable.
2. A reconcile was applied to `dev-toolchain-setup` **without reading its prose**, and the agent honestly flagged it: *"judged low-risk for a baseline refresh … worth a spot-check."* **A baseline refresh silences the queue item.** So if that article does carry stale content, the only mechanism that would ever have raised it has now been switched off by the act of not reading it.

That second one is the real danger and it generalises: **an article that cannot be read cannot be reconciled, so every future reconcile against it degrades into a refresh taken on faith.** Full treatment in the assessment file.

### 2.3 Every update mints a new id, and prose citations rot inside a single session

I cited three record ids that changed under me **within this session**:
- board item `523cc308` → `9d91f1c8` → `f33dbbe3` (two edits, three ids)
- campaign tracker `c1e88168` → `22a16d04`
- displacement item `12ccff28` → `d17ec4d4`
- the governing decision `9626b233` → `6cd6ce66` after one `knowledge_edit`

The store's own guidance is "resolve by slug", and that works — but **board items have no slug**, so a board item can only be cited by an id that is guaranteed to change the next time anyone edits it. I wrote a rotation note citing board ids; several were already stale before the note was consumed.

### 2.4 The board is past the point of being auditable

`board_query source:"user"` returned **`matched_filter: 256`** with `cap: 40`, `capped: true`. The project's own discipline rule says *"a board too large to read is a board nobody will audit."* At 256 items nobody audits it, and the digest projection — which is genuinely good — still only shows the first 40.

### 2.5 The rotation note went stale within its own session

I wrote the note with "queue 47 → 37 → lower (a librarian is applying two final edits)". Those edits landed two minutes later and the count reached 35. **A single-slot note written before the last lane finishes is a note that lies about in-flight work.** I rewrote it; the mechanism did not warn me.

---

## 3. Wrong information — including mine

**Records that were wrong at HEAD and had to be fixed forward:**

| record | the stale claim | how it was caught |
|---|---|---|
| `6cdc8e05` (anti_pattern) | `FORM_COUNTS {'bone':12,'created_colocated':12,'empty':6}` | an explorer counted the artefact: 12 rows, 6 `authored_overridden` + 6 `bone`, and **no `_keep(e,"empty",...)` call site exists any more** |
| `5a3955fa` (anti_pattern) | a `continue`-before-placement bone branch is open | closed at HEAD; the branch now reaches `_place_local` |

Both were corrected forward. **Note the shape: both are anti_patterns whose LESSON is still perfectly valid and whose MEASUREMENT rotted.** The type has no way to mark "the lesson is durable, the census is dated", so the correction has to be appended as prose — which is one of the mechanisms making these records grow (assessment file, §A).

**Wrong information I produced:**

1. **My own over-read of a governance clause, relayed into a brief.** I read the clause in full, quoted it accurately, and applied it to the wrong quantity — it governs `part.corrected` (a stage-2 datum) and I applied it to `_stage1_discarded` (a stage-1 discard). I then instructed a coder to move a repair to the geometry side. The coder went to the vendor's files, measured, and returned **BLOCKED** with the correction. Captured as a new anti_pattern. **Cost: one agent round. Nothing in the plugin could have caught this** — see the "Nothing" rows in §5.

2. **A recon agent cited `tools/blender/mech_part_export.py`, which does not exist.** `mech-part-export` is an *article slug*; the file is `tools/blender/mech_port/export_part_library.py`. I caught it with one `ls`. **This is a recurring hazard of slug-shaped names that look like paths**, and it is worth noting that the agent had just read the article — the slug was in its context and became a path.

3. **I dispatched an `explorer` to re-derive a count that requires headless Blender.** An explorer has no Bash. It correctly refused. **Cost: one round.** The plugin has a record about exactly this (`55577e13`) and it did not fire, because H20 matches on prompt subject, not on the agent's declared tool list — which is structured data the dispatcher already holds.

---

## 4. Too much / too little information

**Two deliveries were large enough to be spilled to files this session:**
- H1 SessionStart context: **10.3 KB**, persisted to `hook-…-additionalContext.txt`.
- H19 Bash pointer delivery: **15.9 KB**, persisted. That one listed **45 pointer lines** across two paths — every anti_pattern and article owning `export_part_library.py` and `manifest.json`.

**Fraction actually used:** of those 45 pointers I acted on **4** (`0c94cc59`, `5a3955fa`, `6cdc8e05`, `74e0345a`). The other 41 were correctly *related* and not relevant to the change in hand. That is not a failure of relevance ranking so much as an absence of it: the delivery is "everything that touches this path", unranked, and the two paths I touched are the two most heavily governed files in the project.

**H20 deliveries** ran ~2–4 KB per dispatch across 9 dispatches, and had a much better hit rate — roughly **1 in 3 deliveries changed a brief**. The mechanism-axis match is the more useful of the two.

**Under-delivery:** none observed this session. I did not hit a case where the store held something relevant and no mechanism surfaced it — with one exception, which is the interesting one: **`4c7a977a` (staleness warnings are not controls) is a record about the store's own health, and it reached me by accident**, delivered on an unrelated dispatch, at the exact moment the user asked about record length. Nothing routes store-health records to store-health decisions.

---

## 5. Hook-by-hook

| hook | fired | verdict |
|---|---|---|
| **H1** (session start) | 1 | **Good.** Restored and consumed the rotation note correctly; disclosed queue depth (20 drainable / 26 file_parked) and named the lanes. The single most useful automatic thing in the plugin. |
| **H4** (test-writer blindness) | 0 | Not exercised — no test authoring this session. |
| **H7** (reconcile on touch) | ~8 implied | **Correct but self-amplifying.** Our own store writes generated 7 of the 8 `reconcile_needed` items we then had to drain. The queue grew 36 → 47 as a direct result of draining it. |
| **H10** (capture + article demand) | ~6 | **Split verdict.** The *capture* half was right every time and produced two records I would otherwise have deferred. The *article* half was wrong 4 of 4 times (§2.1). |
| **H14** (agent bash allowlist) | agent-scoped | Not directly observed; one agent reported reformatting by hand because bare `gdformat` is denied — **that denial is correct** and produced the right behaviour. |
| **H19** (path-scoped delivery) | ~12 | **Useful on code paths, false on ignored paths.** 7 frontier false positives on gitignored PNGs. |
| **H20** (mechanism-axis delivery) | 9 (every dispatch) | **The best mechanism in the plugin.** See §1.1–1.4. Post-answer on `AskUserQuestion` and honest about it. |
| **H21** (hand-write watch) | 6 | **Advisory and accurate.** Every write it flagged was one of the three named exceptions. It never blocked; it did make me reconsider twice. Low cost, mild value. |
| **Nothing** | — | **No mechanism caught my governance-clause over-read.** An agent did. |
| **Nothing** | — | **No mechanism warned that an `explorer` cannot run Blender** before I briefed it to. |
| **Nothing** | — | **No mechanism prevents, warns about, or measures article growth.** Three articles crossed into unreadability with the only signal being a `article_oversize` queue item that says "split it" and is itself undrainable. |
| **Nothing** | — | **No mechanism noticed the rotation note had gone stale** between writing and consumption. |
| **Nothing** | — | **No mechanism flagged that a `baseline refresh` was applied to an article nobody read.** The agent's honesty was the only control. |

---

## 6. What I did not exercise

Stated so this does not read as a review of everything: **no pipeline/run was started** (conductor-direct throughout), so `run_state`, `run_signal`, `run_escalate`, the phase machine and the disposal gate are unassessed. **`/sterling:cleanup`, `/sterling:init`, `/sterling:merge` and the council were not used.** The TUI was not opened. `knowledge_promote` was never called — two `promotion_review` items were closed as *not promoted*, so the promotion path itself is untested here. `knowledge_retire` was not used.

---

*Companion file: `sterling-plugin-assessment-whole-system-2026-08-20.md` — the design review, including the article-length analysis the user asked for.*
