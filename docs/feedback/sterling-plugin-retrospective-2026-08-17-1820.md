# Sterling plugin retrospective — 2026-08-17, evening session (18:20)

**Project:** dome-farmer (Godot 4.6 + Blender, GDScript). Branch `feat/asset-pack-swap`.
**Session shape:** started at `aea0ba2`, one commit landed (`3a67b01`), a second slice open and uncommitted at
the time of writing. ~14 subagent dispatches. Three full suite runs (1033 cases green; 1046 cases with 1
failure, exit 100; a third running).
**Prior retrospectives exist** for 2026-08-14, 08-15 and twice earlier on 2026-08-17 (09:00 and 10:45). This is a
fresh account, not a revision — I grepped one for its heading shape only.

Companion document: `sterling-plugin-assessment-whole-system-2026-08-17-1820.md` (Part B — the design review).
This file is Part A: the session evidence.

---

## 1. Where it genuinely helped — receipts, prioritising catches on MY OWN work

This session was unusually rich in this category. **Eight separate times, a hook-delivered record caught a defect
in a brief I had just written or in code I was about to accept.** None of these would have been caught by lint,
format, parse checks, or the test suite.

### 1.1 The single most valuable catch: a scaled basis would have silently divided a motion by 100

I briefed a procedural weapon recoil that translates a node along `_rest_basis.z`. H20 delivered
`anti_pattern 5dfac54d` ("READING `Basis.get_euler()` OFF A SCALED BASIS") on the dispatch. The record states that
every part this project's Blender pipeline exports carries `scale 0.01`, and that a 90° rotation once read as
`0.572967°` — the scale in radians wearing a degree sign.

Applied to my brief: `_rest_basis.z` is not a unit vector, so a 0.12 m kick becomes **0.0012 m**. No error, no
wrong number in any log, and the weapon simply appears not to move. I sent the correction mid-flight and the
built code carries `_back_dir = _rest_basis.orthonormalized().z` at `weapon_recoil.gd:142`.

**Nothing else in the stack could have caught this.** The suite has no test for it, the value is a plausible
float, and both gdlint and gdformat pass either way.

### 1.2 A `files[]` append that would have made future edits impossible

Before appending a new probe path to an article's `files[]`, H20 delivered `anti_pattern e75bb3b3`:
`knowledge_append` on `files` **does not dedupe**, and a duplicate path makes every future `knowledge_edit`
targeting that path impossible, because the selector must match exactly once.

I had told a librarian to append without a membership check. I corrected it mid-dispatch to run
`knowledge_query file_keys:[...]` first. On the *next* new probe I ran that query myself before appending
(`matched_filter: 0`), so the correction propagated.

⚠ **This is a genuine API footgun, not just a lesson** — see Part B §8.

### 1.3 A superseding record that would have orphaned two live rulings

I superseded ruling 2 of a three-ruling decision and wrote a new record naming only that ruling. H20 delivered
`anti_pattern 1cc211b5`: superseding a multi-part decision silently orphans the parts it never mentions, and
*"the tell is in the old record's title: it is plural."* Mine was plural.

I added an explicit **WHAT SURVIVES** disposition. Writing it exposed a scope error I would otherwise have
shipped: **shields must not receive the procedural recoil.** Eleven is the count of families that FIRE but have
no authored motion — not the count of families lacking a clip. Shields lack a clip too and have no fire trigger.
My list of eleven was already correct; the disposition is what made it un-misreadable by whoever built it.

### 1.4 A third predicate in a family that had already diverged

Dispatching a new `fittable_keys`-adjacent method, H20 delivered `anti_pattern 2de272e4`: `is_fittable()` and
`fittable_keys()` already own the same domain name, read different fields, never call each other, and **six rows
once walked through that gap**. I changed the brief to require the new method be a *filter over*
`fittable_keys()`'s output rather than a re-derivation. That also made one of my own requirements free: "the twin
is itself fittable" became "the twin is in the array you just got".

### 1.5 `unproject_position` returns stretch-base coordinates

`anti_pattern 7e996bec` fired on a render-probe dispatch. This project stretches to a 3440×1440 basis, so
`unproject_position` returns basis coordinates, and a naive bounds check against the PNG size **refuses correct
plates**. My brief had specified exactly that naive check. Corrected mid-flight; the resulting probe printed both
raw and scaled coordinates and refused nothing wrongly.

### 1.6 H3 refused an edit because a `sed` view is not read-evidence

I read three lines of `trader_deck.gd` with `sed` and went straight to `Edit`. H3 refused:

> `H3 [direct mode]: no fresh read-evidence for 'game/run/trader_deck.gd' — Read the exact file before editing.`

**This was correct and I was wrong.** A `sed` window shows a fragment with no guarantee the file has not moved
under me — which is precisely how an edit lands on the wrong lines. One `Read` and the edit went through.

### 1.7 The dedup check on `knowledge_create` forced a real distinction

Creating an anti-pattern about plate legibility, the create was **refused**:

> `this anti_pattern overlaps existing '778dadfd' … (matched on title+trigger Dice similarity 0.31 >= 0.3)`

That refusal was right to fire. The two records are genuinely different — `778dadfd` is about a *host that failed
to assemble*, mine about a subject *too small and occluded to judge* — but being forced to say so made me write an
explicit three-way disposition covering a third sibling (`0d3ca823`, wrong *pose*). The result is three records
that each name which link of one chain they fail at, instead of a fourth vague one. **A dedup gate that produces a
better taxonomy rather than just blocking a write is a good gate.**

### 1.8 The agent-roster records saved a fan-out from a bad premise

`anti_pattern cab19595` (a path hook denies `coder` every write under `game/test/**`) and `6faa528e`
(`test-writer` holds `Write` but no `Edit`, so it rewrites files wholesale and re-types frozen cases by hand)
both fired before the relevant dispatches. The second produced the single best mechanical action of the session:
I `git add`-ed the test file **before** dispatching, so the 227-line rewrite could be diffed against the version I
had already reviewed rather than against HEAD. Result: three function-level changes, 28 cases before and after,
nothing renamed or dropped. Without that baseline the real change would have been buried in the noise of earlier
uncommitted work.

---

## 2. Friction / made things worse

### 2.1 H21 fired 10 times and was right approximately zero times

`H21 article-write watch: this is hand-run article write #N this session (decision dac3d2c6 — article application
is librarian-shaped).` It fired on writes #1 through #10.

Every single one was one of the three named exceptions: a small authored create (two decisions, two
anti-patterns, one feature article), a write needing live adjudication (fixing a decision forward after the user's
ruling superseded it mid-session), or a single small-record touch (a two-line pointer correction). **The hook has
no way to tell those apart from a bulk reconcile, so it degenerates into a counter.** By firing #7 I had stopped
reading it, which is the real cost — a warning nobody reads is worse than no warning, because it occupies the
channel a real one would use.

### 2.2 The post-answer audit arrives too late by construction, and it knows

H20's post-`AskUserQuestion` audit found `47a2854f`, which had **already ruled** that a shield is armour, on
2026-08-16. I had just asked the user to rule on it again. The audit says so itself:

> `THIS IS A POST-ANSWER AUDIT, NOT A GATE — it reaches you with the answer, never before the ask`

The user's answer happened to agree, so no contradiction was manufactured. But **I spent one of the user's
decisions on a settled question**, and the mechanism that could have prevented it fires after the form closes.
See Part B §12 — this is the clearest structurally-missing hook in the system.

### 2.3 The frontier signal fires on gitignored render output

H19 emitted `STERLING FRONTIER SIGNAL … territory 'tools/blender/out/fire_strip/…/frame_02.png' is UNOWNED` on
**every plate I opened** — five times that I counted. `tools/blender/out/` is gitignored at `.gitignore:74` and
holds 2,900+ PNGs by design; no article will ever own a plate. This is the same complaint as previous sessions,
still unfixed, and it is a two-line change: skip paths matching the ignore file.

### 2.4 Two dispatches wasted on tool lists I could have checked

- I dispatched an `explorer` to drain the maintenance queue. It holds no `maintenance_query`. It correctly
  refused, having tried five ToolSearch queries first, and cost a full round (~50K subagent tokens).
- I briefed a `test-writer` to run `gdlint` and `gdformat`. It holds no Bash. It correctly refused and flagged the
  conflict.

**Both were my errors and both were preventable** — the roster is in my system prompt. But note the shape: the
plugin ships `anti_pattern 55577e13` specifically about this, and it did *not* fire on either dispatch, because
the subject-axis matcher keyed on the prompt's content rather than on the mismatch between the requested work and
the named agent's tools. A dispatch-time tool-capability check is mechanical and absent.

---

## 3. Wrong information — including mine

### 3.1 My own brief shipped a wrong scope and two agents repeated it

**The most expensive error of the session was mine.** I briefed a rigid-twin substitution with:

> *"Derive the pairing from the DATA, not from a hardcoded list of three families. Match a skinned row to its
> rigid twin BY KEY, handling both spellings."*

"By key" was the whole defect. The kit ships **44** `_No_Skin`/`_NoSkin` rows — legs, chassis, whole walker
bodies, shields, backpacks — not 3 weapon families. The implementation dropped **28** rows including every skinned
leg with a twin. Skinned legs deform to walk; rigid ones cannot.

**Two agents then described the change as affecting "up to 3 rows"** — the implementer and its own follow-up —
because that is what my brief said. One bad premise multiplied by N, exactly the fan-out hazard the plugin's own
docs warn about. Captured as `anti_pattern derive-it-from-the-data-not-a-hardcoded-list-is-right-about`.

**What caught it:** a test written blind to the implementation, required to print its terms rather than a verdict.
The failure line read `base=354 subs=23 expect=331` against `fittable=326`, turning a bare mismatch into a
five-minute diagnosis. Fixed to gate on `fire_clips`; re-measured 354 → 339, exactly 15 dropped.

### 3.2 I reported a failing suite as passing

I ran the suite as `<godot> … ; echo "SUITE_EXIT=$?"`. The harness reported **exit code 0**. The real exit was
**100**, with one failure. The chain's status was the `echo`'s.

This project already carries a record about piping gates through `head`/`tail`/`grep` — I reproduced it in a
different costume, on the same day the original was recorded. I only caught it by reading the log body. **A
gate-invocation linter is the obvious mechanical fix** (Part B §12).

### 3.3 The maintenance queue was silent on three genuinely stale articles

I dispatched a librarian to record staleness in `mech-part-library`, `weapons` and `weapon-fire-animation` — all
three genuinely contradicted by this session's code. It reported:

> `No reconcile_needed item's text names mech-part-library, weapons, or weapon-fire-animation.`
> (`matched_filter: 100, returned: 100, capped: false` — the whole queue.)

**Had I relied on the drain to tell me what was stale, all three would have gone unrecorded.** The queue reports
debt the mechanism *detected*; it is not an inventory of debt that exists. That cuts against how the queue reads.

### 3.4 A cited board id did not exist

The rotation note instructed me to close board `776077e9`. It does not resolve — not by id, and not in two text
searches (`contains:"muzzle"` → 17 items, `contains:"flash"` → 12, neither containing it). Per `anti_pattern
5bf1cb1d` this is expected behaviour rather than lost work, but it means **a rotation note can carry a pointer
that is dead on arrival**, and the note is the one artifact designed to survive a clear.

---

## 4. Too much / too little information

**Deliveries were large.** H19/H20 blocks in this session ran roughly 2–6 KB each, with the largest spilled to a
file:

> `Output too large (11.9KB). Full output saved to: …hook-6a0a6828-…-additionalContext.txt`

That one was H19 pointers on a *Bash command*, listing four anti-patterns and two articles for
`mech_part_library.gd`. **I used one of the six.** A second spilled delivery ran 14.5 KB on a `Read` of
`trader_deck.gd` and I used none of it — I was editing a comment.

**Rough estimate for the session:** 25–30 hook deliveries at ~3 KB average ≈ 80–90 KB of injected context, of
which I acted on perhaps 10 deliveries. **That is a ~35% hit rate on the ones I read and much lower by volume** —
but see the verdict: the hits were catastrophic-defect-grade, so the ratio is acceptable. The problem is not the
volume, it is that volume is uniform regardless of relevance.

**Too little, in one place:** `knowledge_schema("feature_article")` returned
`{name: "current_ac", required: true, type: "{ac_id, text, verifiable_at}[]"}` — and **did not expose
`verifiable_at`'s enum values**, though the tool's own description advertises `enum_values` for closed enums. My
write was refused eight times over (once per AC). The schema tool is the documented cure for learning-by-rejection
and it failed at exactly that job for a nested field.

---

## 5. Hook-by-hook

| Hook | Fired | Verdict |
|---|---|---|
| **H1** | Once, session start | Restored the rotation note and consumed it correctly. The note itself carried one dead board id (§3.4). Also warned the queue was deep (55 drainable + 39 `file_parked`) — accurate. |
| **H3** | Once (refusal) | ✅ **Correct refusal.** Blocked an `Edit` after a `sed` view; `sed` is not read-evidence. Cheap, right, and it caught a genuine shortcut. |
| **H4** | Indirectly, via agent refusals | Worked as designed — `test-writer` stayed walled off from implementation, which is why its tests encode the spec and caught §3.1. |
| **H7** | Observed only via effects | A librarian reported its own writes triggering a re-sweep that re-bumped untouched items and raised a new one. Over-firing shape confirmed but low cost. |
| **H10** | ~8 times | Mixed. The **article-missing demands were valuable** — they produced a real `weapon-recoil` article and two probe registrations at the moment the knowledge was freshest. The **capture demands became a treadmill**: 4 of 8 were satisfied by `no_capture` because the window contained gate runs and verification, not learning. |
| **H14/H15** | Not observed directly | Agents reported the allowlist behaving; no denials surfaced to me this session. |
| **H19** | ~15 times | Best-in-class on `Edit`/`Write` of governed code. **Useless on gitignored plate reads** (§2.3) and near-useless on the two spilled `Read`/`Bash` deliveries (§4). |
| **H20** | ~10 times | **The single most valuable mechanism in the plugin this session.** Six of the eight catches in §1 came from it. Its one structural flaw is the post-answer audit timing (§2.2). |
| **H21** | 10 times | **Zero true positives.** A counter wearing a warning's clothes (§2.1). |
| **Watchdog ticks** | 3 | The mandatory enumeration (a–e) genuinely produced dispatches I would otherwise have skipped — twice it surfaced article staleness I had not considered. Worth keeping. |
| **Nothing** | — | **No mechanism checked that a gate command's exit code was unmasked** (§3.2). I reported a red suite as green. |
| **Nothing** | — | **No mechanism checked a dispatch's requested work against the named agent's tool list** (§2.4). Two wasted rounds. |
| **Nothing** | — | **No mechanism warned before an `AskUserQuestion` that the subject was already ruled** (§2.2). Cost a user decision. |
| **Nothing** | — | **No mechanism flagged that my brief's stated scope (3 families) diverged 14× from the population its rule would match (44 rows)** (§3.1). Nearly shipped legs that cannot walk. |

The four "Nothing" rows are the most valuable lines in this table. Three of the four are mechanically checkable.

---

## 6. What I did not exercise, and therefore cannot assess

- **Pipelines / gated runs** — the entire `run_state` / `run_signal` / phase machinery. This was conductor-direct
  throughout. Every agent reported `no active run`, and several noted their `handoff_write`/`agent_exit` calls
  correctly refused as a result.
- **`/sterling:cleanup`, `/sterling:init`, `/sterling:merge`, `/sterling:council`, the TUI dashboard,
  `/sterling:drain` as a skill** (I drained by hand through a librarian instead).
- **`knowledge_retire`, `knowledge_promote`, `knowledge_link`, `maintenance_enqueue`, `board_add`** — not called.
- **Cron / scheduled agents.**
- **Domain stores / cross-project sharing** — two sibling projects are registered; I read nothing from them.

I am not reviewing any of these from documentation.
