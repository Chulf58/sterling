# Sterling — whole-system assessment
**2026-08-28, 21:01.** Companion to `sterling-plugin-retrospective-2026-08-28-2101.md`, which carries the session evidence. This document reviews the **design**. Every claim is grounded in that session but is about the plugin.

**The one-line verdict, stated first because a hedged review is a discarded review:** Sterling's knowledge layer is genuinely good and its delivery layer is genuinely noisy, and the single most damaging design decision is that **every conflict check fires after the decision is made rather than before it**. That one property caused the two most expensive incidents of the session.

---

## 6. The record type system

**The types carve the space well.** Five were used in anger — `decision`, `anti_pattern`, `research_finding`, `feature_article`, `todo` — and every finding had an obvious home. No entry made me hesitate between two types.

Would collapsing any two lose something? **Yes, and the pair worth defending is `decision` and `anti_pattern`.** They look similar (both are "here is what we learned") and they are read at completely different moments. A `decision` is read when you are *about to choose*; an `anti_pattern` is read when you are *about to act*. The delivery hooks exploit this correctly — H19/H20 surface anti-patterns as `⚠ HAZARD` with `TRIGGER` and `RIGHT WAY` inline, and decisions as `✗ ALREADY REJECTED` lists. Those are two different reading postures and merging them would flatten both.

`research_finding`'s two clocks (`source_date` + `capture_date`) earned their place: the "alive recipe" finding I wrote is a measurement of vendor files that will not change, and `volatility_hint: stable` says so. Contrast a finding measuring our own code, which rots.

### The single best field: `known_gaps` on `feature_article`

This is the strongest piece of schema design in the plugin, and it is not close.

It let me record a probe's *limits inside the article that describes it*, rather than as a separate board item that drifts away from the thing it qualifies. Three examples from today:

- The `weapon_aim_frame_probe` article carries, as a gap: *"MEASURED DISCREPANCY OF THREE ORDERS OF MAGNITUDE. Reported ≤0.0051 deg…; the windowed probe measured 0.26 to 8.97 deg."*
- The `playthrough_probe` article records that four of its nine beats have never been run windowed and their capture code is unexercised.
- The `turn_clip_reachability_probe` article records that its `AnimationPlayer` is synthetic and cannot detect a real `.glb` missing a resolved clip name.

**Every one of those is the sentence a future reader most needs and is least likely to go looking for.** Putting it in the article means it arrives with the pointer, automatically, through H19. A separate board item would not.

`alternatives_rejected` on `decision` is second-best, for a different reason: it is what made a *reversal* legible. When the user overrode a settled ruling, the new decision could record the old option verbatim as rejected-with-reason, so the reversal reads as deliberate rather than as drift.

### Dead weight

`feature_article.live_test_refs` was pure ceremony for probe articles — probes have no tests, so I wrote five entries with empty `test_paths` arrays purely to satisfy `required`. `current_ac` on a *probe* article is similarly strained: a probe's "acceptance criteria" are just its assertions restated. Both fields are clearly designed for a **feature**, and probes/tools are being forced through a feature-shaped schema.

---

## 7. Identity, versioning, supersession

**Citation is durable and it worked.** I cited records by 8-char prefix throughout (`e3ddefe3`, `5680e824`, `13236af4`) and every resolution succeeded, including in briefs read by agents that then fetched them. Slugs resolve too, which matters because a slug survives an edit and communicates its subject in the citation itself.

**Supersession works, with one gap.** The `supersedes` link on create produced a clean record of a reversal. But — and this is the important half — **the superseded record does not visibly change in the surface a reader actually uses.** `57e37504` is still `status: active`. A reader who greps for the dash-row ruling finds the *old* one and nothing in that record says a later ruling overrode clause (1) of it. The link points forward from the new record; it does not point back.

That is a real hazard in a store this size. The 2026-08-14 failure this section asks me to re-check was, as I understand it, exactly this shape. **It is still present.** A `superseded_by` field exists in the schema (I saw it echoed as `null` on every create) but a `supersedes` link on the new record does not appear to populate it on the old one — or if it does, nothing in the read surface showed me.

**A concrete fix:** make `links: [{rel: "supersedes", target_id}]` set `superseded_by` on the target, and have `knowledge_get` and every delivery hook render a loud banner on a record that has one. Partial supersession (I overrode *clause 1* of a four-clause decision) needs a way to say which part — otherwise the choice is between falsely retiring a record that is 75% live and leaving it silently wrong.

---

## 8. The tool and API surface

**What is good:** `knowledge_get` with `field` windowing is excellent. Reading just `statement` off a decision cost a fraction of the full record and I used it four times to check a ruling before acting. That is exactly the operation a conductor needs and it is cheap.

`knowledge_schema` is the right answer to schema drift, and the project's CLAUDE.md correctly forbids hand-copying record shapes because of it.

`board_query`'s `matched_filter` / `cap` / `capped` triple is honest reporting — you cannot mistake a truncated board for a short one.

**What took more calls than it should:**

- **There is no way to ask "what governs this subject" before you write.** `same_subject` comes back **with the create result** — after the record exists. It is how I found the density conflict (`5680e824` — *"the dense grass carpet is dropped"*) against a finding I had just written recommending dense scatter. That is a good safety net firing at the wrong time. **The operation the design obviously wants and does not have is `knowledge_conflicts(subject | draft)` — a pre-write query with the same matcher `same_subject` already uses.** It exists; it is just wired to the wrong moment.
- **Closing a maintenance item was learned by rejection.** I briefed a librarian to use `maintenance_remove`; the correct path was `knowledge_update {state} resolves:[ids]`. Neither the tool description nor anything I had read distinguished the two. The lane knew; I did not.
- **`knowledge_create` cannot be delegated to the one agent designed for store work.** See §9.

**Documentation debt showing up as consumer burden.** The project's CLAUDE.md carries a long list of plugin mechanics learned the hard way: that `--ignoreHeadlessMode` is mandatory or gdUnit4 exits 103 "which reads like a crash"; that `gdformat --check` is allowlisted but bare `gdformat` is denied; that an explicit `allow_scripts` array *replaces* rather than extends the shipped default so newly-sanctioned scripts stay unreachable until `/sterling:update` runs a specific step; that a user-scope MCP entry is silently ignored under `--strict-mcp-config`. **Every one of those is a plugin behaviour a consuming project had to discover and write down.** That list is the most direct measure of the API surface's documentation gap.

---

## 9. The agent roster

**The constraints produced better work than freedom would have, twice, and this is the roster's strongest evidence.**

- `test-writer` has no read access to implementation (H4). Every constant had to be stated in the work order. The resulting pins are written against a **stated contract** rather than against the code, which is the entire point of a pin — and one of them caught a real arithmetic error *in my own brief* (a tolerance constant used as both a closeness bound and a non-zero floor, where the true value `atan(0.68/200) = 0.0034` could never clear a `0.01` floor).
- `reviewer-correctness` and `explorer` are read-only, and both produced findings they could not have been tempted to "just fix" — the reviewer's turn/idle thrash finding and the explorer's honest *"I did not find a mechanism that can produce a non-zero gap"* negative result.

**Where the roster is wrong:**

1. **`librarian` has no `knowledge_create`.** It holds update/append/edit/schema. The project's convention — conductor drafts, librarian applies — therefore cannot cover *new* records at all. At 51% context pressure with five articles owed and H10 explicitly telling me to delegate mechanical work, the agent type built for store maintenance was structurally unable to help. I used `general-purpose`, which has full tool access: strictly more privilege than the task needs.

2. **`test-writer` has no Bash, by design, and is asked to satisfy gates it cannot run.** This is defensible — it is what keeps it blind — but the cost is real and measurable: three round-trips on one file (typing, then line length, then formatter style), each a full dispatch plus a conductor relay. The `anti_pattern` I wrote about it says so explicitly: *"a test-writer holds no Bash by role, so it cannot run the gate it is being asked to satisfy — every guess costs a full dispatch."* **The fix is not to give it Bash; it is to give it a read-only formatter check.**

3. **Subagents cannot run `git`, and one needed to.** Restoring `build_mech.py` required `git show bd0c18a^:path`. The lane correctly identified the exact command and could not run it — a strictly read-only git operation. It reported: *"restoring a deleted file is git, which you own."* Right answer, unnecessary round-trip.

---

## 10. The board and the maintenance queue

**Queue signal-to-noise: 47 of 48 `reconcile_needed` items were already paid.** That is a ~98% false-positive rate on that lane, and the plugin *knows* this — the session-start message says so in terms: *"expect much of it to be ALREADY DONE: the queue records debt the mechanism detected, not debt that is necessarily still owed."*

Being honest about a 98% noise rate is better than hiding it, but it is still a 98% noise rate, and it has a second-order cost the design does not seem to account for: **because almost everything is already paid, the verification step gets skipped.** My librarian closed all 47 without opening individual diffs, and disclosed it. I boarded that as debt. A queue that is nearly always wrong trains its reader not to check — and that is exactly when the one real item slips through.

**The queue misled in the more dangerous direction, too.** The session-start banner reported *"9 items in lane article_missing"*, and one of them named `game/spike/barrel_vs_crosshair_probe.gd`. That file **already had an owning article** (`d06cb80b`, which lists it in `files`). The demand was a stale baseline after an edit, not a missing record. I checked rather than creating a duplicate — but a tired session creates the duplicate, and now the store has two articles for one file.

**The board is the better half of this pair.** `board_query`'s honest capping, the `objective` grouping, and `measured_at_head` stamping all work. The single most valuable board convention in this project is not Sterling's at all — it is the local rule that *an item states its evidence, not its conclusion*. Sterling could enforce a weak version of that: `board_add` could warn when item text contains no `file:line`, no number and no quoted string.

---

## 11. The conductor contract — enforced vs prose

| Rule | Enforced by | Reality |
|---|---|---|
| Frozen tests not edited by agents | **H5** | Held. Refused twice. |
| Test-writer blind to implementation | **H4** | Held. |
| Subagent command allowlist | **H14** | Held. Caught three reaches. |
| Gate exit codes not masked | **H24** | Held. Caught two of mine. |
| Review before commit | **`commit-reviewed.mjs` + merge gate** | Held — the receipt ledger is real enforcement, and it refuses when empty. |
| Read before edit | H3/H13 | Not observed firing; assumed live. |
| **Conductor opens every plate with its own eyes** | **Nothing** | **Prose only.** |
| **Verify by mutation when changing a ruling** | **Nothing** | Prose only. I did it four times voluntarily. |
| **Re-verify a board item against HEAD before dispatching at it** | **Nothing** | Prose only. |
| **A design question is always an ask** | **Nothing** | Prose only — and I violated its spirit twice by asking questions already settled. |

**The highest-value unenforced rule is the visual-inspection one**, and it is not close. This project's entire quality model for 3D work rests on the conductor personally opening a rendered image before repeating any claim about it. Nothing checks it. A session under pressure that reports "the plates look correct" without opening them is indistinguishable, in the transcript and in the store, from one that did.

**And the session proved why it matters:** four green suites and a purpose-built probe reporting `≤0.0051°` all vouched for an aiming fix that plates showed missing by `414×484 px`. The *only* thing that caught it was a human opening a picture.

A cheap mechanism exists: `attestation` is already a record type, with `artifact_key`, `verdict`, `inspector`, `inspected_at`, `instrument`. Nothing requires one. **A hook that refuses a commit touching an asset or render path without a fresh `attestation` would convert the project's most important rule from honour to mechanism.**

---

## 12. What is structurally missing (the design reaches for it and stops short)

1. **`knowledge_conflicts(subject)` — a pre-write / pre-ask conflict query.** `same_subject` already implements the matcher; it is only wired to fire *after* create. §8.
2. **Back-populated `superseded_by`, and partial supersession.** §7.
3. **A read-only formatter/lint check for agents that hold no Bash.** §9.
4. **Read-only `git show` / `git log` for subagents.** §9.
5. **A "this file is owned by a live dispatch" suppression inside H10's own article demand** — the hook already computes the deferral and then ignores it. §2.2 of the companion.
6. **A `test_append` mode for `test-repair.mjs`**, distinct from `test_repair`. The current script models only "the test was buggy"; appending a new case to a frozen file is a different, legitimate act with no honest record. §2.3 of the companion.

---

## 13. What Sterling does not do at all — and should

Ranked by damage caused **in this session**. Each entry: the gap, the incident, the shape of the fix, the cost.

### 13.1 There is no conflict check that fires BEFORE a question reaches the user

**The gap.** Sterling can tell you that a subject is already governed, but only after you have written the record or after the user has answered. There is no pre-flight check on a question.

**The incident — twice, both expensive.**
- I asked the user how dash rows should sit. They answered "top-aligned". H20 returned *with the answer*: `✗ ALREADY REJECTED: Fill the glass but keep rows axis-aligned` — decision `57e37504` had ruled rows **fill the glass**, explicitly replacing a top-anchored layout. I had to stop an in-flight coder mid-edit, quote the clause, and re-ask.
- I wrote a `research_finding` recommending dense ground scatter (one clump per 1.8 m). The `same_subject` echo on the create returned `5680e824` — *"the dense grass carpet is dropped — ground cover is a sparse feature-hugging garnish"*. I had just written a recommendation against a settled ruling.

H20's own text is candid about this: *"THIS IS A POST-ANSWER AUDIT, NOT A GATE — it reaches you with the answer, never before the ask (probed 2026-08-11)."* Someone measured this and accepted it. **It is the wrong trade.** A user's answer becomes authoritative the moment it is given; discovering the conflict afterwards means either silently manufacturing a contradiction or spending a second question to undo the first.

**The shape of the fix.** `knowledge_conflicts(subject_text, types?) -> [{id, title, clause?, matched_on}]`, callable before `AskUserQuestion` and before `knowledge_create`. Or, cheaper: run H20's existing matcher in `AskUserQuestion`'s **PreToolUse** and inject the hits into the question's own context. The matcher exists and demonstrably works — it caught both of these. It is aimed at the wrong instant.

**The cost here.** One lane stopped mid-edit, one question re-asked, one decision that had to be written as a supersession rather than a plain ruling, and one recommendation to the user that I had to retract in the same message. Approximately 25 minutes and three extra tool calls, on a mechanism that already had the answer.

### 13.2 There is no gate over anything outside the language the project declares

**The gap.** Sterling's toolchain model gates `game/**/*.gd`. Nothing executes, imports, or even syntax-checks `tools/**`. A whole directory can rot with every declared gate green.

**The incident.** `tools/blender/build_mech.py` was deleted at commit `bd0c18a` (*"The Synty mech leaves the building, and takes its tooling with it"*). **21 files import it.** The entire Blender asset pipeline — every building cutter, the crop-tile builder, the tree builder, the worker exporter — died at import time and stayed dead for weeks. It surfaced only when a user asked for an asset swap and a lane hit `ModuleNotFoundError: No module named 'build_mech'` before touching a single vertex. A second lane was independently blocked by the same thing in the same session.

**The shape of the fix.** A declared toolchain entry with an `import_smoke` command, run at the same gate points as the test suite — for Python, literally `import every module under tools/, assert no ModuleNotFoundError`. Or, narrower and nearly free: a hook on `git rm` / large deletions that greps the repo for importers of the deleted module's basename and refuses if the count is non-zero. The project's own anti-pattern for this (`ac29f0cd`, written today) names the one-line grep that would have caught it.

**The cost here.** Two lanes blocked, one asset campaign stopped dead at the first command, and an unknown number of weeks in which the pipeline was believed available. The *repair* was a single `git show`. The invisibility was the whole cost.

### 13.3 There is no way to record that a claim has been falsified

**The gap.** Records can be superseded, retired, or updated. There is no way to say *"this record's central claim was tested and is false"* while keeping it readable as history.

**The incident.** `decision e006c505` recorded convergent weapon aim as delivered. It was not — the running game measured up to `8.97°` of error and a plate showed the cannon missing by `414×484 px`. The decision was written in good faith from four green suites and a probe reporting `≤0.0051°`. Separately, `decision e3ddefe3` records a barn's topology as `450 parts / 58 closed`; re-measurement today gave `390 / 27`. Nothing anywhere flags either.

**The shape of the fix.** A `falsified_by` link rel, plus a `contradicts` warning in delivery: when a hook surfaces a record that something links to with `falsified_by`, render it as `⚠ CLAIM FALSIFIED — see <id>` rather than as a plain pointer. Cheaper still: allow `evidence_basis: "falsified"` and have every delivery hook refuse to present such a record as governing.

**The cost here.** A wrong decision shipped and was cited as settled for a full day, and the follow-on work (`cc27f19b`, the disclosed-gaps board item) had to carry the correction instead of the record itself. **Anyone reading `e006c505` today still reads a false claim with no marker.**

⚠ *Speculation flag: I saw this twice, both today. I am inferring it is a recurring class rather than two coincidences, but I have not measured its frequency.*

### 13.4 There is no attestation requirement on visual work

**The gap.** `attestation` exists as a record type with exactly the right fields (`artifact_key`, `verdict`, `inspector`, `inspected_at`, `instrument`). **Nothing ever requires one.**

**The incident.** The project's strongest rule — the conductor personally opens every render before repeating a claim about it — is enforced only by my own honesty. I opened seven plates today and ruled from them; a session that skipped that step and wrote the same summary would leave an identical transcript and an identical store.

**The shape of the fix.** A hook on commits touching declared asset/render paths that refuses without an `attestation` whose `inspected_at` postdates the change and whose `inspector` is the conductor. The record type is already built; only the requirement is missing.

**The cost here.** None *this* session — I did open them. The cost is the risk, and the session showed exactly how large it is: every automated instrument agreed the aim was correct and only a human opening a picture disagreed.

### 13.5 There is no record of what a probe or instrument CANNOT see, at the moment it is trusted

**The gap.** `known_gaps` on `feature_article` is excellent (§6) but it is *pull*, not *push*. Nothing surfaces an instrument's limits at the moment its output is being used as evidence.

**The incident.** A lane built `weapon_aim_frame_probe.gd`, ran it, and reported `≤0.0051°` residual across 14 weapons. I nearly accepted it. Codex — an outside model, consulted because the project mandates it — predicted the probe was untrustworthy *before* the windowed run that proved it, on the grounds that it injects its own aim point and never enters the production path. The windowed run then measured `0.26–8.97°`.

**The shape of the fix.** When a delivery hook surfaces a number, or when a brief cites a probe by path, push that probe's article's `known_gaps` alongside it. Concretely: extend H19 so that a path resolving to a `feature_article` with non-empty `known_gaps` renders them inline rather than only as a pointer.

**The cost here.** Nearly zero, because the mandated outside reviewer caught it. **That is luck dressed as process** — the same defect a day earlier reached a commit and a decision record. Absent Codex, I would have trusted a self-authored green signal for the second time in two days.

### 13.6 There is no "this brief's line numbers have drifted" check

**The gap.** Briefs cite `file:line`. Nothing validates them at dispatch time, and lines drift while lanes edit.

**The incident.** Every one of five line numbers in a brief I wrote had drifted by the time the receiving agent read it (`:3727`→`:3767`, `:3007`→`:3033`, `:5197`→`:5319`, `:846`→`:854`, `:93-149`→`:120`/`:135`). The agent recorded HEAD values and told me. The project already mandates *"every file path in a brief must be grepped that turn"* — but paths, not lines.

**The shape of the fix.** A PreToolUse on `Agent` that extracts `path:line` pairs from the prompt and warns when the cited line's content does not contain a plausible anchor — or simply when the file's mtime is newer than the conductor's last read of it. Cheap, advisory, and it would have caught all five.

**The cost here.** Low — one agent's careful correction. But the failure mode when an agent *does not* check is that it edits the wrong line in a 7,400-line file.

---

## 14. What would have helped, one ordered list

**Structural — there are genuinely only three.**

1. **Move conflict detection before the decision point** (§13.1). The matcher exists and works; it fires at the wrong instant. This caused the two most expensive incidents of the session.
2. **Gate the directories the project does not declare a language for** (§13.2). A whole pipeline was dead for weeks behind green gates.
3. **Make falsification expressible** (§13.3). A store whose records cannot be marked wrong will keep asserting them.

**Cheap and mechanical — most of the remaining value is here.**

4. Back-populate `superseded_by` and render a banner on superseded records (§7).
5. Suppress H10's article demand for files its own deferral already flags as owned by a live dispatch (§2.2 of the companion).
6. Give `librarian` `knowledge_create` (§9).
7. Give agents that hold no Bash a read-only formatter/lint check (§9).
8. Give subagents read-only `git show` / `git log` (§9).
9. Fix H26's territory extraction to exclude tool binaries and gate-runner paths — it is currently 100% false-positive and buried one real overlap (§2.1 of the companion).
10. Push `known_gaps` inline when a probe's output is cited (§13.5).
11. Add a `test_append` mode to `test-repair.mjs` (§12.6).
12. Warn on drifted `file:line` citations at dispatch (§13.6).
13. Require an `attestation` on commits touching render paths (§13.4).

**The one thing I would drop rather than fix:** H23 output-axis delivery at its current matching threshold. ~25 firings, ~6% follow rate, matching on tokens like *"pieces, user, subject, eight"*. Its four genuine saves were all things H19 or H20 would plausibly have surfaced from the path or the dispatch subject instead. Either raise its threshold sharply or fold it into the other two axes.

---

## 15. Verdict

**The strongest part of Sterling is the knowledge layer, and specifically the discipline it imposes on *how* a record is written.** `known_gaps`, `alternatives_rejected`, two clocks on findings, and `anti_pattern`'s trigger/wrong-way/right-way shape are all doing something more valuable than storage: they force the author to write down the thing they would otherwise leave implicit. Three times today a record I or someone else wrote *hours* earlier saved real work, and in each case the value was in a field the schema insisted on. That is design working.

**The weakest part is that its intelligence arrives late.** Sterling knows the store contains a contradiction — it demonstrated that twice today — and both times it told me after the user had answered. The same pattern shows in H10 demanding an article for a file it has just told me is being written, and in a maintenance queue that is 98% already-paid and trains its reader to stop checking. The information is right; the timing is wrong. Almost every recommendation above is really the same recommendation: *move the check earlier*.

**Would I rather work with it than without it?** Yes, clearly and not marginally. Today it caught a wrong-pack premise before it cost a Blender session, stopped me twice from reading a red gate as green, and handed me a rotation note whose top warning — *"the suites are green and vouch for none of it"* — turned out to be the single most important sentence in the session. Against that, the friction is noise I can skim and a queue I have to distrust.

But I would put the emphasis somewhere specific. **This session's central lesson was that every automated instrument in the project agreed on something false, and the only thing that disagreed was a human opening a picture and playing the game for ten minutes.** Sterling is very good at recording what we concluded and why. It has almost nothing to say about whether the conclusion was ever checked against reality. The `attestation` record type is sitting there, fully specified and never required — and that gap is, on today's evidence, the most consequential one in the whole design.
