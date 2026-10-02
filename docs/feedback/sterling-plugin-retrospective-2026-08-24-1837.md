# Sterling plugin retrospective — session evidence

**Date:** 2026-08-24, 18:37
**Project:** dome-farmer (Godot 4.6 + Blender; Sterling is CONSUMED here, never developed here)
**Session shape:** one large fan-out. Branch `feat/fan-out-2026-08-24b` cut from `d1f4d20`. Nine lanes dispatched in one message, then refilled by `SendMessage` rather than re-spawned; ~20 dispatch units total across 11 distinct agents. **Zero commits at time of writing** — 36 uncommitted paths, the single commit still pending behind the last lane.

**Companion document:** `sterling-plugin-assessment-whole-system-2026-08-24-1837.md` carries the design review (Parts B and C). This file is the evidence.

---

## 1. Where it genuinely helped — receipts

### 1.1 The delivery hooks caught errors in MY OWN briefs, twice

**H19 (path axis) on `game/run/breach_debrief.gd`** delivered three anti-patterns to me at the moment I was writing a brief for that file, including `4353cf84` — *"A NEW EDGE into an existing state inherits none of the listener branches keyed on the OLD edge — every handler that switches on `from_phase` silently does nothing."* I pasted all three into the lane's brief. The lane came back having explicitly checked each: *"Anti-pattern check, `4353cf84`: does not apply — no new phase edge added."* The hazard did not bite, and the check is now in the record.

**H20 (subject axis) fired on a dispatch whose brief I had written without consulting the store.** Its line: *"the store holds records matching this prompt's SUBJECT rather than any file you touched. Path-scoped delivery cannot find these."* It surfaced `70f0b56e` (the carcass ruling made an hour earlier in the same session) with its rejected alternatives inline. This is the axis that catches a brief built on a premise the store has already settled, and it is the only one that can.

**This is the strongest evidence in the document that the design is sound.** Nothing else in the stack — not the test suite, not lint, not a reviewer — inspects a *brief* before it goes out. A bad premise in a fan-out brief is multiplied by N.

### 1.2 H23 (output axis) surfaced a ruling I was about to contradict

After a lane reported on the breach ledger, H23 delivered `ecb22cc8` (*"The breach ledger is per-breach, computed from a breach-start snapshot"*) and `4316f9c8` (*"An aggregate's numerator and denominator must answer the SAME question"*). The second one was directly on point: the lane was widening an aggregate's baseline. It reported back that it had checked `4316f9c8` and that it did not apply because `_run_deaths` is an append-only list rather than a computed ratio. Correct, and checked rather than assumed.

### 1.3 `board_remove` refused an abbreviated id — and the refusal message was the best documentation in the system

```
board_remove: no record '604007f4' — and this tool addresses items by their EXACT full uuid only
(no slug, no 8-char citation prefix) ... Board rows are HARD-DELETED, so an abbreviation that once
named a now-removed item can silently retarget to a different, live item and destroy it
irreversibly; that is why the full id is required here — board_get, board_update and board_edit
still resolve abbreviations, because their worst case is a recoverable edit.
```

It refused, explained the asymmetry, justified it by consequence, and told me which sibling calls *do* accept abbreviations. **Nothing was destroyed and I did not have to guess.** This is the standard the rest of the API surface should be held to (see the companion document, §8).

### 1.4 `board_remove`'s `artifact_evidence` disclosure

Removing the (wrong) board item returned:

```
"artifact_evidence":[],"note":"no fulfilling artifact-write found ... removed on the operator's
word. If work fulfilled this item, its capture is missing (that is drift, not a formality)."
```

In this instance the empty list was correct — the item was withdrawn as false, not completed. But the mechanism is right: it makes a silent close visible without blocking it.

### 1.5 `capture_pending` is the correct escape valve and it worked

H10's capture duty re-armed four times while nine lanes held the tree. `capture_pending` let me declare *"captured, landing later"* against named agent ids, with the discharge trigger written into the reason. **The alternative would have been a false `no_capture` or a rushed article describing a file that was still moving** — and one of those files (`breach_schedule_test.gd`) was materially rewritten between two of the declarations, which is exactly the risk.

### 1.6 The store answered a design question so I did not have to ask the user

Late in the session a lane escalated: *"if salvage is a peacetime job, the bodies are destroyed before any worker can reach them."* One `knowledge_query` + one `knowledge_get` returned `ef4cc627`, which rules verbatim: *"bodies last the rest of the breach plus a grace period, so harvest is a peacetime job you plan rather than a scramble you lose"* — and which had **already rejected a short timer for precisely the failure the lane found**: *"with ~6 starting workers most of a 300-kill breach would evaporate uncollected, reading as broken rather than tight."*

Two calls converted an escalation into a defect report. **This is the single clearest demonstration of the store paying for itself in this session.** It is also the direct counterexample to §3.1 below, where I failed to make the same two calls.

---

## 2. Friction

### 2.1 `board_query` on a real board is unusable in one call

```
board_query source:"user" projection:"digest" cap:400
→ result (108,392 characters) exceeds maximum allowed tokens. Output saved to <file>.
→ {"matched_filter":289,"returned":289,"cap":400,"capped":false}
```

`projection:"digest"` — the projection that exists to make a board auditable — **still produced 108 KB for 289 items**, spilled to a file whose lines were too long for offset/limit chunking. I recovered by `sed`-ing the JSON in a shell, which is precisely the "shell scripts against the store" pattern the conductor contract forbids for *writes* and which should not be necessary for *reads*.

**Digest is not digest enough.** Each row still carried ~370 characters of item text.

### 2.2 `knowledge_query` cannot establish absence, and says so — but that is still the problem

```
{"matched_filter":861,"returned":18,"cap":18,"capped":true,
 "note":"...rank_terms ORDERED those 861 and did not narrow them ... a capped window can never
 establish absence"}
```

The note is honest and well-written. It is also a statement that **the primary retrieval call cannot answer "is there a ruling about X?"** — only "here are 18 of 861, ordered by relevance". For a system whose central promise is *the store is the source of truth*, the inability to answer an absence question is the deepest issue in the tool surface. It is what made §3.1 possible.

### 2.3 Field shapes had to be learned by rejection — four rejections for one record

Writing a single `decision`:

1. `'id' is SERVER-OWNED and cannot be assigned by a caller`
2. `'decision' does not define 'context', 'decision', 'consequences' — Valid fields: ... rationale ... statement ...`
3. `alternatives_rejected: received string, expected array`
4. `alternatives_rejected[0]: received string, expected object — expected shape: {option, reason}`

Then, writing a `feature_article`:

5. `current_ac[0].verifiable_at: Invalid` (it must be the literal `"final"`)
6. `history[0].date: Invalid datetime` (a bare `2026-08-24` is refused; a full ISO timestamp is required)

And a dispatched agent hit the same class twice on `links[].target_id`, reporting: *"the short id `6421cc42` isn't accepted, only the full UUID"*.

**Six rejections across two records, all recoverable, all avoidable.** Every message was clear about *what* was wrong. `knowledge_schema` exists and is good — but its output does not distinguish "a string" from "the literal string `final`", and does not say that `date` means a full datetime. I called `knowledge_schema` first for `anti_pattern` and `feature_article` and still got rejected twice on the latter.

**Evidence that this is systemic rather than my inexperience:** this project's CLAUDE.md carries a section of hand-maintained call-shape warnings — the Godot-unquoted/Blender-quoted trap, the `disable`-not-`ignore` lint spelling, the H24 `;`-swallows-exit-code rule. That file is documentation debt of the surrounding toolchain showing up as a consuming project's burden. The store API is now adding to it.

### 2.4 H25 fired on every single `general-purpose` dispatch

```
H25: dispatch capability for subagent_type 'general-purpose' cannot be checked — no installed
agent definition was found at .claude/agents/general-purpose.md on this machine.
```

Nine times in one message, then again on each refill. `general-purpose` is a **built-in harness agent type**, not a Sterling roster agent — it has no `.claude/agents/*.md` and never will. The hook has no notion of built-in types, so it emits an unresolvable warning forever. **Advisory noise that can never be actioned trains the reader to skim H25**, which matters because H25's *other* firing in this session was genuinely useful (§2.5).

### 2.5 H25's useful firing, and H26's wrong one — same dispatch

On dispatching a `librarian`, H25 correctly reported: *"the brief mentions tool(s) its installed grant does not hold: 'board_get' — not held by this agent's grant"*. **True and useful** — the librarian roster has `board_query` but not `board_get`.

On the same dispatch, H26 reported: *"this dispatch's brief names file(s) that overlap a LIVE in-flight dispatch's declared territory: 'game/main.gd', 'game/sim/swarm.gd'"* — against a **librarian that writes only to the Sterling store and touches no file at all**. The overlap was real in the *text* of the brief (I quoted those paths as evidence in board verdicts) and entirely absent from the *behaviour*. H26 discloses this limitation in its own message (*"the prompt extraction only approximates write territory"*), which is the right way to ship an approximation.

### 2.6 A dead lane left ungated work in the tree, and nothing noticed

One lane terminated on `API Error: 403 Unable to verify organization membership` mid-gate. Its last words were *"All clean. Now the scoped suite..."*. **Its edits to three files were already in the working tree, un-gated and unverified.** Nothing in Sterling knows a dispatch died with writes outstanding; I found it by running `git status` on a hunch. The work turned out to be fine, but its test pin was later found to be *hollow* (§3.3) — which is exactly the class a dead lane's missing gate run would hide.

---

## 3. Wrong information — including mine

### 3.1 THE MOST EXPENSIVE FAILURE OF THE SESSION, AND IT WAS MINE

A lane escalated: how should ~336 mech parts fit a 15-tile sell grid? I put it to the user through `AskUserQuestion`. The user answered:

> *"scrollable window with item icon grid like starsector. this should already be ruled!"*

It was. Decision `9456cdc7`, from the user's own words on 2026-08-23: *"every item is in the same grid. use starsector game sell/buy as refence still"*. **One `knowledge_query` with `rank_terms` of starsector/trade/grid returned it as the top hit** the moment I finally ran it — after asking.

Worse, that record's own `alternatives_rejected` contains the exact shape I had just re-offered, and its rationale says: *"a conductor drafting options should notice when all of them share an assumption the user has not agreed to."*

**Sterling's delivery was working and did not carry this.** H23 had delivered *other* trade decisions to me earlier in the session — `7bbdef3f` (four trading mechanics) and `7e619393` (the half-price sell-back fraction) — but not `9456cdc7`. The three delivery axes are PATH (a file named in a command), SUBJECT (a dispatch brief) and OUTPUT (tool output consumed). **None of them is "the conductor is about to ask the user a question."** That moment is when a missed retrieval costs the most, because the user's answer becomes a second, competing ruling.

**The user's ruling on this, verbatim, when I offered to check whether the lane had received a pointer:**

> *"i dont want you to be able to check, i want us to trust that it works without us having to check"*

That is a design requirement for the delivery layer and it is the single most important line in this document.

**Honest split:** the duty was mine. CLAUDE.md says in as many words that staging retrieval is the conductor's job and no hook does it. I skipped it. The structural gap is real but secondary — and it is §13.1 in the companion document.

### 3.2 A board item, audited one day earlier, was half wrong — and it said not to re-audit

Board item `3fb04c36`, written 2026-08-23, was titled *"THE VERIFIED FAN-OUT PLAN ... AUDITED AGAINST HEAD `232d7c1` ... USE THIS INSTEAD OF RE-AUDITING."* It listed nine ready lanes.

I verified five of them against HEAD in one shell command. **All five were already done**, shipped by the commit between the audit and this session:

| Claim | Reality at HEAD `d1f4d20` |
|---|---|
| A — command-bar glyphs frozen, still letters | `farm_command_bar.gd:74-90`: freeze explicitly lifted, worker tile draws a silhouette |
| D — `weapon_mesh_name` still empty | `machine_gun.gd:896-898`: the dead export is **gone** |
| E — morale dial *"Confirmed absent by grep"*, *"the cleanest parallel pick"* | `morale.gd`, `morale_readout.gd`, `morale_test.gd` all exist |
| F — warning quality not built | `breach_warning.gd` header now reads *"IS NOW BUILT"* — the literal opposite |
| G — no `PlotType` enum | `field_plots.gd:158` declares it |

Lane H's own board item `60055030` was no longer on the board at all.

**A one-day-old audit was half wrong, and its own text instructed the reader not to re-check.** The dangerous half is that every one of those five was a claim of **ABSENCE** — *not built, unwired, confirmed absent by grep*. Nobody goes looking for what they were told is missing. Captured as `research_finding 2f3c1794`.

### 3.3 A test I commissioned pinned nothing, and only a cross-lane suite run caught it

The test-writer produced `breach_schedule_test.gd`. Its E2 case:

```
var low := escalation_scale_for(0, 0)
var high := escalation_scale_for(9, 0)
assert_bool(high > low).is_true()
```

**Step is zero, so both sides are always 1.0 and the assertion cannot pass against any correct implementation.** E3 had the same flaw and was *green* — "non-decreasing at a fixed step" is trivially true when every reading is 1.0. So one arm was impossible-red and its sibling was meaningless-green, from the same defect.

It surfaced only because an unrelated lane ran `-a res://test/run` and reported `431/432, exit 100`. **Nothing in Sterling looks at whether a test's arguments make its assertion falsifiable**, and this project has a recorded history of exactly this class — four hollow tests in one day, including a case where 71 of 84 passed under the behaviour they were written to invert.

### 3.4 Records I wrote that were wrong — twice, on the same item

I created board item `604007f4` reporting *"ELEVEN LEGS SHIP AT ONE-HUNDREDTH SCALE"*, HIGH priority, with measurements, file:line citations and a count method. I then rewrote it to *"TWENTY-SIX SKIN-BOUND MESH NODES"*. I then **removed it entirely** — there was no defect at all.

**The board item was, for about an hour, a well-evidenced instruction to break 26 working assets.** Both candidate fixes it pointed at would have left an inverse-bind-matrix ×100 uncompensated, making every skinned part 100× too large behind a green suite.

What prevented it was not a mechanism. It was a judgement call to send the lane to *prototype and measure* rather than to rule from its report.

### 3.5 A brief of mine was wrong and the agent refused it correctly

I instructed the mech lane to assert an invariant: *"skin-bound → metres; plain node → centimetres"*. It refused with a measurement: root scale is 0.01 on only **36 of 361** files, so no library-wide unit threshold exists, and an absolute unit test *"would flag real 24 cm rocket sub-meshes"*. It asserted a measured empty band instead (defects ≤ 0.05096, smallest legitimate node 0.24450, floor 0.12).

**Four lanes refused work in this session and every refusal was correct.** That is worth stating as a positive result about agent design (companion document, §9).

---

## 4. Too much / too little information

| Delivery | Size | Fraction used |
|---|---|---|
| `board_query` digest, 289 items | 108,392 chars, **spilled to file** | ~2% (I extracted ids/objectives with `sed`) |
| H19 on `game/sim/swarm.gd` | 12 pointers in one block | 2 used (`b1ee290e`, `94581dfe`) |
| H23 output-axis blocks | 3–6 pointers each, `(+8 more matched)` | ~1 per block |
| `knowledge_get` on one decision (`ef4cc627`) | ~5,700 chars | ~100% — the whole record mattered |
| `knowledge_query` digest, cap 18 | ~2,600 chars | 1 record pursued |

**The pointer-shaped deliveries are correctly sized; the full-record reads are correctly sized; the board is not.** H19's twelve pointers on `swarm.gd` looks excessive at a glance but cost perhaps 400 tokens and two of them were load-bearing — that is a good trade. The 108 KB board response is the only delivery in the session that was genuinely unusable as returned.

**`(+8 more matched)` is the right design.** It tells me the window is a window.

---

## 5. Hook-by-hook

| Hook | Fired | Verdict |
|---|---|---|
| **H1** (session-start conventions) | 1× | Useful. Carried the delegation ruling and the "an idle slot is not a finding" clause, which shaped how I refilled lanes. |
| **H5** (frozen test paths) | **0×, correctly** | The test-writer edited three frozen tests to invert a superseded ruling and reported *"no hook blocked them"*. Right outcome — but see §13.3 in the companion: nothing distinguishes a legitimate ruling-change inversion from an inconvenient test being softened. |
| **H10** (capture/context/article demand) | ~8× | Mixed. The capture duty is right and `capture_pending` handles it. The **article demand re-fired identically** after each partial discharge, listing files still open under live dispatches — it has no notion that a file is mid-edit. Its context-pressure line (35% soft threshold) correctly changed my behaviour: I delegated the article writing instead of doing it myself. |
| **H14** (command allowlist) | 0 denials observed | No lane reported a denial. Briefs carried the quoting trap explicitly, which is probably why. |
| **H19** (path axis) | ~6× | **Best hook in the system.** Two of its pointers were checked and cited by lanes in their reports. |
| **H20** (subject axis) | 1× | Fired on a dispatch brief and surfaced a same-session ruling. The only axis that inspects a brief. |
| **H23** (output axis) | ~6× | Good, with the caveat that it delivered adjacent trade decisions but not the one that mattered (§3.1). |
| **H24** (gate exit lint) | 0× | Not triggered — no lane wrote `<gate>; echo $?`. Cannot assess. |
| **H25** (dispatch capability) | ~12× | **One true positive** (librarian lacks `board_get`), **eleven unactionable** (`general-purpose` has no definition file and never will). |
| **H26** (dispatch overlap) | 1× | False positive on a store-only librarian, self-disclosed as approximate. |
| **Nothing** | — | **No mechanism fires before `AskUserQuestion`.** Cost: §3.1. |
| **Nothing** | — | **No mechanism noticed a dispatch died with un-gated writes in the tree.** Found by manual `git status`. |
| **Nothing** | — | **No mechanism flagged a test assertion that cannot fail.** Found by an unrelated lane's suite run. |
| **Nothing** | — | **No mechanism flagged a board item whose evidence predates HEAD.** `3fb04c36` was one day old and half wrong; I checked it by hand. |

---

## 6. What I did not exercise

I cannot assess, and did not use: the **gated pipeline / runs** (`run_state`, `run_signal`, `run_escalate`, `agent_exit`), **`/sterling:cleanup`**, **`/sterling:init`**, **`/sterling:merge`** (the session never reached a merge), **`/sterling:council`**, the **TUI dashboard**, **`handoff_read`/`handoff_write`**, **`knowledge_promote` / `split` / `supersede` / `retire` / `link` / `preflight`**, and the **maintenance queue drain** (`maintenance_query` was surfaced by an agent report but I never drained it — item `043a1366` is still open).

⚠ **`knowledge_supersede` deserves specific mention as unexercised-but-needed:** the session produced a ruling that overrides part of an older record (`70f0b56e` overriding `d17d51c2`'s carcass clause). I handled it with prose inside the new record because the old record's *other* rulings — turrets, mech battle damage — remain live. See companion §7.
