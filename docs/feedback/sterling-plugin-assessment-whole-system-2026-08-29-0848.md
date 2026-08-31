# Sterling — whole-system assessment
**2026-08-29, 08:48.** Companion to `sterling-plugin-retrospective-2026-08-29-0848.md`, which holds the session evidence. This file assesses the **design**. Every claim is grounded in that session, but the claims are about the plugin.

**Scope limit, stated up front:** I ran conductor-direct with a large fan-out. I did not exercise runs/pipelines, cleanup, init, merge, council, or the TUI, and I do not review them. Where I say "there is no X", I name the check that established it or hedge it.

---

## 7. The record type system

**The types mostly carve the space correctly.** `decision` (a ruling with rejected alternatives), `anti_pattern` (a trap with a trigger), `feature_article` (what a mechanism does and what it does not cover), `research_finding` (a bounded question answered) are genuinely different shapes, and I used four of them for four different jobs this session without strain.

**The single best field I used: `known_gaps[].recorded_run`, which the schema makes mandatory.** An authoring lane hit the refusal and reported what it taught:

> every `known_gaps` element requires `recorded_run` as a mandatory string. There is no way to record a gap without stating which run observed it — so an un-run instrument's gaps must be stamped "not run", which is exactly the material fact you asked to be carried.

That is a schema forcing honesty rather than merely permitting it. Five articles authored this session carry `recorded_run: "NOT RUN — source read … 2026-08-29"`, and any reader can now tell a gap someone *measured* from a gap someone *suspected*. **More of the schema should work this way.**

**The clearest type gap: there is no record for an evidenced open question.** `research_finding` requires `question` + `answer`. I needed to durably record a question with three measurements, a derived geometry, two live hypotheses, and no answer. The capture lane refused to invent an answer field and used a board `todo` instead — correct, but wrong surface: the board is near-term work, the store is durable. The knowledge base can hold *what we decided* and *what we learned* but not *what we established we do not yet know*, which is the most perishable thing in an engineering session.

**Would collapsing any two lose something?** Yes, and the session gave a clean demonstration. A capture lane was asked whether a new disposition rule belonged inside anti_pattern `327b6985`. It declined, with reasoning I would not improve on:

> that anti_pattern is a DETECTION rule for one specific hollow shape […]. This is a DISPOSITION policy for what to do once you hold a red you cannot settle, whatever its shape. Detection and disposition are different questions, and a policy buried in a shape-specific anti_pattern would not be found by someone holding a different shape.

It also distinguished the new record from `e2914f79` (a *known*-cause permanent retirement) versus ours (*unknown*-cause, explicitly temporary). **The type system supported that discrimination; a coarser one would have merged three distinct rules into one unfindable blob.**

**Dead weight:** `wiring_todo_id`, `working_tree`, `concept_family` and `last_executed` did no work in anything I authored or read this session. I am not calling them useless — I did not exercise the flows that consume them — but they were pure schema surface from where I sat.

---

## 8. Identity, versioning, supersession

**Citation is durable and it worked.** Every record id I cited in a brief resolved, including 8-character prefixes. Slug resolution worked too, and the plugin correctly *refused* an ambiguous one — a librarian reported that `runtime-architecture` resolved to two records and it used the full uuid instead. **That refusal is the right behaviour** and it is the case that most commonly corrupts a store silently.

**In-place correction preserves the id, and that is the right default.** Decision `1ab2dc9c` went to v3 carrying a key correction (F, not B) while clauses 2/3/4 stood. Article `042101ba` went to v2 with one AC struck. Both kept their ids, so every brief that already cited them stayed valid. Compare the alternative: supersede-and-replace would have orphaned three briefs written earlier the same session.

**But: can a reader tell a live record from a dead one in the surface they actually use?** Partially, and the gap is real. `board_query` prints `⚠ N commits since measured` — genuinely useful, and it is the only staleness signal in the surface I read most. It flags **file movement, not claim falsification**, and this session showed both failure directions:

- Item `a250fc04` was **false at zero commits since measured**. I wrote it; its premise was already contradicted by `farm_hud.gd:1019` at the moment of writing.
- Items sat at "⚠2 commits since measured" whose entire premise had been dead for days.

**And knowledge records get no equivalent at all.** `knowledge_query` results carry no "the files this article describes have moved N commits since its baseline" annotation, as far as I saw. Article `042101ba` listed in its `files[]` the exact test file whose arms were deleted, and nothing anywhere connected those two facts. A file-hash comparison would have caught it in one line.

**Assessment against the 2026-08-14 failure this section asks me to re-check:** I hit no id-instability or supersession confusion. That class appears fixed. The *new* expensive failure is different and sits one layer up — **records that are structurally valid, correctly versioned, cleanly citable, and factually false.**

---

## 9. The tool / API surface

**What took N calls that should take one:**

**Filtering the board by objective.** `board_query` has `contains` (text only), `file_keys`, `source`, `cap`, `offset`, `projection` — and no `objective`. Two independent lanes discovered this the hard way and both had to page all ~306 items across 3 pages and filter client-side. `objective` is required by `board_add` and is how the board is organised. **`board_query objective:"..."` is the single most obvious missing parameter in the surface.**

**What had to be learned by rejection rather than documentation:**

- `known_gaps[].recorded_run` mandatory — learned from a refusal (a good refusal, but still a refusal).
- `research_finding` requires `question` + `answer` — learned by a lane attempting a write.
- `librarian` cannot create records — learned when the agent reported it mid-task.
- `contains` not matching `objective` — learned by a count mismatch, never announced.
- `board_remove` versus rewriting for a partly-done item — the librarian asked me which convention to follow rather than the tool making it obvious.

**The strongest evidence that this is a documentation-debt problem rather than an API problem** is the consuming project's own `CLAUDE.md`. It carries, in prose, the fact that `--ignoreHeadlessMode` is mandatory or gdUnit4 exits 103; that `gdformat` bare writes in place and is therefore denied; that the Godot path must be **unquoted** and the Blender path **quoted** because H14 matches a literal prefix; that `allow_scripts` **replaces** rather than extends the shipped default. Those are all plugin mechanics that a consuming project had to write down for itself. That is the API surface's documentation debt showing up as someone else's maintenance burden.

**An operation the design obviously wants and does not have:** `knowledge_verify(id)` — recompute the record's `file_baselines` against HEAD and report which files moved, without mutating anything. Everything needed for it already exists (`file_baselines` is a server-owned field). Today the only way to ask "is this article still true?" is to dispatch an agent to read the files.

**One thing the surface gets right and should keep:** `board_query`'s `projection` levels (`full` / `digest` / `headline`) and its honest `capped: true` + `note` when a result is truncated. I paged 306 items cheaply on `headline` and read `full` only for the ~30 I acted on. That is exactly the right shape for a conductor protecting a context window, and it is better than most tool surfaces manage.

---

## 10. The agent roster

**The tool lists are mostly right, and one is materially wrong.**

**Wrong: `librarian` has no `knowledge_create`.** The contract says the conductor drafts and the librarian applies verbatim. But a librarian can only *edit*, so every new record routes to a `general-purpose` agent with the full tool surface and no clerk discipline. I dispatched three such lanes. **The constraint designed to protect knowledge quality routes around itself the moment the record is new**, which is exactly when quality matters most. Either give `librarian` a create call, or add a `scribe` role that can create-from-verbatim-draft and nothing else.

**Right, and load-bearing: `test-writer` without implementation reads.** Covered in the evidence file; it is the best thing in the roster. Six refusals, six correct. The constraint produced better output than an unconstrained agent would have, and I can say that with confidence because I watched an unconstrained reviewer propose a change that would have introduced a 33.7° error.

**Right: `debugger` diagnoses and does not fix unless told.** Three debugger lanes returned verdicts, counts and `file:line` evidence with no edits. One settled a two-reviewer contradiction cleanly. The separation held.

**Work an agent structurally could not do, that I dispatched anyway — my error, twice:**
- I sent a `test-writer` at pins requiring implementation-derived signatures without supplying them. Three round-trips of refusal → fact-gathering → re-dispatch. **The fix is mine** (state every implementation constant in the work order), but the roster could help: the `test-writer` definition could require a `given_facts` block and refuse a brief lacking one, turning a mid-flight refusal into a dispatch-time one.
- I sent a `librarian` at "capture as a decision record" and it could not create.

**An observation about `reviewer-correctness` worth passing upstream:** it repeatedly reported *"No run is active — `handoff_write`/`agent_exit` are run-scoped, so this text is the deliverable."* Four reviewers said some version of this. In conductor-direct mode — which this project's own decision `73a78177` makes the *primary* mode — the roster's structured-return path does not exist, so every review comes back as prose I must parse by hand. **The agents designed for the pipeline are being used outside it, and their return contract does not follow them.**

---

## 11. The board and the maintenance queue

**Board size:** `matched_filter: 306` (later 307), `cap: 80`, `capped: true`. The tool was honest about truncation. But a 306-item board that requires 3 pages to filter by its own organising field is a surface nobody audits, and this session measured the consequence: **11 items claiming outstanding work that was already committed.**

**Maintenance queue:** session start reported 64 drainable (47 `reconcile_needed`, 13 `article_missing`, 3 `promotion_review`, 1 `capture_owed`) plus 2 `file_parked`. After the drain the librarian reported 20, then a later count showed 36.

**What fraction were already paid?** The librarian's own answer is the interesting one:

> **Zero already-paid closures found** — every reconcile item's article genuinely predated its file_keys' last touch.

Taken at face value, the queue's precision on `reconcile_needed` was 100%. But the same lane disclosed:

> No per-diff content review was performed on any of the 46 discharged reconcile items — I trusted the "changed on disk / settled, no contradiction flagged" classification rather than opening each article's diff against its file.

So the queue correctly identified that **a file changed**, and nobody established whether the article's **content** was thereby wrong. 46 articles took a version bump asserting a reconcile that may have added nothing — which the plugin's own drain guidance names as drift in its own right. I boarded it (`7503f84b`). ⚠ This is the second time the project has recorded this exact pattern (board `6ebd758e` records ~47 items re-baselined the same way earlier). **A drain that is cheap to satisfy mechanically and expensive to satisfy honestly will be satisfied mechanically, every time, by a tired session.**

**Did the queue mislead, and in which direction?** The maintenance queue did not mislead. **The board did, heavily, and in the dangerous direction** — claiming work was OUTSTANDING rather than claiming a defect was LIVE. A false "this is broken" gets falsified the moment someone looks. A false "this is missing" survives indefinitely, because nobody goes looking for what they were told is absent. Nine of the eleven stale items were of the second kind.

---

## 12. The conductor contract — enforced versus prose

| Rule | Enforcement |
|---|---|
| Read before edit | **Mechanism** (H3, content-hash) |
| Test-writer never reads implementation | **Mechanism** (H4) |
| Coders never write tests | **Mechanism** (H5) |
| Gates not masked by `;` / `\|\|` | **Mechanism** (H24) |
| Agent command allowlist | **Mechanism** (H14) |
| Store writes go through MCP | **Mechanism** (H15) |
| Code-touching commit carries a review | **Mechanism** (`commit-reviewed.mjs` + merge gate) |
| Rotation note restored and consumed once | **Mechanism** (H1) |
| Capture owed after touching files | **Mechanism** (H10) |
| **A board item states its EVIDENCE, not its conclusion** | **Prose only** |
| **Re-verify an item against HEAD before dispatching at it** | **Prose only** |
| **Close an item in the same breath as the fix** | **Prose only** |
| **A design question is always an ask** | **Prose only** (H20 deny-once covers the inverse case) |
| **Verify by mutation when changing a ruling** | **Prose only** |
| **Visual inspection is the conductor's own eyes** | **Prose only** |
| **One windowed Godot run project-wide** | **Prose only** |

**The highest-value unenforced rule is "re-verify an item against HEAD before dispatching at it."** It is unenforced, it is the one that failed, and it failed eleven times in one session at a cost of roughly eight wasted Opus lanes. Every other prose rule in that list held this session. This one did not, and it is the one with a mechanical shape available (§13.1).

**Second-highest: "exactly one windowed Godot run project-wide."** Nothing enforces it. Two concurrent runs corrupt the project's import cache and destroy every render in flight. I held that slot by hand for the entire session — carrying it in my head across ~30 dispatches, and writing a ⛔ paragraph into every single brief. **A per-project advisory lock with a named holder would have removed a whole class of catastrophic risk and about 400 words of repeated brief text.** ⚠ This is project-specific in its trigger but not in its shape: any project with a single-instance tool has it.

---

## 13. What Sterling does not do at all — and should

Ranked by damage caused **in this session**. Each entry: the gap, the incident, the shape of the fix, the cost.

### 13.1 There is no way to record that a board item's *claim* was verified against a commit — only that its files moved

- **Incident.** Eleven items claimed work already built and committed (`ce016621`, `58995cfb`, `d4172c4a`, `d8b26e5b`, `77d8bee8`, `e3df8e0a` gaps 2–3, `5108eab7`, `5d2750dd`, `c1729303`, `7f0e016d`, `0537d0ce` in part). The existing annotation, `⚠ N commits since measured`, was present on several and did not help: it tracks file movement, not claim truth. Item `a250fc04` was false at **zero** commits since measured — I wrote it that way.
- **The fix.** A `verified_at` field on a board item, written only by an explicit `board_verify(id, head_sha, verdict, evidence)` call, plus a `board_query` annotation reading `⚠ CLAIM NEVER VERIFIED` or `⚠ claim last verified at <sha>, N commits ago`. The distinction from the existing annotation must be visible in the listing: *files moved* and *claim rechecked* are different facts and today only one is shown.
- **Cost.** ~8 wasted Opus lanes, each a full dispatch plus my adjudication. The largest single waste in the session by a wide margin.

### 13.2 There is no mechanism that invalidates a knowledge record when a file it owns changes

- **Incident.** Article `042101ba` was authored, and within about three hours asserted *"BOTH INSTRUMENTS ARE UNEXECUTED"* and listed a deleted test arm as live coverage. Its `files[]` named the exact file whose arms were deleted. Article `7de2bc96`'s `known_gaps[3]` asserted strafe unreachable when it was reachable at `mech_controller.gd:5594`.
- **The fix.** `knowledge_verify(id)` — recompute `file_baselines` against HEAD, return which files moved and their diffs, mutate nothing. Plus a `knowledge_query` result annotation, mirroring the board's: `⚠ 2 of 4 owned files changed since baseline`. `file_baselines` is already a server-owned field; the data exists and is not surfaced where records are read.
- **Cost.** Two false articles live in the store for hours; one shipped into a commit and was corrected only because a capture lane happened to open it for an unrelated reason.
- ⚠ **Partly speculative:** I did not check whether some maintenance lane already computes this. What I can say is that it is not surfaced in `knowledge_query` output, which is where a reader would need it.

### 13.3 There is no advisory lock for a single-instance external tool

- **Incident.** Exactly one windowed Godot run may exist project-wide; two corrupt `game/.godot`'s class-name and import cache. I enforced this by hand across ~30 dispatches, writing a ⛔ paragraph into every brief. It held — but by vigilance, not by mechanism. I also **killed and restarted a suite run** because a test-writer edited two files mid-run, invalidating it; nothing warned me, I reasoned it out.
- **The fix.** `resource_claim("godot-windowed", holder, ttl)` / `resource_release`, with a PreToolUse hook denying a matching command while another holder is live and naming the holder. The mid-run-edit case is the same primitive: a claim held by the suite run, denying writes to the paths it is reading.
- **Cost.** No corruption occurred, so the cost is measured in avoided catastrophe plus ~400 words of repeated brief text and one discarded 10-minute suite run.

### 13.4 There is no channel for passing verified implementation facts to a constrained agent

- **Incident.** H4 correctly blocks `test-writer` from implementation. But the facts it needs must reach it somehow, and the only channel is my prose. That produced **four round-trips** (refuse → I dispatch an explorer → I relay → refuse again) and, worse, **I relayed a false fact**: I told it that calling `_try_cycle_lights()` directly avoids the key read, when the key read is inside that method above the increment behind a phase gate. The pin could never have worked.
- **The fix.** A `facts` handoff: an explorer writes `handoff_write(kind: "verified_facts", entries: [{claim, file, line, quoted_source}])`, and the test-writer reads it — H4-compatible, because the *explorer* did the reading and each entry carries its own quoted evidence. A conductor-typed claim with no `quoted_source` would be visibly second-hand.
- **Cost.** Four round-trips on one pin; one arm dropped that might have been writable; one false premise that survived to a suite run.
- ⚠ **Note the design tension honestly:** `handoff_write` exists but reviewers reported it as run-scoped and unavailable in conductor-direct, which is the project's primary mode. So the primitive may exist and simply not reach the mode where it is needed.

### 13.5 There is no binding between a review receipt and the diff it reviewed

- **Incident.** `commit-reviewed.mjs` stamped **6 receipts on 1 commit** and warned: *"all 6 are consumed in this single act, so any that reviewed OTHER work is permanently spent here."* It then named the true cause precisely — an earlier bare `git commit` (`58697c4`) that never consumed its own receipts. Good diagnosis; no prevention.
- **The fix.** Record the reviewed file set on each receipt at mint time and stamp only receipts intersecting the staged set, deferring the rest. The warning text mentions file-scoped stamping shipped under board `51d93c34`, so this may be partly built and not reaching this path.
- **Cost.** `58697c4` will be refused at the merge gate; a future reviewer of `5ab7fed` sees six trailers of which an unknown number reviewed different work.

### 13.6 There is no duplicate detection on record creation

- **Incident.** The create receipt for a new decision reported `check_skipped: dedup-merge (not_built)`. The authoring lane did the sweep by hand and disclosed its limits honestly: *"the dedup sweep was capped (25 of 923, then 12 of 587 records), so I cannot establish the ABSENCE of an older record ruling this."*
- **The fix.** Finish the dedup-merge check the receipt already names, or at minimum return the top-N nearest existing records by title/subject at create time so the author can decide. The `same_subject` advisory block already returned by create is the right shape and could carry it.
- **Cost.** No duplicate proven this session, but no assurance either. Across a 923-record store this compounds silently.

### 13.7 There is no way to attach a store record to an outside-family reviewer

- **Incident.** Codex returned *"Sterling knowledge records were unavailable"* and *"no Sterling connector was available"*, twice. It is the designated second reviewer on every code-touching diff and it cannot read the decisions those diffs implement. I hand-transcribed the same rulings into three Codex briefs.
- **The fix.** A `knowledge_render(ids[]) -> text` call producing a paste-ready block, so a conductor can attach rulings to any external reviewer in one call instead of retyping them.
- **Cost.** Perhaps 1,500 tokens of repeated transcription and a standing risk that a hand-copied ruling drifts from the record.
- ⚠ **Speculative generalisation flagged:** I saw this only with Codex; I assume it applies to any non-MCP reviewer, but I did not test another.

### 13.8 There is no lightweight "I checked X and it was fine" record

- **Incident.** Lanes struck roughly twenty board items as `ALREADY DONE` / `PREMISE FALSE`, each backed by a specific `file:line` someone had opened. That verification work is now gone — it survives only as prose in the item rewrites, and the *next* session will re-verify the same things.
- **The fix.** A negative-result record, or simply `board_verify` from §13.1 accepting a `verdict: "still-true" | "falsified"` with evidence, so a re-check is itself durable.
- **Cost.** Not measurable this session — it is next session's cost, and it is the same cost this session paid.

**One thing I want to say plainly rather than list:** every entry above is about *knowing whether a written thing is still true*. That is one problem wearing eight hats. The store is excellent at recording what was decided and learned; it has almost nothing for deciding whether a record still holds. **If the plugin's authors fix one thing, fix that.**

---

## 14. What would have helped — one ordered list

Cheap and mechanical (a day or less each, high value):

1. **`board_query objective:"..."`** — the missing filter on the board's own organising field. Two lanes paged 306 items to work around it. (§9)
2. **`⚠ CLAIM NEVER VERIFIED` annotation + `board_verify`** — the fix for the session's biggest waste. (§13.1)
3. **Staleness annotation on `knowledge_query` results**, mirroring the board's, computed from the existing `file_baselines`. (§13.2)
4. **Give `librarian` a create call, or add a scribe role** — the current gap routes all new-record authoring to an unconstrained agent. (§10)
5. **Suppress H20/H23 delivery on stopword-dominated matches**, or print a confidence. When the match basis is `rather, never, need, four`, the pointer is noise. (§2.2)
6. **Fix or drop H26.** Nine firings, zero true positives, and it fired on read-only lanes. (§2.1)
7. **`knowledge_render(ids[])`** so rulings can be attached to an external reviewer in one call. (§13.7)
8. **Finish the `dedup-merge` check** the create receipt already announces as `not_built`. (§13.6)

Structural — **there are three, and they are the ones that matter:**

9. **A verification layer over the whole store and board.** §13.1, §13.2 and §13.8 are one feature: a durable, cheap, machine-assisted answer to *"is this still true?"*. Everything else in this document is downstream of its absence.
10. **A resource-claim primitive.** §13.3. Single-instance tools, and the mid-run-edit case, are the same problem.
11. **A verified-facts channel into constrained agents, working in conductor-direct mode.** §13.4 — and the related finding that the roster's structured return path (`handoff_write`/`agent_exit`) does not exist in the plugin's own primary mode. Four reviewers reported this independently.

The receipt/diff binding (§13.5) sits between the two groups: probably cheap if file-scoped stamping is already partly built, structural if not.

---

## 15. Verdict

**The strongest part of Sterling is the constraint design — H4, H5, H3, H24 and the review-receipt requirement.** These are not notifications; they are things you cannot do. Every one of them caught a real error in *my own* work this session, and H4 in particular produced six correct refusals from an agent that would otherwise have written five tests that pinned nothing. That is a plugin earning its cost. The record types are well-carved, ids are durable, in-place correction preserves citations, and `known_gaps[].recorded_run` is a small piece of schema design that forces honesty better than any amount of prose could.

**The weakest part is that Sterling has no answer to "is this record still true?"** It is excellent at capture and nearly silent on decay. Eleven board items sent me at work that was already committed; an article was false within three hours of being written; a `known_gaps` entry — the field specifically for recording what is *not* covered — carried a claim falsified days earlier. The existing `⚠ N commits since measured` annotation is the right instinct pointed at the wrong quantity: it tracks whether files moved, not whether the claim survived. **If one design decision is causing most of the damage, it is that verification is a prose duty rather than a mechanism, and eight wasted Opus dispatches in a single session is what that costs.**

**Would I rather work with it than without it? Without hesitation, yes.** Four times this session an agent overruled me and was right, and the roster and receipt design are why those reviews happened at all. Two model families independently converged on one latch defect. A hollow test was caught before it could certify a bug forever. None of that happens in an unstructured session — I would have shipped a 33.7° regression and five green tests that proved nothing. The plugin's failure mode is that it lets stale truth accumulate; its success mode is that it makes lies about *current* work very hard to tell. I will take that trade, and I would take it more gladly still with a `board_verify` call.
