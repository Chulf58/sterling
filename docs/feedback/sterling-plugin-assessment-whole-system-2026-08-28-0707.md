# Sterling — whole-system assessment

**Date:** 2026-08-28, written 07:07
**Evidence base:** one full conductor-direct session in dome-farmer (Godot game project), ~20 subagent
dispatches, 2 commits. Evidence receipts live in the companion file
`sterling-plugin-retrospective-2026-08-28-0707.md`.

This document reviews the **design**. The session is the evidence, not the subject.

---

## THE ONE-LINE VERDICT, FIRST

**Sterling's knowledge layer is excellent and its staleness layer barely exists.** The plugin is very good
at helping you *write down* what is true, and has almost no mechanism for noticing when what you wrote
down stopped being true. That single asymmetry produced the largest measurable waste in this session:
**eleven false claims of absence**, one of which was a priority-HIGH board item that explicitly instructed
readers not to re-audit it.

Everything below elaborates or qualifies that sentence.

---

## 6. The record type system

**The types carve the space correctly.** `decision`, `anti_pattern`, `research_finding`,
`feature_article`, `reference_material`, `disconfirmed_hypothesis`, `attestation`, `todo`, `brief` — I used
five of the nine this session and none felt like a forced fit.

**Would collapsing any two lose something?** Yes, twice, and both are worth defending:

- **`decision` vs `anti_pattern`.** A decision records *what was chosen and what was rejected*; an
  anti-pattern records *a trap and how to detect it*. This session produced one of each from the same
  incident — a user ruling on held poses (`decision`) and a testing trap about state-vs-call pins
  (`anti_pattern`). Collapsing them would have forced one record to do two jobs for two different readers.
- **`research_finding` vs `decision`.** Findings carry two clocks (`source_date`, `capture_date`) and a
  `volatility_hint`. Decisions carry `authority` and `alternatives_rejected`. These are genuinely
  different epistemics — "the world was like this when measured" versus "we chose this".

### The single best field: `alternatives_rejected`

Not close. Every H20 delivery renders it as `✗ ALREADY REJECTED: ...`, and it repeatedly stopped me
re-litigating settled questions. Concretely: when I was about to treat terrain traversability as open,
the delivery showed decision `d87b88ed` with `WALKABLE — real elevation... Not rejected on merit; rejected
as wrong for v1`. That one line told me the question had been *considered and reversed*, which is a
different fact from "there is a decision about terrain".

It is also the field that makes a *superseded* record still worth reading. `d87b88ed`'s ruling is dead but
its `rationale` carries a five-item measured cost list that became the work plan. A record type without
`alternatives_rejected` would have thrown that away.

### Fields that did real work

- `authority: standing` — distinguishes a durable rule from a one-off call. Load-bearing.
- `known_gaps` on `feature_article` (with `kind: "mutation_survivor"`) — I used it to record that the
  manifest cannot be reconciled until a held re-export runs. Exactly the right home for "this is wrong on
  purpose, here is why".
- `measured_at_head` on `todo` — see §10 for why it is under-used rather than dead.
- `state` + `state_reason` on `feature_article` — the `state_reason` free-text is where the honest caveat
  goes.

### Fields that were dead weight, for me

- `working_tree` — I set it once, never read it.
- `catalog` on `reference_material` — not exercised.
- `volatility_hint` — I saw it in schema output and never had a case where I would have trusted a record
  more or less because of it. Possibly valuable in a longer-lived store; unproven here.

---

## 7. Identity, versioning and supersession

**This is materially better than the failure mode CLAUDE.md still warns about, and the docs have not
caught up.**

Stable identity works. `knowledge_update`/`append`/`edit` write in place, bump a server-owned `version`,
and archive the prior body reachable via `knowledge_get id version:<n>`. I saw an article go v20 → v23
across three appends with the id unchanged. That is correct and it is the foundation for durable citation.

**The remaining identity defect is a surface mismatch, and it bit three times:**

Prose in this store cites records by **8-character prefix** (`d87b88ed`, `67cbdf96`, `a143f643`), because
that is how every record, board item and CLAUDE.md line writes them. But:

| Tool | Accepts prefix? |
|---|---|
| `knowledge_get` | **No** — needs full uuid |
| `board_get` | Yes |
| `board_update` / `board_edit` | Yes |
| `board_remove` | **No** — full uuid only |

So the store's own citation convention is unusable against half its own read tools. There is an
anti-pattern about exactly this (`decae4de`: *"Records cite each other by 8-CHARACTER PREFIX, but
`knowledge_get` needs the FULL uuid — constructing the rest of it produces a confident lookup for a record
that does not exist"*). **A hazard record documenting an API inconsistency is documentation debt, not a
hazard.** The fix is one line of id-resolution in `knowledge_get`.

`board_remove`'s stricter rule is *justified* and it explains itself well (hard delete, prefix could
retarget a live row). But the inconsistency is unsignposted until you hit it.

**Can a reader tell a live record from a dead one in the surface they actually use?** Mostly yes, and by
convention rather than by mechanism. `d87b88ed`'s **title** reads *"Hills are IMPASSABLE for v1 — ⛔
RE-OPENED AND REVERSED 2026-07-31; read this record ONLY for its cost list"*. That works — but it works
because a human wrote a banner into the title. The `status`/`superseded_by` fields exist; the H20 delivery
does not appear to surface them prominently, and I never saw a delivery say "this record is superseded".
**A superseded record delivered without its status is the expensive failure mode**, and I cannot say from
this session whether it still occurs, because every superseded record I met carried a hand-written banner.

---

## 8. The tool/API surface

### What took N calls that should take one

**`files[]` surgery on an article.** The safe procedure is: page `knowledge_get field:"files"` with
`offset`/`length` until you can state the total → compute the new array → write with `expected_version`
CAS → re-read → confirm the delta is exactly ±1. That is 4–6 calls, and getting it wrong **silently
truncates the array with no warning** (anti-pattern `d25f5a9e`).

I ran this dance three times this session via a librarian, and every one reported an exact delta because
the brief spelled out the protocol. **A protocol that must be spelled out in every brief is a missing API
call.** The design obviously wants:

```
knowledge_files_add(id, [{path, role}], expected_version?)
knowledge_files_remove(id, [paths], expected_version?)
```

Server-side, atomic, delta reported. This is the single most obvious missing operation in the surface.

### What had to be learned by rejection rather than from documentation

- `live_test_refs` entries need `test_paths` (array), not `path`. A librarian hit the schema rejection,
  retried, and reported: *"first call failed schema validation... retried successfully with correct
  shape"*. `knowledge_schema` returns field names and types but the nested element shape was not obvious
  enough to get right first time.
- `board_remove` prefix rule (§7).
- That `todo` + `source: "system"` is the maintenance queue and `source: "user"` is the work board — this
  is documented, but it is the kind of overload where a wrong value silently moves an item between two
  surfaces.

### Genuinely good API design worth naming

- **`min_score` + `above_threshold` on `knowledge_query`.** The doc string explains it answers *"the
  ABSENCE QUESTION a capped window cannot"*, computed over the full match set rather than the capped
  window. That is a thoughtful piece of design and the reasoning is stated where the caller will read it.
- **`projection: "digest" | "headline"`** on the board/queue queries. Paging 294 board items at
  `headline` was cheap; reading 12 in full was targeted. The right escape hatches exist.
- **`board_remove`'s `artifact_evidence` return.** Removing an item disclosed which durable records had
  touched its `file_keys` since creation, and explicitly said `"an empty list means the close rides YOUR
  word"`. When I removed a stale item it correctly reported `artifact_evidence: []` plus
  `check_skipped: no_file_keys` and told me the close was on my word alone. **That is the plugin
  reasoning about its own epistemic standing**, and it is excellent.

---

## 9. The agent roster

**Tool lists are mostly right, with three concrete defects.**

### Defect 1 — `explorer` cannot read a board item in full

`explorer` holds `board_query` but **not** `board_get`. `board_query` with `contains:` + `projection:
"full"` is a workaround, but it requires knowing a distinctive phrase from an item you have not read.
Explorer is *the* recon agent and board items are *the* recon substrate; this gap bit three briefs.
Adding `board_get` to `explorer` is a one-line frontmatter change.

### Defect 2 — `test-writer` has `Write` but no `Edit`

This forces a **whole-file rewrite to add one case to an existing suite**, re-typing every frozen case by
hand. There is an anti-pattern about it (`6faa528e`). In this session a test-writer rewrote
`run_mode_peacetime_rim_test.gd` **three times** (initial, orphan fix, stub restoration), re-typing PIN 2
verbatim each time. It reported doing so faithfully and a reviewer spot-checked it — but the design is
asking an agent to hand-transcribe frozen contracts repeatedly, which is a data-integrity risk with no
mechanical check. **Giving `test-writer` `Edit` removes the risk entirely.**

### Defect 3 — every agent's exit protocol assumes a run exists

Covered in the companion file §2.1: ~12 agents each hit `agent_exit`/`handoff_write` refusing with *"no
active run"*. Conductor-direct is the primary mode by user decision. Either the roster should not
instruct agents to call these in direct mode, or the tools should no-op gracefully.

### Where agent constraints produced a BETTER result than an unconstrained agent

This is the strongest argument for the roster design and deserves to be stated positively:

- **`test-writer`'s H4 wall produced two correct refusals.** One refused board `80d122f4`'s pins naming
  exactly which constants were missing (*"Which class declares `_apply_peacetime_rim`... whether that
  owner is constructible out of tree..."*). An unconstrained agent would have read the implementation and
  written tests that certify whatever the code happens to do. **The refusal was the valuable output.**
- **`librarian`'s "never authors content" constraint produced a correct refusal** when my brief's premise
  did not match the item: *"Its current text is about gdlint `max-public-methods`... not a silent garage
  refusal. Did not force the edit."*
- **`coder` lanes dispatched at falsified work built nothing and said so** rather than manufacturing a
  change to justify the dispatch.

Four correct refusals in one session. The roster's constraints are doing real work.

---

## 10. The board and the maintenance queue

### The maintenance queue: good mechanism, ~46% noise

15 items → 2. Of the 13 closed, **6 were already paid** — the article had been corrected in a prior
session and the item simply had not been re-evaluated. The queue's own doc string predicts this
(*"expect much of it to be ALREADY DONE"*), which is honest, but a queue that is ~46% already-paid trains
its reader to skim.

**The queue's most valuable design property**, which I want to name because it is subtle and correct: it
distinguishes three kinds of absent file — `file_parked` (on a ref tip), `deletion_candidate` (never
tracked), `reconcile_needed` (on no ref tip at all) — and the third **cannot be closed by any write**,
because the trigger is absence and a write does not make a file appear. Getting that taxonomy right is
what makes the drain tractable at all.

### The board: 294 items, and the staleness problem is structural

**This is the weakest part of the system, and it is worth being blunt.** The board has:

- **No expiry.** Nothing ages, nothing escalates, nothing is ever asked to re-justify itself.
- **`measured_at_head` that mostly cannot fire.** The server computes a *"⚠ file_keys changed in N commits
  since this item's evidence was measured"* annotation and reports `provenance: "checked"` — but it needs
  `file_keys`, and **most stale items carry none**. Board `67cbdf96` carried 5 `file_keys` and its
  falsified claims were about files not in that list. The one item where the annotation fired
  (`f7ae471a`, `⚠1 commits since measured`) turned out to be accurate.
- **No distinction between an item that asserts a defect is LIVE and one that asserts work is
  OUTSTANDING.** The second kind is far more dangerous — nobody goes looking for what they were told is
  missing — and the schema cannot express the difference, so no mechanism can weight them differently.

The result is measurable: **eleven false absence claims**, three wasted builder dispatches, and a
priority-HIGH item instructing readers not to re-audit it.

---

## 11. The conductor contract — enforced versus prose

| Rule | Enforced by | Reality |
|---|---|---|
| Frozen tests not edited | **H5** (hard deny) | Mechanical |
| test-writer blind to implementation | **H4** (hard deny) | Mechanical |
| Gate exit codes not masked | **H24** (hard deny) | Mechanical, 2/2 correct |
| Code-touching commit has a review | **`commit-reviewed.mjs` + merge gate** | Mechanical — but see below |
| Store writes go via MCP | **H15** | Mechanical |
| Subagent Bash allowlist | **H14** | Mechanical |
| **Verify by mutation** | **Prose only** | Done once, voluntarily |
| **Grep every path in a brief that turn** | **Prose only** | I violated it |
| **A board item states its evidence** | **Prose only** | Widely violated |
| **Re-verify an item against HEAD before dispatching** | **Prose only** | Cost 3 dispatches |
| **A receipt is not a blank cheque — check its `at`** | **Prose only** | Caught by hand |

### The highest-value unenforced rule: **verify by mutation**

CLAUDE.md rule 6 says a green suite is not evidence when you change a ruling, and demands you name the
one-line mutation and *apply it*. Nothing checks this.

In this session it was the difference between a real pin and a hollow one. A test-writer named a mutation,
`reviewer-correctness` read the test and **passed it clean**, and only when I applied the mutation myself
did the truth appear:

```
with mutation:  2 test cases | 0 errors | 1 failures    line 122: Expecting:
after revert:   2 test cases | 0 errors | 0 failures
```

Cost of doing it: one `awk`, one scoped run, one `git checkout --`. About two minutes. **It is the
cheapest high-value check in the entire contract and it is the least enforced.**

### A second unenforced rule worth naming: receipt freshness

`commit-reviewed.mjs` stamps a `Reviewed-By-Agent` trailer from any valid ledger entry regardless of when
it was written. My first receipt was timestamped `04:26:01`; substantive work landed until `04:55`. The
trailer would have been *truthful-looking and false*. CLAUDE.md warns about this in prose; I caught it by
comparing timestamps by hand and ran a second review, which found a **data-loss defect**. Had I trusted
the receipt, that defect would have shipped.

---

## 12. What is structurally missing — the design reaches for it and stops short

1. **`knowledge_files_add` / `knowledge_files_remove`.** The `files[]` array is a first-class relationship
   (it drives H19 delivery, H10 article demand, and the maintenance queue) and there is no first-class way
   to edit it. Everything else about arrays in this API is careful; this one gap is filled by an
   anti-pattern and a hand-copied protocol.
2. **Prefix resolution in `knowledge_get`.** The store's own prose citation format does not work against
   its primary read tool. One resolution step closes it.
3. **Superseded status surfaced in H20/H19 deliveries.** The fields exist; the delivery does not appear to
   lead with them. A delivered record should announce that it is dead before it announces its content.
4. **`measured_at_head` staleness that does not require `file_keys`.** The annotation machinery is built
   and correct; it just cannot reach the items that need it most. Comparing the item's `measured_at_head`
   against current HEAD *at all* — even without file scoping — would have flagged `67cbdf96` as measured 5
   days and ~40 commits ago.

---

## 13. What Sterling does not do at all — and should

Ranked by damage caused **in this session**. Every entry is anchored to something that actually went
wrong.

---

### 13.1 There is no staleness pressure on board items — nothing ever makes an old claim re-justify itself

**The gap:** the board has no mechanism by which an item's age or distance-from-HEAD affects how it is
presented, prioritised, or trusted.

**The incident:** board `67cbdf96`, priority **high**, written 2026-08-23, read at HEAD `9e14c0a` five days
and dozens of commits later. Its text: *"⚠ EVERYTHING BELOW WAS ESTABLISHED BY A LANE THAT ACTUALLY DID
THE WORK, so it is fresher than the board generally... USE THIS INSTEAD OF RE-AUDITING."* Ten of its
claims were false. I dispatched three builder lanes at LANE A; all three built nothing.

**Shape of the fix:** `board_query` already computes commits-since-measured for items with `file_keys`.
Extend it to every item using `measured_at_head` alone, and render a line the caller cannot miss:

```
⚠ measured 5 days / 41 commits ago at 25b6c7e — this item's claims have NOT been re-checked since
```

Better still, make it a *hook* at dispatch time: if a brief cites a board id whose `measured_at_head` is
more than N commits behind HEAD, emit an advisory the way H25 does for tool grants.

**Cost this session:** 3 wasted builder dispatches (Opus and Sonnet), plus my adjudication of three
reports, plus the rewrite of the item afterwards. Call it 40 minutes of wall-clock and a meaningful
fraction of a context window.

---

### 13.2 There is no mutation-testing affordance, for a contract that mandates mutation testing

**The gap:** the conductor contract requires "verify by mutation" for any ruling-adjacent behaviour change.
Sterling provides no way to express, record, or check a mutation.

**The incident:** the peacetime-rim pin asserted final state and was blind to a `set_peacetime_rim(false)`
regression. A `test-writer` named the mutation in a comment. `reviewer-correctness` read the file and
returned it **clean**, stating *"PIN 1's control is real and correctly ordered"* — a true statement about a
neighbouring property. Only applying the mutation revealed the hole (`1 failures`, line 122).

**Shape of the fix:** a `mutation` field on `feature_article.known_gaps` already exists in spirit
(`kind: "mutation_survivor"`). What is missing is the *front half*: a way to declare, per acceptance
criterion, `must_redden_under: "<one-line edit>"`, and a hook at commit time that warns when a changed
test file has ACs with no recorded mutation result. Even purely advisory — *"3 ACs in this diff declare a
mutation and none has a recorded run"* — would have prompted me.

**Cost this session:** the hollow pin survived a test-writer, a same-family reviewer, and a full green
suite. It was caught by an outside model family and then only proven by a manual check I chose to do.
Without that choice, a test pinning nothing would have shipped and been trusted.

---

### 13.3 There is no brief preflight against the repository — only against tool grants

**The gap:** H25 checks whether a brief names tools an agent lacks. Nothing checks whether a brief names
**files that do not exist, line numbers that have moved, or premises contradicted by HEAD**.

**The incident:** four brief defects in one session. I asserted a double-count in
`_vendor_clip_coverage.py:81` that did not exist (a lane measured it and told me). I cited
`router.gd:676-679` from a board item whose real lines were `581-582` and `676-678`. I told a `test-writer`
to run gates it cannot run. CLAUDE.md has a standing rule — *"EVERY FILE PATH IN A BRIEF MUST BE GREPPED
THAT TURN"* — precisely because *"one wrong path becomes N wrong premises, and agents reason confidently
from a brief rather than doubting it."* It is prose and I violated it.

**Shape of the fix:** a PreToolUse hook on `Agent` that extracts `path:line` citations from the prompt and
warns on any that do not resolve at HEAD:

```
⚠ BRIEF PREFLIGHT — 2 citations do not resolve:
   game/sim/router.gd:676-679 — file has 1083 lines, but no `goal_cell` guard at that range
   game/ui/foo.gd — path does not exist at HEAD
```

Warn-only, same severity model as H25. Note this is *cheap*: it is a file-existence check plus optionally
a "does this line still contain what you claim" grep.

**Cost this session:** one full dispatch spent measuring a defect I invented, plus a mid-flight correction
round to three agents, plus a `test-writer` that could not run its gates so I ran them.

---

### 13.4 There is no receipt-freshness check, so the review gate can be satisfied by a stale review

**The gap:** `commit-reviewed.mjs` stamps a `Reviewed-By-Agent` trailer from any valid ledger entry. It
does not compare the entry's `at` against the working tree's modification times or the diff.

**The incident:** my first receipt was `"at":"2026-08-28T04:26:01.116Z"`. Substantive changes — a whole-file
test rewrite and every fix to an outside reviewer's findings — landed until ~04:55. I noticed by comparing
the timestamp to `date -u` by hand and dispatched a second review. **That second review found a
CONFIRMED data-loss risk**: a dedupe fingerprint that compared no keyframe values and would have silently
destroyed a vendor animation clip.

**Shape of the fix:** in `commit-reviewed.mjs`, before stamping, compare each ledger entry's `at` against
the newest mtime among staged files. If any staged file is newer, refuse or loudly warn:

```
⚠ RECEIPT STALE: entry at 04:26:01 predates 4 staged files (newest 04:55:12).
  The review did not see: tools/blender/mech_port/clip_census.py, ...
```

**Cost this session:** none, because I checked by hand — but the *near-miss* is the finding. Had I not
checked, a data-loss defect would have been committed under a truthful-looking review trailer.

---

### 13.5 There is no live file-ownership registry an agent or hook can query

**The gap:** H26 exists to prevent concurrent writers, but it infers territory by extracting paths from
prompt text, which is why it flagged the Godot binary and the gdUnit4 CLI as contended.

**The incident:** a board-triage `explorer` read `game/sim/router.gd` while a `coder` was writing it, and
reported a `push_error` at `:693-706` that does not exist at HEAD. I caught it only because I ran
`git show HEAD:game/sim/router.gd`. There is already an anti-pattern for this class (`e8d45a38`) which H20
delivered to me, and I dispatched the audit anyway.

**Shape of the fix:** have the dispatch layer maintain the registry it already half-maintains — a
`declared_territory` on the Agent call rather than a regex over the prompt — and expose it as a read:
`dispatch_territory()` returning `{agent_id, files[], since}`. Then H26 becomes precise, and a read-only
agent can be *told* "these paths are being written right now; read them from `git show HEAD:` instead".

**Cost this session:** one confidently wrong finding that I nearly acted on (I had already dispatched a
coder to add a `push_error` that the triage lane claimed already existed). Caught by one `git show`.

**Speculation flag:** I observed this once. I am confident the mechanism generalises because the
anti-pattern record documents a prior independent occurrence, but I have not measured its frequency.

---

### 13.6 There is nothing that requires — or even records — a second, outside-family review

**The gap:** the review gate counts `agent_type` matching `/^reviewer-/`. Two reviews from the same model
family satisfy it exactly as well as two from different families.

**The incident:** `reviewer-correctness` (Opus) reviewed the diff and returned **clean on all five ranked
questions**, explicitly blessing the pin that was blind. Codex (outside family), same diff, same brief
structure, returned four real findings including two HIGH. Later, on the delta, `reviewer-correctness`
found a **confirmed data-loss risk** that would have shipped. Across the session the two families caught
disjoint defect sets, twice.

**Shape of the fix:** record `model_family` on the ledger entry, and let the merge gate express a policy
such as `require_distinct_families: 2` for code-touching diffs. Even without enforcement, *recording* it
would let a project measure whether its reviews are correlated.

**Cost this session:** zero, because the project's CLAUDE.md already mandates Codex by local convention.
**But that mandate is prose in a consuming project**, not a plugin capability — so every other Sterling
project gets same-family review by default and cannot tell.

---

### 13.7 There is no way to mark a record as "expected to fail" so its red is not read as a regression

**The gap:** no field or convention distinguishes a gate that is *correctly* red from one that is broken.

**The incident:** `_clip_gap_diag.py` now exits 1 with `DIAG_FAIL problems=6` **by design** — the manifest
predates a user ruling and only a deliberately-held re-export can reconcile it. I had to spend a dispatch
teaching the tool to label its own failure `EXPECTED` versus `NEWS`, and record the same fact in an
article's `known_gaps` and in the rotation note, because otherwise the next session sees a red gate and
investigates a non-defect.

**Shape of the fix:** this is arguably project-level, but Sterling could carry it: an `expected_failure`
entry on `feature_article` with `{gate, signature, until, reason}`, surfaced by H19 whenever the gate's
path is touched. The `until` is the important part — it should expire.

**Cost this session:** one dispatch to implement labelling, plus three separate places I had to write the
same caveat to be confident it survives a `/clear`.

**Speculation flag:** I am generalising from one instance to a class. Whether "deliberately red gates"
recur often enough to deserve a record type, I cannot say from one session.

---

### What Sterling does NOT need, which I want to say plainly

I found **no** case this session where a new *record type* would have helped. Every gap above is a hook, a
call, a field, or a check. The type system is the healthiest part of the design and does not need
extending — extending it would be the wrong instinct.

---

## 14. What would have helped, one ordered list

Cheap and mechanical, in value order:

1. **Board staleness annotation without requiring `file_keys`** (§13.1). Highest damage prevented per line
   of code in the whole list.
2. **Receipt freshness check in `commit-reviewed.mjs`** (§13.4). A timestamp comparison. Prevented a
   data-loss commit this session only by my manual diligence.
3. **Brief preflight on `path:line` citations** (§13.3). A file-existence check in a PreToolUse hook.
4. **`board_get` added to `explorer`'s grant** (§9). One frontmatter line.
5. **`Edit` added to `test-writer`'s grant** (§9). Removes a hand-transcription risk entirely.
6. **Prefix resolution in `knowledge_get`** (§7). Makes the store's own citation convention work.
7. **`agent_exit`/`handoff_write` no-op gracefully in direct mode** (§9). Recovers ~12 wasted calls per
   session.
8. **Superseded status led in H19/H20 deliveries** (§12.3).
9. **H26 precision** — declared territory instead of prompt regex (§13.5).

Structural, and there are genuinely only **three**:

10. **`knowledge_files_add` / `knowledge_files_remove`** (§12.1) — the missing first-class operation on a
    first-class relationship.
11. **Mutation declaration and checking** (§13.2) — new surface, but it is the contract's highest-value
    unenforced rule.
12. **Model-family recording on review receipts** (§13.6) — small to build, changes what a merge gate can
    express.

**Deliberately not recommending:** any new record type; any increase in H19/H20 delivery volume; any
hardening of H26 into a blocking hook while its precision is this low.

---

## 15. Verdict

**Strongest part: the knowledge record design, and `alternatives_rejected` above all.** Sterling is
unusually good at capturing *why* something was decided and *what was rejected*, and the H20 delivery of
`✗ ALREADY REJECTED` lines stopped me re-opening settled questions several times in one session. The
refusal-quality of the tool surface is also genuinely high — `board_remove` explaining hard-delete
retargeting, `board_query` disclosing `capped`, `board_remove` returning `artifact_evidence` and saying
plainly when a close "rides YOUR word". These are the marks of a system designed by someone who has been
burned by silent success.

**Weakest part: nothing in Sterling notices when a record stops being true.** The board is 294 items with
no expiry, no re-justification, and a staleness annotation that structurally cannot reach the items most
likely to be stale. This session spent three builder dispatches on falsified work and found eleven false
claims of absence — a failure mode the design has the raw material to prevent (`measured_at_head` exists,
the git walk exists, `provenance` is reported) and simply does not wire up.

**The uncomfortable observation:** the hooks are excellent at guarding *actions* (H24 on exit codes, H5 on
frozen tests, H4 on the test-writer wall — all deterministic, all correct when they fired) and absent on
guarding *beliefs*. Every serious near-miss this session was a belief failure: a stale board item, a brief
with an invented premise, a receipt that predated its diff, a pin that pinned nothing. The action-guarding
layer is close to done. The belief-guarding layer barely exists, and items 1–3 of §14 are its cheapest
first three pieces.

**Would I rather work with it than without it?** Without hesitation, yes. Four correct agent refusals, two
correct H24 denials, a rotation note that restored a prior session's context intact, and a review gate
that caught a data-loss defect are outcomes I would not have had otherwise. But I would be uneasy handing
this store to a session that trusted it — and that unease is exactly the gap between the two layers above.
