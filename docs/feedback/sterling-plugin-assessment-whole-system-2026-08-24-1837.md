# Sterling plugin — whole-system assessment

**Date:** 2026-08-24, 18:37
**Companion:** `sterling-plugin-retrospective-2026-08-24-1837.md` holds the session receipts. Every claim here points back at one.
**Standing:** Sterling is consumed in this project and never developed here. This is upstream feedback.

---

## 6. The record type system

**The types carve the space correctly, and the split that earns its keep most is `decision` vs `anti_pattern`.** They answer different questions — *what did we choose and what did we reject* versus *what will bite you here* — and they have different lifetimes. A decision can be superseded by a later ruling; an anti-pattern is a property of the terrain and usually is not. Collapsing them would lose the rejected-alternatives structure, which did real work this session (§6.2).

**`feature_article` vs `concept` article** is the split I am least sure about. I wrote three feature articles and read one concept article. The distinction held, but the concept article (`damage-attribution`) was delivered to me by H19 alongside two anti-patterns and I treated all three identically: as pointers to read before editing.

### 6.1 The single best field: `alternatives_rejected`

Not close. Its shape — `{option, reason}[]` — forced the *reason* to be written next to the *option*, and that is what made two records load-bearing this session.

- `9456cdc7` listed four rejected shapes for the trade UI. When I re-offered one of them a day later, the record did not just say "wrong" — it said **why all four shared an assumption the user had not agreed to.** That sentence is a better critique of my behaviour than anything I would have written about myself.
- `ef4cc627` rejected a short carcass timer with: *"with ~6 starting workers most of a 300-kill breach would evaporate uncollected, reading as broken rather than tight."* A lane found exactly that failure mode a month later. **The rejected alternative predicted the defect.**

**A `decision` without `alternatives_rejected` is a note. With it, it is an argument.** If one field in the schema deserves to become required, it is this one.

### 6.2 `known_gaps[].kind: "mutation_survivor"` is a genuinely novel idea and it worked

The `feature_article` schema carries `known_gaps` with `kind: mutation_survivor` — a place to record *"this assertion stays green under the named sabotage, and here is why that is defence-in-depth rather than hollowness."*

A dispatched agent used it correctly and unprompted, recording two survivors on the escalation pins: E0 survives the constant-curve sabotage because step=0 is invariant by construction; F1 survives the `==`→`>=` sabotage because it only checks the exact boundary, and F3 is what actually reddens.

**I know of no other system that has a field for "this test is green for a reason you would otherwise misread".** In a project that shipped four hollow tests in one day, it is the right field to have invented. It deserves to be promoted from an optional array on one record type into something the test-authoring workflow prompts for.

### 6.3 Dead weight

- **`derived_unconfirmed`** — never used, never surfaced, no observable effect on my session.
- **`working_tree`** on `feature_article` — unused; branch context came from git.
- **`concept_family`** — unused by me, though H19 clearly uses something like it to group deliveries.
- **`file_baselines`** — server-owned and invisible at query projection. CLAUDE.md warns that *"a path taken from a `files` array or a `file_baselines` hash proves the file existed once, not that it exists now"*, which suggests it has been actively misleading in the past.

---

## 7. Identity, versioning, supersession

### 7.1 The abbreviation model is inconsistent across the surface, and I hit it three times

- `board_get`, `board_update`, `board_edit` — **accept** 8-char prefixes.
- `board_remove` — **refuses** them, with an excellent justification (hard delete, irreversible retarget).
- `knowledge_get` — accepts them.
- **`links[].target_id` on a create — refuses them**, and a dispatched agent hit this twice, reporting: *"the short id `6421cc42` isn't accepted, only the full UUID."* It worked around it by dropping the link and keeping a prose citation, which **silently degrades the graph**: the record now mentions the anti-pattern in text but is not connected to it.

**That last one is the real cost.** The abbreviation is what fits in a brief, a comment and a report; the full UUID is what the link field wants. So the path of least resistance for an agent is to write the citation as prose and lose the edge. **`links[].target_id` should resolve abbreviations through the same ladder as `knowledge_get`** — its worst case is a wrong edge, which is recoverable, not a hard delete.

### 7.2 Supersession has no partial form, and I needed one

`70f0b56e` (carcass salvage ships in v1, corpses do not disappear) overrides **one clause** of `d17d51c2`. But `d17d51c2` also rules that two of four turret kinds ship in v1, and that mech battle damage is v2 — both still live, both unrelated.

`knowledge_supersede` replaces a whole record. So I handled it with prose: the new record states which clause it overrides and that the rest stands. **That works only as long as someone reads the new record.** A reader arriving at `d17d51c2` from a query sees an `active`, `fresh`, unmarked record whose carcass ruling is dead.

**This is the reader's-eye-view problem the skill flags as historically expensive, and it is still live.** Three records now touch carcass lifetime — `d17d51c2` (rots on a timer), `ef4cc627` (lasts the whole breach plus a grace period), `70f0b56e` (does not disappear) — and **only the newest one knows about the other two.**

**Shape of the fix:** a `clause_superseded_by` annotation, or simply allowing `links` with `rel: "supersedes"` to be written *onto the old record* so a reader of `d17d51c2` sees an inbound edge. The graph already has the relation; it just does not surface backwards.

---

## 8. The tool / API surface

### 8.1 The thing the design obviously wants and does not have: an absence query

`knowledge_query` returns `matched_filter: 861, returned: 18, capped: true` and correctly notes that *"a capped window can never establish absence."* But **"is anything ruled about X?" is the most common question a conductor has**, and it is the one the surface cannot answer.

`projection: "count"` exists in the enum. It counts the *filter*, not the ranked-and-thresholded set, so it does not close this either.

**Shape:** `knowledge_query({rank_terms, min_score})` returning only records above a relevance threshold, with an honest `above_threshold: N` — so that `N: 0` is a usable "nothing ruled here" and `N: 3` is a usable "read these three". Today the only way to approach an absence claim is to raise `cap` until `capped: false`, which on 861 records is not a query, it is a download.

### 8.2 `projection: "digest"` is not small enough to audit a real board

108,392 characters for 289 digest rows (~370 chars/row). The board is the surface a new session trusts first, and **it cannot be read in one call by the agent that most needs to read it.** A `projection: "headline"` — id, priority, objective, first 80 chars — would make a 289-item board a ~25 KB read.

### 8.3 Six schema rejections for two records

Detailed in the retrospective §2.3. `knowledge_schema` is a good idea that stops one step short: it reports `verifiable_at` as type `literal "final" | string` (accurate but easy to misread as "any string") and `date` as `string` with no indication that a bare `2026-08-24` is refused. **Adding `example` alongside `type` in the schema response would have prevented four of the six.**

### 8.4 What took N calls that should take one

Updating a board item's *count* required re-transmitting its entire ~5 KB text through `board_update`, because the tool is whole-text replacement. I did this once, and then had to remove the item entirely an hour later. `knowledge_append` and `knowledge_edit` exist for articles; **the board has no equivalent.**

---

## 9. The agent roster

### 9.1 The roster's tool grants pushed me off the roster entirely

I dispatched **`general-purpose` for eight of nine build lanes.** Not because the roster was wrong about what those agents should *do*, but because of what they cannot *see*:

- `coder` has no `board_*` tools. Every lane in this session needed to read its own board item.
- `librarian` has `board_query` but **not `board_get`** (H25 correctly flagged this) — so it cannot fetch a full item to rewrite it, which is most of what a board-hygiene librarian does.
- `explorer` has no Bash, so it cannot run a gate.

So the briefs said *"read board item X with `mcp__sterling__board_get`"*, and only an unconstrained agent could comply. **The roster's constraints are well designed and I routed around all of them**, which means this session got none of their benefit — no H4 implementation-blindness for authoring lanes, no enforced read-only for explorers.

**The fix is small: give `coder` and `debugger` read-only `board_get` + `board_query`, and give `librarian` `board_get`.** A work order that lives on the board cannot be executed by an agent that cannot read the board.

### 9.2 The constrained agent produced a *better* result — twice

The counterweight, and it is strong.

**`test-writer`'s H4 implementation-blindness forced a better test design.** It refused to write an overdraw case because the only available number — decision `4af77954`'s starting crop buffer — is *"explicitly a tuning value... to be set at build"*, and hardcoding it would repeat a known failure. When I supplied the public getter names instead, it pinned the **delta** rather than any absolute. **An unconstrained agent that could read the implementation would have read the current value and pinned it.** The constraint produced a test that survives every future tuning pass.

**Four lanes refused work and every refusal was correct** (retrospective §3.5). One refused an invariant I had instructed it to assert, with a measurement showing my invariant was false.

### 9.3 The structural hole: `test-writer` cannot verify its own mutations

`test-writer` holds no Bash. So the agent that *designs* a sabotage cannot *run* it. My first brief to it listed gate commands it could not execute — my error, corrected mid-session — but the deeper issue is that **mutation verification, the practice that catches hollow tests, is split across two actors by the roster's own design.** The author names the sabotage; the conductor applies it.

In this session that split is precisely where a hollow test got through: E2 and E3 shipped with a step of zero (retrospective §3.3), and the author could not have discovered it because it could not run them.

---

## 10. The board and the maintenance queue

**Signal-to-noise on the board is poor, and it is a lifecycle problem rather than a size problem.** 289 open items. Of the first six I dispatched at, **four were already satisfied** — and their claims were of *absence*, which is the direction that does not self-correct.

**Both stale directions were present:**
- Stale claiming a defect is LIVE: `534d624a` demanded percentages be replaced with conversions, when `game-design-doc.md:1202` rules the percentages verbatim. **Acting on it would have broken a ruled behaviour** — worse than wasted work.
- Stale claiming work is OUTSTANDING: five of `3fb04c36`'s nine lanes.

**The board has no notion of the HEAD its evidence was measured against.** An item is `updated_at`-stamped, but the thing that matters is *"this claim was true at commit X"*. That single field would let a session sort its board by staleness risk instead of by priority. See §13.2.

**The maintenance queue:** I never drained it. One item (`043a1366`, reconcile `worker-animations` after `worker_crew.gd` was touched) was auto-raised correctly and surfaced to me by an agent rather than by a hook. That auto-raise is the right behaviour and it worked.

---

## 11. The conductor contract — enforced vs prose

| Rule | Enforcement |
|---|---|
| Store writes go through the MCP surface | **Mechanism** (H15) |
| Frozen test paths | **Mechanism** (H5) |
| test-writer cannot read implementation | **Mechanism** (H4) |
| Subagent command allowlist | **Mechanism** (H14) |
| Gate exit codes not swallowed by `;`/`\|\|` | **Mechanism** (H24) |
| Reviewed-By-Agent trailer at merge | **Mechanism** (merge gate) |
| **Consult the store before acting** | **Prose only** |
| **A design question is always an ask** | **Prose only** |
| **Visual inspection is the conductor's own eyes** | **Prose only** |
| **Every path in a brief is grepped that turn** | **Prose only** |
| **Exactly one windowed Godot run project-wide** | **Prose only** |

### The highest-value unenforced rule: *consult the store before acting*

It is the rule the whole product rests on — the store is the source of truth only if someone reads it — and **it is enforced by nothing.** The delivery hooks approximate it from three angles and all three are reactive: they fire when you touch a path, dispatch a brief, or read tool output. None fires on the act the rule actually governs, which is **deciding**.

It failed in this session, in the most visible possible way, and the user's response was to state a requirement the current design does not meet: *"i dont want you to be able to check, i want us to trust that it works without us having to check."*

**Second place: exactly one windowed Godot run project-wide.** Two concurrent windowed runs corrupt the engine's class-name cache and destroy every render in flight. This is prose in CLAUDE.md and a sentence I hand-copied into eleven briefs. **A lock file would cost nothing.** Nothing prevented a lane from starting a second one except that I told each of them not to.

---

## 12. Structurally missing — the design reaches for these and stops short

1. **A relevance-thresholded query** (§8.1) — the family has `rank_terms` and `cap` but no `min_score`, so it can order but never conclude.
2. **Partial supersession** (§7.2) — the graph has `rel: "supersedes"` but a superseded *clause* has nowhere to live, and the old record shows no inbound edge.
3. **Abbreviation resolution on `links[].target_id`** (§7.1) — every other read call resolves prefixes; this one does not, and the cost is silently-dropped edges.
4. **A board equivalent of `knowledge_append` / `knowledge_edit`** (§8.4) — the board is whole-text replacement only.
5. **`example` values in `knowledge_schema` output** (§8.3) — the call exists to prevent learning-by-rejection and does not quite manage it.
6. **Board read-access for `coder` / `debugger`, and `board_get` for `librarian`** (§9.1) — work orders live on the board; the agents that execute them cannot read it.

---

## 13. WHAT STERLING DOES NOT DO AT ALL — AND SHOULD

Ranked by damage caused in this session.

### 13.1 There is no retrieval gate on the act of ASKING THE USER

**The gap:** no mechanism fires when the conductor is about to put a question to the user, so a question can be asked about ground the store has already settled.

**The incident:** I asked the user how the part sell-back screen should look. They replied *"scrollable window with item icon grid like starsector. **this should already be ruled!**"* It was — `9456cdc7`, from their own words the previous day. One `knowledge_query` found it as the top hit the moment I ran it, *after* asking. Sterling's H23 had delivered two adjacent trade decisions to me earlier in the same session but not that one. The user's ruling on the standard required: *"i dont want you to be able to check, i want us to trust that it works without us having to check."*

**Shape of the fix:** a PreToolUse hook on `AskUserQuestion` that extracts nouns from the question and option text, runs the same ranking the delivery hooks use, and injects the top matches **before the form renders** — with the same pointer-not-ruling framing H19 already uses. It does not need to block. A single line reading *"⚠ 2 decisions match this question's subject: 9456cdc7, 376a7d58"* would have been sufficient, and the machinery to produce it already exists in three other hooks.

**Cost in this session:** one wasted user interaction; a design question re-opened that the user had already closed; and had they answered differently under a false premise, a second competing ruling in the store. It is also a **repeat** — the project carries a prior anti-pattern for the same shape from a design document rather than the store.

### 13.2 There is no HEAD provenance on a claim, so nothing can tell a fresh board item from a rotten one

**The gap:** board items and records carry `updated_at` but not *"this evidence was measured at commit X"*, so no surface can flag a claim whose basis predates the current HEAD.

**The incident:** board item `3fb04c36`, one day old, explicitly titled *"AUDITED AGAINST HEAD `232d7c1` ... USE THIS INSTEAD OF RE-AUDITING"*. Five of its nine lanes were already done. It stated the HEAD **in its own prose**, which proves the author knew the field was needed and had nowhere structured to put it.

**Shape of the fix:** an optional `measured_at_head` string on board items and on `research_finding`/`anti_pattern`. Then `board_query` returns a `stale_risk` flag when `measured_at_head != HEAD`, and H10 can say *"3 of the items you are about to dispatch at were measured 4 commits ago."* The comparison is one `git merge-base --is-ancestor`.

**Cost in this session:** I verified five claims by hand before dispatching. Four other lanes were dispatched at items I had *not* verified, and all four came back refusing them. **Four full agent dispatches — roughly 500k subagent tokens — spent discovering that work was already done.** They produced value anyway, because each found a real adjacent gap, but that was luck in how I wrote the briefs, not design.

### 13.3 There is no distinction between "a frozen test is inconvenient" and "the ruling it pins was overturned"

**The gap:** H5 blocks edits to frozen test paths for subagents. There is no way to *legitimately* unfreeze a test because the behaviour it pins has been deliberately inverted by a new ruling.

**The incident:** the user ruled that corpses no longer disappear (`70f0b56e`, overriding `7d07a18a`). Three frozen tests — `swarm_corpse_test.gd` C4 and C8, `swarm_facing_test.gd` F8 — assert that corpses vanish after a linger timer. `-a res://test/sim` returned **257 cases, 15 failures, exit 100**. These are not regressions; they are the old ruling, correctly pinned, now wrong. The test-writer edited all three and reported *"no hook blocked them"* — so the outcome was right, but **only because H5 did not fire, not because anything distinguished this case from softening an inconvenient test.**

**Shape of the fix:** an `unfreeze_for_ruling(test_path, superseding_decision_id)` call that records *which* decision authorises the inversion and stamps it into the test file's header. Then a frozen-test edit without such a record is deniable, and one with it is auditable. The project's own convention already demands the citation in prose — the test-writer wrote *"header updated to cite `70f0b56e` over the superseded `7d07a18a`"* — so the practice exists and the mechanism does not.

**Cost in this session:** none, because the right thing happened by convention. **Flagged as speculative on recurrence** — I observed one instance. But the failure mode it guards is severe: a green suite that certifies whatever the code happens to do.

### 13.4 There is no notion of a dispatch that DIED with un-gated writes in the tree

**The gap:** when an agent terminates abnormally, nothing records that it held write territory and had not finished its gates.

**The incident:** one lane terminated on `API Error: 403 Unable to verify organization membership`, mid-sentence at *"All clean. Now the scoped suite..."*. Its edits to `breach_schedule.gd`, `breach_warning.gd` and `breach_spawner.gd` were already on disk, ungated. I found it by running `git status` on a hunch.

**Shape of the fix:** the dispatch register already tracks declared territory (H26 uses it). On an abnormal task exit, emit one line: *"⚠ dispatch <id> died holding <paths>; its gates did not complete."*

**Cost in this session:** none directly — I checked. But the test pin authored against that lane's work was the hollow one (§13.5), and its missing gate run is exactly what would have surfaced it.

### 13.5 There is no falsifiability check on a test assertion

**The gap:** nothing inspects whether a test's arguments make its assertion capable of failing.

**The incident:** `escalation_scale_for(0, 0)` vs `escalation_scale_for(9, 0)` asserting `high > low`. With step zero both sides are 1.0 forever. Its sibling E3 had the same defect and was **green**, pinning nothing. Caught only because an unrelated lane ran the suite and reported `431/432, exit 100`.

**Shape of the fix:** honestly, this is hard to do statically and I will not pretend otherwise. The tractable version is a **workflow** one: `knowledge_schema`-style prompting in the test-authoring path for the two fields the good articles already carry — the named sabotage, and whether it was *observed* red. A `mutation_observed: bool` on the pin. Today `known_gaps.kind: "mutation_survivor"` records survivors after the fact but nothing asks *"did you run it?"*

**Cost in this session:** one red suite, one round trip to the test-writer, and — more importantly — a green test that pinned nothing and would have shipped.

### 13.6 There is no lock for a genuinely exclusive project resource

**The gap:** Sterling models write territory as *files*, and this project's most dangerous shared resource is not a file.

**The incident:** exactly one windowed Godot run may exist project-wide; two corrupt the engine's class-name cache and destroy every render in flight. I enforced this by writing *"⛔ No windowed run; I hold that slot"* into **eleven briefs by hand**, and by holding the slot in my own head across a 20-dispatch session.

**Shape of the fix:** a named-resource claim in the dispatch register — `exclusive_resources: ["windowed-godot"]` — that H26 checks alongside file territory. One lane holds it; a second dispatch declaring it gets the same advisory H26 already emits for overlapping paths.

**Cost in this session:** zero incidents, but the mitigation was my attention on every one of twenty dispatches. **This is the clearest case in the document of a machine job done by hand.** Flagged as partly generalising: the specific resource is project-shaped, the *category* — an exclusive non-file resource — is not.

---

## 14. What would have helped, ranked

**Cheap and mechanical (a few hours each):**

1. **Retrieval injection on `AskUserQuestion`** (§13.1) — reuses three existing hooks' machinery. Highest damage prevented per line of code in this list.
2. **`measured_at_head` + a `stale_risk` flag** (§13.2) — one field, one `git merge-base` call. Would have saved four dispatches.
3. **Abbreviation resolution on `links[].target_id`** (§7.1) — silently dropped graph edges, twice, in one session.
4. **`projection: "headline"` for `board_query`** (§8.2) — 108 KB → ~25 KB.
5. **`example` values in `knowledge_schema` output** (§8.3) — would have prevented four of six rejections.
6. **Board read tools for `coder`/`debugger`, `board_get` for `librarian`** (§9.1) — the reason I bypassed the roster.
7. **Dead-dispatch-holding-territory warning** (§13.4) — the register already has the data.
8. **Teach H25 about built-in agent types** (retrospective §2.4) — eleven unactionable warnings train the reader to skim a hook that was right once.

**Structural — and there are genuinely only three:**

9. **Partial supersession, and inbound supersedes-edges visible from the old record** (§7.2, §13.3). Three records now disagree about carcass lifetime and only the newest knows it. This is the one I would fix first of the three.
10. **A relevance-thresholded query that can support an absence claim** (§8.1). The store's core promise is undermined by a retrieval layer that can order but never conclude.
11. **An exclusive-resource claim in the dispatch register** (§13.6) — generalises territory from files to named resources.

---

## 15. Verdict

**The strongest part is the delivery layer, and specifically that it inspects *briefs* and *tool output*, not just files.** H20 caught a dispatch of mine built on a premise the store had settled an hour earlier. H19 handed me a hazard about phase-edge listeners that a lane then checked and cited in its report. **Nothing else in the stack looks at a brief before it goes out**, and in a nine-lane fan-out a bad premise is multiplied by nine. That, plus `alternatives_rejected` — a field whose shape forces the reasoning to be written next to the choice — is the part of this design I would not want to work without.

**The weakest part is that the system's foundational rule is the one nothing enforces.** *Consult the store before acting* is what makes the store worth having, and it is prose. The three delivery hooks approximate it reactively — on a path touch, a dispatch, a tool result — and all three miss the moment that matters most, which is **deciding**. It failed in this session in the most visible way available: I asked the user to re-decide something they had ruled the day before, and the record was one query away. The user's response is the requirement the design should be measured against: *"i dont want you to be able to check, i want us to trust that it works without us having to check."*

**A second, quieter weakness: the board is a first-class surface with second-class lifecycle support.** 289 items, no provenance on when a claim was measured, whole-text updates only, and unreadable in a single call by the agent that most needs to read it. Four of the first six items I dispatched at were already satisfied. The board was the least trustworthy input in the session and it is the input a fresh session trusts first.

**Would I rather work with it than without it? Without hesitation, yes** — and the honest reason is not the hooks. It is that when I finally asked the store the right question, it answered a live design escalation with a ruling the user had made a month earlier, *including a rejected alternative that predicted the exact failure the lane had just found*. No amount of care substitutes for that. The gap between how good that moment was and how easily I skipped it an hour earlier is the whole of this document.
