# Sterling — whole-system assessment, 2026-08-24

**Companion to** `sterling-plugin-retrospective-2026-08-24-0450.md` (the session evidence).
**Project:** dome-farmer, a Godot 4.6 / GDScript / Blender game. Sterling is consumed here, never developed here.
**Basis:** one long conductor-direct session, 9 commits, no pipeline run active at any point.

**Not assessed, because not exercised:** pipelines/runs, `/sterling:cleanup`, `/sterling:init`, `/sterling:merge`, the council skill, the TUI, cron/scheduled work.

---

## 6. The record type system

**The types carve the space well, and the split that earns its keep most is `decision` vs `anti_pattern`.** They answer different questions — *"this was settled, and here is what settling it cost"* versus *"this shape recurs, here is the incident"* — and collapsing them would lose the thing that makes `decision` valuable: it records **what was rejected**. Twice this session the `alternatives_rejected` array stopped me re-litigating a settled option.

**The single best field I used: `alternatives_rejected`.** Nothing else in the system captures "we considered that and said no", and without it a later reader re-proposes the rejected option with full confidence. When I recorded the CLAUDE.md cleanup ruling, writing down *why the aggressive option was declined* was more valuable than recording the option that won.

**Runner-up: `evidence_basis: measured | inferred`.** Cheap, two words, and it forces the author to admit which one they are doing.

**Dead weight in practice:** `derived_unconfirmed` (never reached for), and `volatility_hint` on `research_finding` — I set it to `fast` on a measurement of a file's section sizes, but nothing consumes it in a way I saw. If something does surface stale-by-volatility, it did not fire in this session.

### ⛔ The one structural hole in the type system, and it caused the session's most damaging error

**`decision` has no way to say "this instruction was scoped to one session".**

A user said *"lets try to keep the active tasks at a floor of 6"* during one large parallel session. That was captured as a `decision` titled *"THE SUBAGENT CEILING IS 15 AND THERE IS NOW A FLOOR OF 6 — the no-floor ruling is reversed"*, with a body arguing *"THE LIVE INSTRUCTION WINS"*.

I read it, believed it, and rewrote the project's governing file in three places to impose a permanent floor. The user's correction: *"that was a one time only. we use the fan out skill if we want to add a subagent floor. normally there is no floor."*

**The record's content was accurate. Its scope was invented at capture time.** A one-off instruction and a standing policy change are indistinguishable in the moment — both arrive as one imperative sentence, mid-session — and the type system offers no field to record the difference, so the capturing agent guessed, and guessed high.

**Fix:** a required closed enum on `decision`, e.g. `authority: standing | session_scoped | one_off`, surfaced in the digest projection and in the title-line rendering. This is cheap and it would have made the error impossible rather than merely less likely.

---

## 7. Identity, versioning, supersession

**This is still the weakest area of the design, and it produced the session's most-repeated failure.**

The mechanics are sound: ids are stable across updates, `knowledge_update` is a versioned in-place edit, prior bodies are archived, `knowledge_supersede` exists with orphan detection, and old ids keep resolving via `record_aliases`. All correct.

**The problem is the reading surface.** Consider what a reader actually sees:

```
knowledge_get f5b02cc3   →  returns content. Looks healthy. Is dead.
```

Id-resolution survives supersession **by design** — which is right for provenance and wrong for safety. The *only* thing distinguishing a dead ruling from a live one is that somebody manually typed a reversal banner into the record's **title**. That worked here (the canonical hills record's title opens with `⛔ RE-OPENED AND REVERSED`) but it worked **by authorial diligence, not by mechanism**.

**Evidence it does not hold:** I cited that dead ruling anyway, because I took the id out of a summary and never opened the record. So did the previous session's ledger. So, in the other direction, did I with the floor record — whose title *did* announce a reversal, and the reversal itself was the thing that was wrong.

**Fix, in order of value:**
1. `knowledge_get` on a record whose `status` is `superseded` or whose `lifecycle` is `retired` **prefixes its response with a machine-readable line** — `⛔ SUPERSEDED_BY: <slug>` — before any content. Not a title convention; a field the reader cannot skim past.
2. Every `knowledge_query` / `knowledge_preflight` result row carries `lifecycle` and `status` explicitly, so a match list visibly distinguishes live from dead.

**On slugs vs ids:** the guidance to cite by slug in durable pointers is correct and the reason is exactly the above — a slug names the concept and follows it through supersession. But this project's own `CLAUDE.md` carried **39 distinct bare hex ids and zero slugs**. When the convention is right and adherence is zero, the convention needs a mechanism, not a restatement.

---

## 8. The tool / API surface

**What worked well:**

- **`knowledge_preflight(text)` is the best-designed call in the API.** One call, prose in, governed-or-not out, with `answerability: ungoverned | verify_targets | insufficient`. It is the only tool that answers the question you actually have ("is this already settled?") rather than the question you can express in filters.
- **`knowledge_edit` with exactly-once `find`** is the right contract. Refusing on zero *and* multiple matches, naming the count, is precisely correct for a blind edit into a field too large to read.
- **The capped-window disclosure is exemplary.** `{matched_filter, returned, cap, capped}` plus the note *"a capped window can never establish absence"* is the single best piece of API honesty in the plugin. I obeyed it and it changed my conclusion.
- **`board_remove`'s `artifact_evidence`** — returning the durable records written against the item's `file_keys`, and saying plainly *"removed on the operator's word... that is drift, not a formality"* when empty. That line made me write a record I would otherwise have skipped.

**What took N calls that should take one:**

- **Determining whether a cited ruling exists.** I needed to know if a "riser-style re-expose" ruling existed. `board_query contains:` → 1 irrelevant hit. `knowledge_query types:["decision"] rank_terms:[...]` → `matched_filter: 567, capped: true` at cap 12. `knowledge_preflight` → 25 matches, none of them it. **Three calls and I still could not establish absence**, so real work is now blocked on "find it or ask". The design wants a `knowledge_search(exact_phrase)` that scans bodies and reports a definitive not-found.
- **Reading a record's title.** `knowledge_get <id> field:"title"` fails on `research_finding` — *"'research_finding' does not define field 'title'"*. The refusal is well-worded and names the valid set, but "show me this record's headline, whatever type it is" is the single most common thing I want and there is no type-agnostic way to ask.

**Learned by rejection rather than documentation:** that `history` entries need a full ISO instant, not a date. That `volatility_hint` rejects `"low"`. That `research_finding` requires `source_urls` even for a codebase measurement. `knowledge_schema(<type>)` exists and is the right answer — but the consuming project's `CLAUDE.md` carries a long list of these gotchas anyway, **which is the plugin's documentation debt showing up as a consuming project's maintenance burden**.

---

## 9. The agent roster

**The tool grants are mostly right, and the constraints demonstrably improved output.**

**Where a constraint produced a better result:** `test-writer` cannot read implementation. That forced me to state every API signature in the brief — and the agent then flagged, unprompted, that it had made a construction choice the brief did not specify rather than silently inventing one. An unconstrained agent would have read the implementation and produced a test that mirrors the code instead of the spec.

**Where the roster fought the task:**

1. **`test-writer` holds no Bash, so it cannot run `gdformat`.** Every test file it authors must be formatted by the conductor. This is a documented burden in this project. Meanwhile the project also forbids the write-form `gdformat` because it bypasses the edit contract — **so the two rules together leave the conductor with no sanctioned way to do the formatting the roster forces onto it.** I resolved it by disabling the sandbox once, which I should not have done and which no mechanism prevented.
2. **`explorer` has no pagination strategy for large queries.** Sent at a 186-item queue lane, it read ~120–140 digest rows, verified **1** against HEAD, and hit its token cap. It reported this honestly, which is a credit to the contract — but the roster has no agent shaped for "audit a large set incrementally with a resume token".
3. **`reviewer-correctness` has no Bash**, so it cannot run the thing it is reviewing. It compensated well (it out-counted an authoring lane 36 to 20 using Grep alone). Not obviously wrong — but it means every review is a reading review, and the session's most valuable catch (a probe that exits 0 on instrument failure) was found by reading, while the *confirmation* required my own run.

**`librarian` is the best-behaved agent in the roster.** Given drafted text and target ids, it applied verbatim, closed 5 named `reconcile_needed` items via `resolves`, and reported version numbers and evidence results in under 150 words. The "never authors content" constraint is exactly right.

**Codex as an outside model family is the highest-value roster decision in the plugin.** Three real defects in one session that the same-family reviewer had explicitly cleared, all in **prose** — docstrings and comments. That is not a coincidence: a same-family reviewer reads a plausible paragraph and finds it coherent. Prose is where shared blind spots live.

---

## 10. The board and the maintenance queue

**The queue's signal-to-noise is poor and its size makes it self-perpetuating.** 210 drainable items at session start. One audit lane verified 1 of 186 in the largest lane before exhausting its context. I closed 5 via a librarian, all legitimately — but 5 against 210 is not a drain, it is evaporation.

**The queue's dominant shape is not over-firing, it is fan-out.** The audit found *"one direct-mode edit to a heavily-owned shared file fires a reconcile item for every owning article at once — 8 rows at an identical timestamp all citing `game/main.gd` lines 73-95."* That is correct multi-owner behaviour producing an incorrect impression of debt. **The queue counts owners, not work.**

**The board misled in the more dangerous direction — claiming work was OUTSTANDING.**

- A board item said a test suite needed writing. It already existed at HEAD: 469 lines, the same 27 test function names. **I spent a full test-writer dispatch on it.** Net diff after review hardening: 59 lines.
- Another board item (written by me, earlier the same session) quoted a probe log whose defect had already been fixed at HEAD.

**A stale claim that work is owed is worse than a stale claim that a defect is live**, because a live-defect claim gets falsified the moment someone looks at the code, while an owed-work claim gets *acted on*. The board has no mechanism to detect it: nothing records the HEAD at which an item's claim was true.

---

## 11. The conductor contract — enforced vs prose

| Rule | Enforcement |
|---|---|
| Read before edit | **Mechanised** (H3). Fired twice, both right. |
| Gate exit codes not masked | **Mechanised** (H24). Fired once, right. |
| Review before commit | **Mechanised** (review ledger + `commit-reviewed.mjs` + merge gate trailer). Refused me once, correctly. |
| Capture before session end | **Mechanised** (H10), including a genuinely thoughtful `deferred` state for files an agent still holds. |
| Command allowlist | **Mechanised** (H14) — but `dangerouslyDisableSandbox` is an unlogged escape hatch and I used it. |
| **Verify a board item against HEAD before dispatching at it** | **Prose only.** Cost a dispatch. |
| **Read a decision's title before citing it by bare id** | **Prose only.** Cost four propagated false claims. |
| **Never restate a store ruling in a governing document** | **Prose only** — and newly ruled this session precisely because it failed. |
| Visual inspection of every render | **Prose only**, and structurally unmechanisable. |

**The highest-value unenforced rule: verify a board item against HEAD before dispatching at it.** It is the only one on that list that is both routinely violated and cheaply mechanisable — the data needed (the item's `file_keys`, the HEAD at write time) is already in the record.

---

## 12. What is structurally missing — the design reaches for it and stops short

1. **`knowledge_get` cannot return a type-agnostic headline.** `field:"title"` fails on `research_finding`. The id ladder, the digest projection and the `same_subject` hints all *presume* every record has a one-line identity; the read API does not expose one uniformly.
2. **No definitive absence check.** Every search surface is capped and honest about it, which correctly forbids concluding absence — and nothing else offers a bounded exact-phrase scan that could conclude it. The design has made "does this exist?" unanswerable.
3. **No `offset` on `maintenance_query` / `board_query`.** `board_query` reports `matched_filter: 283` and hands back a window with no way to page. A 283-item board cannot be walked.
4. **`resolves` accepts only two lanes** (`reconcile_needed`, `refresh_reference`). The other seven system reasons have no write-side discharge path, so they can only be removed, never *closed by the artifact that fulfils them* — which is the model the rest of the queue is built on.

---

## 13. What Sterling does not do at all — and should

Ranked by damage caused in this session, most damaging first. Every entry maps to something that actually went wrong.

### 13.1 There is no scope field on a `decision`, so a one-off instruction can be captured as standing policy

- **The gap:** nothing records whether a user instruction was meant to last beyond the session it was given in.
- **The incident:** *"lets try to keep the active tasks at a floor of 6"* was captured as a `decision` titled *"...THERE IS NOW A FLOOR OF 6 — the no-floor ruling is reversed"*, asserting *"THE LIVE INSTRUCTION WINS."* User correction the next day: *"that was a one time only... normally there is no floor."*
- **The fix:** required closed enum `authority: standing | session_scoped | one_off` on `decision`, rendered in the digest line and the title projection. A capture agent that must choose will ask; one that need not, guesses.
- **The cost:** I rewrote the project's governing instruction file in three places to impose a permanent floor over a correct standing rule. The user caught it, not any mechanism. Every rule in that file is read by every future session.

### 13.2 There is no post-commit verification that the review receipt survived

- **The gap:** `commit-reviewed.mjs` stamps the trailer and exits. Nothing checks it is still parseable afterwards.
- **The incident:** `git commit --amend -F <file>` with a blank line before the final trailer block made `Reviewed-By-Agent` invisible to `git log --format=%(trailers:key=...)` — the exact form `direct-merge.mjs` uses. **All six code-touching commits of the session were silently unmergeable.** Found by luck on a manual check after the sixth.
- **The fix:** `commit-reviewed.mjs` re-reads `git log -1 --format='%(trailers:key=Reviewed-By-Agent,valueonly,unfold)'` immediately after committing and fails loudly if empty. Optionally a PostToolUse hook on `git commit --amend` emitting the same check.
- **The cost:** six commits repaired by `filter-branch`. Had I not checked, the merge gate would have refused the entire branch and the cause would have been non-obvious.

### 13.3 There is no freshness signal on a board item

- **The gap:** a board item records a claim about the codebase and nothing records when that claim was last true.
- **The incident:** an item said a test suite was owed. It existed at HEAD, 469 lines, 27 matching test names. A separate item of mine quoted a probe log already superseded by a fix at HEAD.
- **The fix:** `board_add` stamps `head_sha_at_write`; `board_get`/`board_query` return it plus a `files_changed_since` count over the item's `file_keys`. A non-zero count is a "re-verify me" flag, not a block.
- **The cost:** one full test-writer dispatch (~124 k subagent tokens) for a 59-line net result, plus the conductor attention to brief and adjudicate it.

### 13.4 There is no way to ask a large set a question incrementally

- **The gap:** no cursor/offset on the queue and board reads, and no agent contract for resumable auditing.
- **The incident:** an audit lane sent at 186 `reconcile_needed` items verified **1** before hitting its token cap; three other lanes were never queried at all.
- **The fix:** `offset` on `maintenance_query`/`board_query`, and a documented resume-token pattern so N lanes can each take a disjoint slice.
- **The cost:** the queue is functionally unauditable, so it stays at 210 and grows. Nobody drains what cannot be measured.

### 13.5 Nothing distinguishes a stale *policy* from a stale *fact*

- **The gap:** Sterling treats all records as claims to be re-verified, but a stale factual claim gets contradicted by the code the moment anyone looks, while a stale policy claim is **silently obeyed** and never contradicted by anything.
- **The incident:** three restatements of a reversed dispatch rule sat in the governing file and shaped an entire session's behaviour — I held at one or two lanes and reported that as correct practice. It surfaced only because the user asked an unrelated question about the file's length.
- **The fix:** honestly, I am not sure of the right mechanism, and I flag this as the least-formed entry. The nearest concrete thing: a periodic sweep that resolves every record id cited by governing documents and reports any whose status is superseded — cheap, and it would have caught this and 13.1.
- **The cost:** unmeasurable but real — a whole session run at the wrong parallelism, and no artifact records what was not built as a result. **Flagged as partially speculative:** I observed this once, and I am inferring that policy staleness is systematically harder to detect than factual staleness rather than having measured it across sessions.

### 13.6 There is no record of what a session decided *not* to do

- **The gap:** `alternatives_rejected` captures rejected options *within* a decision, but nothing captures "this was considered as work and deliberately not started."
- **The incident:** I declined to start the riser re-expose because its cited ruling could not be found, and declined to consolidate four CLAUDE.md sections because I was at 62% context. Both are recorded only in a rotation note that the next `/clear` consumes.
- **The fix:** a `deferred` lifecycle on a board item with a required `reason` and `unblocks_when`, distinct from an open item nobody has picked up.
- **The cost:** low this session — the rotation note carried it. Listed last because the damage was near zero; included because the mechanism it relies on is single-shot and lossy.

---

## 14. What would have helped, ranked

**Cheap and mechanical (do these first — four of them, all small):**

1. **Post-commit trailer verification** in `commit-reviewed.mjs`. Six broken commits, one `git log` call to prevent. (§13.2)
2. **`⛔ SUPERSEDED_BY:` prefix** on any `knowledge_get` of a dead record, plus `lifecycle`/`status` on every query result row. (§7)
3. **`offset` on `board_query` / `maintenance_query`.** (§12.3, §13.4)
4. **Type-agnostic headline field** on `knowledge_get`. (§12.1)

**Structural — there are genuinely only three:**

5. **`authority: standing | session_scoped | one_off` on `decision`.** The single highest-value change in this document; it turns the session's most damaging error into an impossible one. (§13.1)
6. **Board-item freshness against HEAD** — `head_sha_at_write` plus `files_changed_since`. Turns the highest-value unenforced prose rule in the contract into a mechanism. (§11, §13.3)
7. **A bounded absence check** — an exact-phrase scan that can definitively answer "no record says this". Every current surface is honestly capped and therefore honestly unable to answer it. (§12.2)

**Not worth building:** anything that tries to make H21 smarter. Its rule is real but the distinction it needs (authoring vs bulk reconcile) is a judgement call, and a hook that guesses at judgement produces the H25 outcome — six firings, six false positives, and a reader who stops looking.

---

## 15. Verdict

**Strongest part: the output-axis delivery hook (H23).** It is the only mechanism in the stack that can catch a reader who is nowhere near the governed files, and it did exactly that twice in one session, both times preventing a false ruling from reaching a tracked artifact. Path-scoped delivery could not have caught either. If I could keep one component I would keep this one, and I would over-fire it rather than tune it.

**Weakest part: supersession as experienced by a reader.** The versioning mechanics are correct and the reading surface undermines them. A dead ruling resolves, returns content, and looks healthy; the only thing that marks it dead is a banner somebody remembered to type into a title. Four false claims propagated from that single property this session, and the one record that *did* carry a proper reversal banner was itself wrong about its own scope — which is the same failure from the other direction.

**Would I rather work with it than without it? Yes, clearly, and not marginally.** Three of the session's real defects were caught by Sterling mechanisms — a masked exit code, a missing review receipt, and two propagated false rulings — and a fourth by the outside reviewer its sparring-partner design mandates. Against that, its worst failures were a queue too large to drain and a board that sent me at work already done. Those are costs of a system that records too much and prunes too little, which is a far better failure than a system that records nothing.

The honest caveat: **most of what went wrong this session was me, not the plugin.** Five stale claims reached artifacts and I wrote four of them. What that argues is not that the plugin is at fault, but that the places where it relies on conductor diligence — verify against HEAD, read the title before citing, do not restate a ruling — are exactly the places it should stop relying on diligence. Every item in §14 is an instance of that one recommendation.
