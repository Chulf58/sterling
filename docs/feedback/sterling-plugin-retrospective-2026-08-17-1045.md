# Sterling plugin retrospective — 2026-08-17, 10:45

**Second retrospective of this date.** An earlier one (`sterling-plugin-retrospective-2026-08-17.md`, 17 KB,
plus `sterling-plugin-assessment-whole-system-2026-08-17.md`, 18 KB) covers the first stretch of the same
day. This file is a fresh account of the stretch that followed and does not revise it.

**Why this one was requested.** The user asked, unprompted, mid-session:

> *"are we starting to stumble over the amount of articles we have and how long they have become?"*

and then: *"make a sterling retro file with the issue, so it will be fixed at some point."*

So the headline of this document is a single structural defect, stated first because it is causing most of
the damage.

---

# ⚠⚠ THE HEADLINE: `feature_article` HAS NO COMPACTION PATH, SO ARTICLES ONLY EVER GROW

**This is the one design decision causing most of the friction in this project, and it is fixable.**

## The measurement

**A dedicated measurement pass was run for this document.** `knowledge_query types:["feature_article"]
cap:500` returned `matched_filter: 77, returned: 77, capped: false` — so **77 articles is a real total**,
not a window. Three are explicit `DUPLICATE`/deprecated stubs.

### ⚠⚠ THE STRONGEST SINGLE FINDING: THREE ARTICLES CANNOT BE READ IN ONE CALL

The measuring agent attempted to fetch its eight largest candidates. **Four overflowed the tool channel and
could not be retrieved at all:**

| Article slug | Version | Size |
|---|---|---|
| `economy` | 55 | **70,425 chars — FETCH FAILED, too large** |
| `dev-toolchain-setup` | 73 | **64,194 chars — FETCH FAILED** |
| `mech-part-export` | 76 | **59,969 chars — FETCH FAILED** |
| `gathering-loop` | 40 | **58,600 chars — FETCH FAILED** |
| `cockpit-view` | 56 | ~30,000 chars (read OK) |
| `blender-tools` | 53 | ~19,000 chars (read OK) |
| `spike-probes` | **102** | ~14,000 chars (read OK; mostly `history`) |
| `mech-part-library` | 70 | ~9,500 chars (read OK) |

**This is independent, harder evidence than anything quotable from inside them.** A `feature_article` is
the plugin's mechanism for telling a reader what an area does. **Four of them can no longer be read by the
mechanism designed to read them.** That is not "articles are getting long" — that is a record type that
has outgrown its own API.

`spike-probes` stands at **version 102**. The **median version across all 77 articles is ≈ 20**.

### Version numbers observed directly in write receipts this session

`mech-part-library` **70** · `mech-part-export` **76** · `farm-layer` 59 · `cockpit-view` 56 · `economy` 55
· `weapons` **40** · `garage` **39** · `mech-part-inspection-tools` 22

### Two growth modes, and only one is the defect

The measurement separated them, which I had not:

- **PROSE-CORRECTION GROWTH — the real defect.** `mech-part-library` and `cockpit-view` carry an estimated
  **30–45% of their `state_reason` / `intended_behavior` prose as correction-of-self** (eyeball estimate
  from a full read, not a character count — stated as such).
- **APPEND-ONLY REGISTRY GROWTH — largely benign.** `spike-probes` (v102) is mostly `history`, and many of
  its 27 entries are *"checked, found accurate, re-baselined"* — a hash refresh, not a content correction.
  **A compaction feature must not treat these the same way.**

## The mechanism, precisely

The plugin's contract says **fix a wrong record forward** — `knowledge_update` it, which supersedes the
error. That is exactly right for a `decision`, where the superseded reasoning is the record's value: you
want to know what was rejected and why.

**It is wrong for a `feature_article`, and the plugin does not distinguish the two cases.** An article is
supposed to describe *what the code is now*. Fixing forward makes every correction an inline annotation
that is never removed, so the article becomes a changelog wearing a description's name.

Real examples, quoted from live records this session:

- `weapons` (v40) — its `what_it_does` **opens** with:
  > *"⚠⚠ SUPERSEDED IN THREE PLACES ON 2026-08-17. READ THIS BEFORE ANYTHING BELOW."*

  A reader must consume three correction notices before reaching any description.

- `mech-part-library` (v70) — its `intended_behavior` carries **three generations of one number**:
  > *"**351** as of 2026-08-14, measured … ⚠ CORRECTED: this article previously said 339 and described it
  > as a coincidence equal to 346 − 7. **Both numbers are dead.**"*

  and its AC1 carries a fourth:
  > *"⚠ CORRECTED 2026-08-14: this AC previously stated 346 exported / 45 held back / 323 static / 23
  > skinned…"*

- The same article's AC2 ends:
  > *"An earlier version of this AC asserted the plain equality, and a later version pinned the arithmetic
  > at 346 - 7 = 339, which is also now stale."*

- **`cockpit-view` (v56) quotes its own dead paragraph in full before retracting it.** Its `state_reason`
  contains, verbatim:
  > *"THIS PARAGRAPH USED TO SAY, VERBATIM: 'THE HUD IS TWO LABELS, BOTH DEBUG… EVERY SENTENCE OF THAT IS
  > NOW FALSE.'"*

  The article is carrying a full copy of a statement whose only property is being wrong.

- **`blender-tools` (v53) retains complete `files[]` role text for files that no longer exist.** Two
  entries read:
  > *"⚠ DELETED 2026-08-15 at `bd0c18a`… This file no longer exists."*

  — followed by the **entire original multi-hundred-word role description, unremoved.** An article
  describing a deleted file at full length is the purest form of this defect: no reader will ever need
  that text, and no mechanism will ever remove it.

**Every one of those passages is honest and well-written. That is the problem.** The authors are following
the contract correctly. The contract produces monotonic growth.

## The cost, measured rather than asserted

1. **A boarded, unfixed blocker already exists for this.** Board item `499f2ef7`:
   > *"THE MAINTENANCE QUEUE NEEDS A DRAIN THAT A LIBRARIAN STRUCTURALLY CANNOT DO — **18 ITEMS SIT BEHIND
   > ARTICLES TOO LARGE TO READ**."*

   That is 18 queue items the plugin's own designated agent cannot clear, because of the plugin's own
   record growth. The session-start H1 injection independently reported an **`article_oversize`** lane in
   the maintenance queue, so the plugin has a name for this condition and no remedy for it.

2. **H19 delivery is now file-sized.** A single `Read` of `game/test/weapon/cannon_test.gd` delivered the
   `weapons` article and its ten one-hop pointers. A single `Read` of `CLAUDE.md` produced a delivery
   large enough that the harness **spilled it to a file**: *"Output too large (16.8 KB)"*. The delivery
   mechanism is sound; what it is delivering has outgrown it.

3. **Retrieval is permanently windowed.** Every `knowledge_query` in this session came back capped or
   rank-truncated. `types:["decision"]` with `cap: 30` returned `matched_filter: 462`. The store's own
   note said it plainly:
   > *"rank_terms ORDERED those 462 and did not narrow them, so this count is NOT a measure of how many
   > are relevant — and a capped window can never establish absence."*

   That warning is excellent design. It is also an admission that the corpus has outgrown the query
   surface.

## What is structurally missing — name the call

**There is no compaction operation.** `knowledge_update`, `knowledge_append` and `knowledge_edit` all
grow or replace; `knowledge_retire` is explicitly narrow (duplicates only, and it needs an `in_favor_of`
survivor); `/sterling:cleanup` never hard-deletes knowledge. There is no supported way to say *"this
article's body is now correct; drop the twelve correction notices that got it here, and keep them in the
version chain where they belong."*

**The version chain already stores them.** `mech-part-library` has 70 retained prior versions. The
correction history is preserved by the versioning system whether or not it is also duplicated inline.
**So the inline annotations are a second copy of something the store already holds** — and this project's
own CLAUDE.md carries a rule about exactly that shape, learned the hard way on a different surface:

> *"a summary of the store IS a second copy of the store and it rotted exactly as you would expect"*

### Concrete proposals, cheapest first

1. **`knowledge_compact(id)`** — rewrite an article's body to current truth, with the pre-compaction body
   retained as a version. One call. This is the whole fix for the common case.
2. **Emit article body size in `knowledge_query` digests** — a `chars` or `size` field per record, so
   oversize articles are visible without opening them. Currently the only way to discover that an article
   is too big to read is to try to read it, which is what breaks the librarian.
3. **A `corrections` or `errata` field**, separate from `what_it_does` / `intended_behavior`. Corrections
   would still be captured, still be readable, and stop displacing the description. Delivery could then
   ship the description by default and the errata on request.
4. **Make the fix-forward guidance TYPE-AWARE in the contract.** For `decision`, annotate — the superseded
   reasoning is the value. For `feature_article`, **rewrite** — the current state is the value. Today one
   rule covers both, and it is the right rule for only one of them.
5. **An `article_oversize` remedy, not just a lane.** The queue can already detect the condition; it has
   nowhere to send it.

## Honest counterweight: I made this worse today, twice

- I created a new `feature_article` (`weapon-fire-groups`) whose `state_reason` alone runs to a full
  paragraph, and whose `files[].role` entries each carry several sentences including known defects. It
  was v2 within thirty minutes.
- I appended a **~1,100-character role string** to `mech-part-inspection-tools` for a single probe file,
  because the probe had four confirmed defects and I judged the reader needed them at hand. That is the
  same reasoning every author of those v70 articles used.

**That is the strongest evidence the defect is structural rather than a discipline problem.** A conductor
who had just diagnosed the growth problem, in the same hour, then grew two articles — because the contract
gave no other place to put the information.

### ⚠⚠ AND THEN IT HAPPENED A THIRD TIME, WHILE THIS DOCUMENT WAS OPEN

Roughly twenty minutes after writing the section above, I appended one `files[]` role entry to
`probes-mech-assembly-seating` — describing a probe that had just found a real defect. The write succeeded
and returned this:

> *"feature_article 'probes-mech-assembly-seating' non-history body is now **64013 chars** — over the
> **60000-char `article_oversize` threshold**. split it … A deduped `article_oversize` maintenance item
> has been queued."*

**So a fifth article crossed the unreadable threshold, and the author who pushed it over was the one who
had just written the diagnosis.** I do not think I should have written less: the entry records that the
probe's own first run produced seven upside-down plates that passed every structural check, which is
exactly the kind of thing the next reader must know.

**Three observations that make this the most useful paragraph in the document:**

1. **The plugin HAS the detector.** It knows the threshold, it warned at the right moment, and it queued a
   maintenance item. **What it does not have is anywhere for that item to go** — `article_oversize` is a
   lane with no remedy, which is why board `499f2ef7` records 18 items stuck behind it.
2. **The warning's own advice was already being followed.** It suggests using `knowledge_append` instead of
   a full `knowledge_update` retransmit — and I *was* using `knowledge_append`. That advice prevents
   *accidental truncation*, not growth. **There is no advice available for the actual problem**, because
   the operation that would fix it does not exist.
3. **The suggestion it does offer — "split it" — is the expensive structural answer**, and it is offered at
   the moment of a one-line append, when nobody has the context to do a split well. **A `knowledge_compact`
   call would have been the right thing to offer here**, and it is the reason this document exists.

---

# PART A — OTHER SESSION EVIDENCE

## 1. Where it genuinely helped — receipts, prioritising catches on MY OWN work

### 1.1 ⭐ H20 inverted a brief's premise one second after I dispatched it
I dispatched a `debugger` to fix an `is_fittable()` / `fittable_keys()` divergence, briefing it that the
predicate *"silently refuses ~215 shipped parts"*. H20 fired on the dispatch and surfaced two records:
anti-pattern `6e608eee` (*"`is_fittable` sounds like 'can be used' but means 'is a bipedal chassis'"* —
written about that exact function) and decision `66cc7002`, a deliberate adjudication that chose the gate.

**There was no defect.** I sent a correction via `SendMessage` before the agent could act. It came back:
*"Outcome 1 AND Outcome 3 are both true"* — no behavioural change, docstrings fixed, and it independently
found the function has **zero production callers** (11 call sites, all test/spike).

**Nothing else in the stack would have caught this.** The brief was internally coherent and cited a real
measurement from a real agent report. Path-scoped delivery could not have found it — the record lived on a
different file.

### 1.2 H20 also caught a stale premise I had already propagated into two briefs
I quoted decision `a52fbf9d` verbatim into two agent briefs: *"ALL 124 WEAPON ROWS CARRY
`mounts_on_basis: AMBIGUOUS` AND DECLARE NO SOCKET."* A garage lane re-measured at HEAD and returned:
**only 3 of 124** have `mounts_on: null`. The ruling was fine; a measurement inside it had rotted.

**This is the article-growth defect wearing a decision's clothes** — and it is why proposal 4 above splits
the two types. I corrected it with `knowledge_edit`, which grew the record by 1,609 characters.

### 1.3 An agent's constraints produced a better answer than an unconstrained one
`test-writer`'s H4 wall and H5's frozen-test refusal forced the rename agent to STOP and report rather than
edit four test files. Its report named the exact blocker. Conductor-only repair took six edits. **The
refusal was correct** — but see 2.1.

### 1.4 The two-clock discipline on `research_finding` did real work
Writing the weapon-family census as a `research_finding` with `source_date` and `capture_date` forced me to
separate *what I measured this turn* (124 rows, conductor-verified by `grep -c`) from *what an agent
reported* (the shield sub-count, which I flagged as unverified in the same record). That distinction later
proved load-bearing: the shield count turned out to be wrong, and the record had already said so.

## 2. Friction

### 2.1 H5 blocks the fix but not the breakage — and the result is a project-wide parse failure
The rename agent renamed `class_name Gatling` → `Minigun` and correctly could not update four test files
that call `Gatling.new()`. **Those classes then did not exist**, so the next `--import` would fail to parse
and **gdUnit4's scanner blocks every suite in the project**, not just the four files.

H5's refusal is right in isolation and produces a strictly worse intermediate state than either allowing
the edit or blocking the rename. **The gap: H5 knows a test file is frozen; nothing knows the rename made
it uncompilable.** A pre-rename check — *"this `class_name` is referenced from N frozen test files"* —
would close it.

### 2.2 Every id in prose is stale by construction, and this cost a round trip
`board_update` failed with `no record '63ebfb7f-8c59-4f4f-8c40-0178b473c506'` because I reconstructed a
uuid from a prefix. My error. But the design amplifies it: **every update mints a new id**, so ids in prose
are unusable handles by design, and the project's CLAUDE.md carries a standing rule to resolve records *by
title or slug* instead. **A rule that exists to work around the identity model is a finding about the
identity model.**

It bit an agent too: a librarian's second write was refused *"already superseded"* — because its own first
write, one call earlier, had minted a new id. It retried correctly. **Multi-step work against one record
requires re-resolving the handle between every step.**

### 2.3 H21's nudge is right in aggregate and wrong per instance
H21 fired 4 times: *"this is hand-run article write #N this session… bulkier article reconciles should
batch through the librarian."* Each individual write it flagged was one of the three named exceptions — a
small authored create, or a single small-record touch. **The trend advice was correct and I acted on it**
(I dispatched two librarians afterwards). The per-firing accuracy was 0/4. Same finding as the previous
retrospective; it has not changed.

### 2.4 The background-task exit code is not the command's exit code
I ran the suite via `... > file 2>&1; echo "SUITE_EXIT=$?"`. The harness reported **"completed (exit code
0)"** — the `echo`'s exit, not the suite's. The real value was `SUITE_EXIT=100`. **Not a Sterling defect**,
but worth recording next to the project's existing anti-pattern about Blender exiting 0 on failure: this
project now has two independent cases where an exit code lied, and the local convention (grep for an
explicit OK token) is the only thing that catches either.

## 3. Wrong information — including mine

| Record | What was wrong | Caught by |
|---|---|---|
| `a52fbf9d` (decision) | "all 124 weapon rows AMBIGUOUS" — actually 3 | agent re-measuring against the brief |
| `5f8a2e8b` (decision) | **7 of 15** family part-counts wrong | census agent |
| My board item on shields | Accused our exporter; the **vendor** names shields `Weapon_*` | recon agent I dispatched to check |
| My brief to the debugger | "215 parts silently refused" — no defect at all | H20 |
| `mech-part-library` AC5 | Required `is_skinned` to agree with animation presence — falsified by a shipped feature | the suite going red |
| Board `63ebfb7f` | "nothing re-exported after `b653279`" — two exports since | conductor `git log` |

**Four of six are mine.** The store's error rate and my error rate are comparable, which is the honest
frame: the store is not an unreliable narrator relative to its authors.

## 4. Hook-by-hook

| Hook | Fired | Verdict |
|---|---|---|
| H1 | 1 (session start) | Rotation note consumed correctly; queue depth (31) accurate and actionable |
| H3 | 0 observed | — |
| H4/H5 | ≥6 refusals to one agent | Correct in isolation; see 2.1 for the composite failure |
| H10 | 4 | **Excellent.** Demanded owners for 6 new files across 3 firings; every demand was legitimate and I had not noticed any of them |
| H19 | many | Right content, increasingly outsized payload (see headline) |
| H20 | 8+ | **The most valuable hook in the system.** Two catches that nothing else could make |
| H21 | 4 | Right trend, 0/4 per instance |
| **Nothing** | — | **No mechanism noticed that a `class_name` rename orphaned four frozen test files** |
| **Nothing** | — | **No mechanism noticed that four weapon behaviours (`minigun`, `Sniper`, `cannon`, `laser`) have zero production callers.** A roadmap agent found it as a side effect. This is the same defect a board item was raised for on a *different* seven weapons — so the store knew the *shape* and could not detect a new *instance* |
| **Nothing** | — | **No mechanism relates an article's acceptance criteria to the tests that would falsify them.** AC5 asserted a contract the suite had stopped having; only running the suite found it |

---

# PART B — SYSTEM ASSESSMENT

## 5. The record types

The carve is mostly right. `decision` / `anti_pattern` / `research_finding` are genuinely distinct and I
used all three for their real purpose today. **The best field in the system is `alternatives_rejected`** —
writing it forces you to state why the cheap option lost, and on two occasions today writing it changed
what I recommended before I asked the user.

**The one bad seam is `feature_article` doing two jobs**: describing current state AND accumulating the
history of its own corrections. Splitting those (proposal 3) is the single highest-value change.

`anti_pattern`'s `trigger` field is the sleeper. It is written as *"you are about to…"*, which makes
delivery actionable rather than informational. That is why H20 works.

## 6. Identity and versioning

**Still the weakest area, and unchanged since the earlier retrospective.** A record cannot be cited
durably. The workarounds are all in place and all cost something:
- Cite by slug or title, not id (CLAUDE.md rule).
- Re-resolve between every write (librarian, this session).
- 8-character prefixes in prose are unusable with `knowledge_get` (existing anti-pattern `decae4de`).

`knowledge_get` on a superseded id does resolve and reports `status: "superseded"` with `superseded_by` —
that part is good. The gap is that **query and board surfaces show current ids, while prose holds
historical ones**, so the two never match.

## 7. Tool surface

What worked: `projection: "digest"`, `knowledge_append`, `knowledge_edit` with the `arr[key=value].sub`
selector (the librarian used it successfully on a `files[]` role). `knowledge_edit`'s exactly-once
matching rule is correct and refused nothing today.

What is missing: `knowledge_compact` (headline), a size field in digests, and a way to ask *"which
articles' ACs mention this test?"*

## 8. Agents

Roster is right. `librarian`'s lack of `board_*` tools was a real constraint I had to design around today
— I nearly briefed it to close board items and checked its tool list first. **That check is only in
prose**, and the plugin's own guidance says a mis-briefed agent wastes a whole round.

`reviewer-correctness` on Opus earned its cost outright: it found a clip-baking defect that would have
shipped visibly wrong recoil, and independently confirmed a root cause the authoring agent found from the
opposite symptom.

## 9. The conductor contract — the highest-value unenforced rule

**"Run the full suite yourself before committing."** Nothing enforces it. Everything else in the
pre-commit contract has a mechanism or a gate; this one is prose, and it is the rule most likely to be
skipped by a tired session under playtest pressure — exactly the session that most needs it. A
pre-commit hook that refuses a commit without a green suite artifact from the current HEAD would close it.

Runner-up: **"a design question is always an ask."** Also prose-only. H20's post-answer audit is the
closest thing to enforcement, and it fires *after* the user has already answered.

## 10. What I did not exercise

Pipelines and runs (conductor-direct all session), `/sterling:cleanup`, `/sterling:init`,
`/sterling:merge`, `/sterling:council`, the TUI dashboard, `knowledge_promote`, `knowledge_link`,
`run_escalate`, `handoff_*`. **No opinion offered on any of them.**

---

# PART C — VERDICT

**Strongest part: H20's subject-axis delivery combined with `anti_pattern`'s trigger-shaped writing.**
Twice today it inverted a premise in a brief I had already dispatched, on records that no path-scoped
mechanism could have found. That is the plugin doing something no amount of discipline replaces.

**Weakest part: `feature_article` has no compaction path.** The sharpest way to state it:

> **Four `feature_article` records can no longer be read in a single call by the tool designed to read
> them.** `economy` (70,425 chars), `dev-toolchain-setup` (64,194), `mech-part-export` (59,969) and
> `gathering-loop` (58,600) all overflowed the fetch. One article stands at **version 102**. The median
> across all 77 is **version 20**.

Around that: an `article_oversize` queue lane with a name and no remedy, 18 boarded items the designated
agent structurally cannot clear, an article that quotes its own dead paragraph in full before retracting
it, another that retains multi-hundred-word descriptions of files deleted two days ago — and a conductor
who, **in the same hour he diagnosed the problem, grew two more articles** because the contract offered
nowhere else to put the information.

**The last clause is the argument.** This is not an author-discipline problem that better habits fix. Four
different authors, one of them having just written the diagnosis, all produced the same growth, because
the contract's fix-forward rule gives correct guidance for `decision` and applies it unchanged to
`feature_article`, where it is backwards.

**There is roughly one structural item here, not five.** Proposals 1, 3 and 4 are three faces of the same
fix: *articles and decisions have opposite relationships with their own history, and the contract treats
them identically.* Proposals 2 and 5 are cheap mechanical additions.

**Would I rather work with it than without it? Yes, and not narrowly.** It caught four errors in my own
work today that would have reached the user, and two of those were in briefs about to fan out to multiple
agents, where one bad premise multiplies. The growth problem is real, it is getting worse, and it is
still a much better problem than not having the records at all.
