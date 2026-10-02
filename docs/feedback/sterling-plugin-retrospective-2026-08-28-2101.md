# Sterling plugin retrospective — session evidence
**2026-08-28, 21:01.** Project: dome-farmer (a Godot 4.6 game). Branch `chore/retire-knowledge-skills`, 11 commits ahead of main. One commit landed this session (`c8f6ea2`); a second was staged and gated but not taken before this was written.

Session shape: a long conductor-direct session that began with a weapon-aim defect, then became a live playtest in which the user found five defects by hand, then an asset-pack migration. Roughly 20 subagent dispatches, 2 Codex consults, 6 windowed Godot runs, 5 scoped test suites, 8 new store records.

The companion document `sterling-plugin-assessment-whole-system-2026-08-28-2101.md` carries the design review.

---

## 1. Where it genuinely helped — with receipts

Prioritised, as the skill asks, by cases where a mechanism caught an error **in my own work**.

### 1.1 H20 caught a wrong premise in my own brief, before it cost a Blender session

The user said *"All farm assets need to be changed out with the new ones also"*. I searched `Assets/`, found `Assets/Farm/polygon-farm-01/` (a Godot-native POLYGON Farm pack), and dispatched a coder at it with a full pipeline brief.

On that dispatch H20 delivered:

> ▸ DECISIONS for this path (1) … → Two rulings taken through the question form immediately after the **Toon Farm Pack + Toon Nature Assets** census (finding e3…) `[two-user-rulings-2026-08-12-on-the-toon-world-pack-destructi]`

That single line was the whole finding. The project was migrating to a **Toon** pack, not POLYGON. I stopped the lane mid-flight. It reported back: *"STOPPED. Nothing written, nothing deleted, nothing exported. Zero mutations."*

The lane then added a second, independent reason the brief was dead: `Assets/Farm/polygon-farm-01/` **ships no source FBX for any building** — only `.res` ArrayMeshes, `.tscn` prefabs and `.import` stubs naming absent files. `cut_building.py` runs in Blender and cannot read `.res`.

**Cost avoided:** a full asset-pipeline session against the wrong pack, in a project where a Blender campaign is measured in hours. Nothing else in the stack would have caught this — I had grepped the filesystem and found a plausible answer.

### 1.2 H20's post-answer audit caught a direct contradiction with a settled user ruling

I asked the user how dash readout rows should sit when there are fewer than the panel holds. They chose "fixed pitch, top-aligned". H20 then returned, *with the answer*:

> ▸ DECISIONS for this path (2) … ✗ ALREADY REJECTED: Fill the glass but keep rows axis-aligned; …

Reading the record (`57e37504`) showed clause (1) had ruled the opposite: rows *"scaled to **fill the glass** (was 43% on WEAPONS / 73% on INTEGRITY, top-anchored)"* — i.e. a previous user ruling had explicitly **replaced** a top-anchored layout.

I stopped the in-flight coder, quoted the clause to the user, and re-asked. They overrode it knowingly (the earlier ruling was made while the monitor was wrongly showing all 14 weapons — the premise had since been fixed). Recorded as decision `acd0ca69` with a `supersedes` link.

**Without this**, I would have shipped a silent reversal of a settled user ruling, and a later reader would have found two contradictory decisions with no way to adjudicate.

### 1.3 H24 blocked me from reading a red gate as green — twice

The rotation note for this session listed, among my own prior errors: *"I read a pipe's exit code and reported a failing gate as passing"*. H24 stopped me repeating it within the same session:

> H24: gate invocation masked — '…Godot… --check-only --script' is followed at top level by ';', which swallows the gate's real exit code.

and again on `… -a res://test/ui > file 2>&1 || true`. Both were mine, both deliberate (I wanted to capture output and continue), and both would have produced a misleading exit code. The second was during a **mutation test where I wanted the suite to fail** — H24 forced me to let the non-zero exit propagate honestly instead of swallowing it.

I had already, earlier in the same session, misread a `tail` exit code as Godot's and briefly believed a parse gate had passed when it exited 1. That one H24 could not catch (the mask was a pipe, which it allows). See §5.

### 1.4 A store record I wrote hours earlier saved three agent round-trips, three times

`anti_pattern 5fcab9e2` — *"`gdformat --check` FAILS AND BARE `gdformat` IS FORBIDDEN … run the formatter on a SCRATCHPAD COPY, diff it, and apply its answer as LF"* — was written this morning after two wasted rounds guessing at formatter output.

It was used three times today (`weapon_aim_publication_test.gd`, `garage_swap_safety_test.gd`, `cockpit_weapon_rows_test.gd`). Each time the diff was one or two hunks and the fix landed in a single call. Its recorded cost model was exactly right: *"the cost this avoids is AGENT ROUNDS, not keystrokes"* — a `test-writer` holds no Bash by role and cannot run the gate it is asked to satisfy.

### 1.5 H23 corrected my framing of the session's headline defect

I reported the aim defect to the user as *"55 degrees of angular error"*. H23 delivered:

> → HAZARD anti_pattern 'A LATERAL MUZZLE OFFSET CANNOT EXPLAIN A GUN THAT LOOKS MIS-AIMED — perspective projects parallel lines to a COMMON VANISHING POINT…' `13236af4`

Reading it established that under convergent aim from an off-centre mount, a non-zero angle between barrel axis and camera ray is **expected**, and `delta_px` (the barrel line's miss at the mark) is the honest instrument. I corrected myself to the user. The defect was real either way — the cannon missed by 414×484 px — but my *characterisation* was wrong and would have misdirected the fix.

### 1.6 H5 correctly refused an agent an edit that was mine to make

A debugger fixing the two-cockpit defect tried to add its pin to `game/test/ui/garage_swap_safety_test.gd` and was refused:

> "test paths are frozen for pipeline agents … A demonstrably buggy test is a conductor repair, recorded via node scripts/test-repair.mjs"

It staged the pin source in the scratchpad and reported the block. That is the right outcome — the agent could not silently weaken a frozen suite. (The *recording* half of that flow then failed me; see §2.3.)

### 1.7 The record types carried the session's findings without loss

Eight records written: 3 decisions, 1 anti_pattern, 1 research_finding, 5 feature_articles (4 by a delegate), 5 board items. Every one had a natural home. The `known_gaps` field on `feature_article` did the heaviest lifting — see the assessment document §6.

---

## 2. Friction, and where it made things worse

### 2.1 H26 dispatch-overlap advisory: ~6 firings, 100% false positive rate

Every dispatch after the first tripped it, always on the same three "files":

> H26 DISPATCH OVERLAP ADVISORY — this dispatch's brief names file(s) that overlap a LIVE in-flight dispatch's declared territory: 'game/ui/garage.gd', **'Users/chulf/AppData/Local/Programs/Godot/Godot_v4.6.3-stable_win64_console.exe'**, **'addons/gdUnit4/bin/GdUnitCmdTool.gd'**

The Godot executable and the gdUnit4 command tool are **tools every lane invokes**, not write territory. Because my briefs correctly spell out the gate commands verbatim (the project requires it — H14 matches literal command prefixes), every brief names them, so every pair of concurrent dispatches "overlaps".

The hook is honest about its own limits (*"the prompt extraction only approximates write territory"*), and it is warn-only. But a signal that fires on every dispatch with the same three entries is a signal I stopped reading by the third one — which is exactly when a *real* overlap would have been valuable. On one dispatch it did also name `game/ui/garage.gd`, a genuine overlap, and I nearly missed it in the noise.

**Concrete cost:** one near-miss. Two lanes were briefed into `game/mech/**` at overlapping times; the turn-clip lane noticed independently and told me: *"`git diff --name-only` shows another lane holds `game/mech/mech_slot_map.gd`, inside the territory I was given."* **The agent caught what the hook designed to catch it had buried in noise.**

### 2.2 H10's article demand does not know a file is owned by a live dispatch

H10 fired three separate times demanding a `feature_article` for `game/spike/turn_clip_reachability_probe.gd` while the lane authoring it was still running. Its own "deferred" line correctly listed the file as owned by a live dispatch — and then the "articles" line demanded it anyway, in the same message:

> • deferred: 1 file(s) owned by live dispatch(es) [a773cd38…]
> • articles: article demand — 1 touched file(s) no owner … game/spike/turn_clip_reachability_probe.gd

The two halves of one hook disagree with each other. I answered with `capture_pending` twice, which is the designed mechanism and worked, but the third firing came after the lane had completed and I had already dispatched the article — so the demand and the satisfaction crossed.

### 2.3 `test-repair.mjs` has no shape for "the conductor appends a new case"

H5 blocked an agent from a frozen test path and named `scripts/test-repair.mjs` as the sanctioned route. Reading that script:

> "The conductor stays sanctioned to hand-repair a **demonstrably buggy** frozen test … the repair must stop being invisible: it records a test_repair session event — the repaired test path + **the evidence for why the TEST, not the code, was wrong**"

I was not repairing a buggy test. I was **appending a new case** to a frozen file. The `--evidence` field would have required me to assert something false. I appended by hand (the conductor is exempt from H5 by construction) and deliberately recorded nothing — because the only available record was a false claim.

**Net effect: the visible-repair mechanism made the change LESS visible, not more.** The honest path was the unrecorded one.

### 2.4 The librarian cannot create records, so store authoring cannot be delegated to it

`librarian` holds `knowledge_update`, `knowledge_append`, `knowledge_edit`, `knowledge_schema` — but **not `knowledge_create`**. The project's own convention is that a librarian applies conductor-drafted store updates. With five articles owed at 51% context pressure and H10 telling me to *"delegate reads & mechanical work to subagents (P1)"*, the one agent type designed for store maintenance could not do it. I used `general-purpose` instead, which worked well but has full tool access — a strictly worse fit for a store-only task.

### 2.5 `capture_pending` has to be re-declared each Stop

The register *"survives one Stop"*, so a long wait on an in-flight lane means repeating a declaration that has not changed. I wrote three, the last two adding nothing. It is honest and cheap, but it is bookkeeping the hook could carry itself while the named dispatch is still live — the information is already in the register.

---

## 3. Wrong info — including my own

### 3.1 My brief asserted a design ruling that says something else entirely

I briefed a debugger that `game-design-doc.md:694` — *"**Turning.** Your body resists the swing and leans against it"* — was a hull-turn ruling, and used it to argue the mech's yaw should be rate-limited.

The lane opened the file and corrected me:

> "⚠ **Correction to the brief's premise: `game-design-doc.md:694` is NOT a hull-turn ruling.** I opened it — it is the third of four *forces on the pilot* (`:687-696`, beside footfalls and recoil), i.e. the seat spring, already built at `cockpit_rig.gd:987-988`."

This is precisely the failure `anti_pattern 89cf3000` describes (*designing from the ruling index instead of the spec paragraph it points at*) — and I had the index row in hand and did not open the file. The project's own CLAUDE.md warns about this in bold. I did it anyway.

### 3.2 My brief named the wrong tool for closing queue items

I told a librarian to close already-paid `reconcile_needed` items with `maintenance_remove` and **no** `knowledge_update`. It used `knowledge_update {"state":"active"} resolves:[...]` instead and reported that this is the designed mechanism for that lane. It was right; my brief was wrong. The remaining concern was real and separate (it closed 47 items without per-item verification and disclosed that), and I boarded it as `6ebd758e` — but the tool-choice half of my instruction was simply mistaken.

### 3.3 I sent an explorer at a wrong premise built from a single run

Run 1 of a probe refused `left`, `up` and `diagonal` on every weapon. I briefed an explorer that the pattern was **direction-linked** and asked it to find an asymmetric clamp or a sign flip. It ruled out every candidate with evidence and honestly reported it could not find the cause.

Run 2 refused `machine_gun left/up/diagonal` but `cannon right/down/roll_zero`. **The pattern follows position in the sequence, not crosshair direction.** My premise was an artifact of a single sample. The explorer's careful negative result was work spent on a question I had mis-stated.

### 3.4 Every line number in one of my briefs had drifted

The article-writing delegate reported:

> "line numbers … had drifted since the brief was written — actual verified lines are `_frame_yaw_delta_rad` set at `mech_controller.gd:3767` (not 3727), threshold `@export` at `:3033` (not 3007), threshold comparison at `:5319` (not 5197/5259), `resolve_turn_clip()` at `mech_part_library.gd:854` (not 846)… I recorded the current-HEAD numbers, not the brief's."

Five of five wrong, in a brief written maybe twenty minutes earlier, because the lane that reported them had continued editing. The agent did the right thing.

### 3.5 A store record's measured numbers did not reproduce

Decision `e3ddefe3` records Toon `TFP_Barn_01A` LOD0 as **450 face-connected parts, 58 closed (13%)**. A lane measuring it today got **390 components, 27 closed (7%)**. Same asset, same name. Nothing in the store flags that a recorded measurement no longer reproduces; I only learned because the lane happened to re-measure and say so.

### 3.6 A shipped decision claimed a fix that had not worked

`decision e006c505` recorded convergent weapon aim as delivered at commit `278b350`. Rendered plates measured the cannon's barrel line missing the crosshair by **414×484 px** and the running game showing residuals of **0.26–8.97°**. Four green suites and a purpose-built probe reporting **≤0.0051°** all vouched for it. The store faithfully recorded a conclusion that was false, because every instrument feeding it agreed.

### 3.7 A finding measured half the quantity that mattered

`finding 8911e3e3` measured the authored REST **elevation** of all 14 weapons. The actual cause of the aim defect was the authored rest **azimuth**, which nobody had ever measured — `machine_gun` at +10.32°, matching its observed +7.5–9.0° yaw error almost exactly. The record was accurate and insufficient, and nothing marked it as covering one axis of two.

---

## 4. Too much information / too little

**H23 output-axis delivery was the largest single consumer, and the least used.** It fired on most Bash results and most tool outputs, typically 3 pointers plus a tail:

> (+15 more matched) … (+21 more matched) … (+12 more matched) … (+16 more matched) … (+6 more matched)

Rough count across the session: **~25 H23 blocks**, each 3 named records plus a suppressed remainder — on the order of **60+ named pointers and several hundred suppressed matches**. I followed **four** (`13236af4`, `5fcab9e2`, `43e87ec4`, and the `5680e824` density conflict via a `same_subject` echo rather than H23 itself).

That is roughly a **6% follow rate**. The four that landed were genuinely valuable — §1.4 and §1.5 above are two of them — so the mechanism pays for itself. But the delivery is untargeted: it matches on generic tokens (`game`, `check`, `user`, `line`, `three`, `already`, `values`) and surfaces records whose only relation to the task is vocabulary. One block matched on *"pieces, user, subject, eight"*.

**H19 path-axis delivery was much better targeted** — it fires on paths actually named in a command, and its pointers were usually about the file in question. Its failure mode is volume rather than relevance: near the end of the session a single Bash call returned **ten** H19 pointers because the command touched ten changed files.

**Nothing was spilled to a file.** The largest single delivery block was roughly 40 lines.

**Where there was too little:** `board_query` results, `knowledge_get` with `field` windowing, and the `same_subject` echo on create were all appropriately sized. `knowledge_create`'s `same_subject` block was the single highest-value-per-token output of the session — five titles with `matched_on` arrays, and it caught two ruling conflicts.

---

## 5. Hook-by-hook

| Hook | Firings (approx) | Useful | Verdict |
|---|---|---|---|
| **H1** rotation restore | 1 | Yes | Worked exactly as designed. The note carried the next slice, three named traps and five pointers; the top trap (*"NO TEST REACHES ANY OF THE NEW AIM CODE… the suites are green and vouch for none of it"*) was the single most load-bearing sentence handed to this session, and it held. |
| **H5** frozen test paths | 2 | Yes | Correctly refused two agents. Its named remedy (`test-repair.mjs`) did not fit the case — §2.3. |
| **H10** capture / articles / context | ~8 | Mixed | Context-pressure reporting was accurate and well-calibrated (soft 35%, hard 50%, with tree-dirt count and the exact rotation-note command). The article demand ignoring its own live-dispatch deferral is a real defect — §2.2. |
| **H14** subagent command allowlist | 3 (in agents) | Yes | Caught agents reaching for `cat`, an absolute scratchpad path in `-s`, and `find`. One agent reported: *"H14 denies `cat`; all file reads went through Read/Grep."* Working as intended. |
| **H19** path-axis delivery | ~12 | Sometimes | Well-targeted; volume grows with the number of paths in a command. |
| **H20** mechanism-axis delivery | ~10 | **Yes — twice decisively** | The wrong-pack catch (§1.1) and the ruling-contradiction catch (§1.2) are the two highest-value mechanism firings of the session. Its post-answer timing is its weakness — see assessment §13. |
| **H23** output-axis delivery | ~25 | Rarely | ~6% follow rate. Four genuine saves; the rest was vocabulary matching. |
| **H24** gate exit lint | 2 | **Yes** | Blocked two exit-code masks that were mine. Prevented a repeat of a documented prior error. |
| **H26** dispatch overlap | ~6 | **No** | 100% false positive on tool paths; buried one real overlap that an agent caught instead — §2.1. |
| **H3 / H4 / H13 / H15 / H21 / H27** | 0 observed | — | Not exercised, or fired silently. I did not verify their absence; H27 is opt-in and I used no signature block. |
| **Nothing** | — | — | **No mechanism existed to catch that `tools/blender/build_mech.py` was missing and 21 scripts were dead at import.** Every declared gate was green for weeks. |
| **Nothing** | — | — | **No mechanism checked that I actually opened a rendered plate before ruling on it.** The project's strongest rule is enforced entirely by my own honesty. |
| **Nothing** | — | — | **No mechanism flagged that a decision's claim had been falsified.** `e006c505` said convergent aim shipped; it had not. The store had no way to know. |
| **Nothing** | — | — | **No mechanism warned that a question I was about to ask the user was already settled.** H20 tells you afterwards. Twice. |

---

## 6. Session facts, for calibration

- Commits: 1 landed (`c8f6ea2`), 1 gated and staged.
- Store records written: 3 decisions, 1 anti_pattern, 1 research_finding, 5 feature_articles, 5 board items, 1 article reconciled to v5.
- Subagent dispatches: ~20, across `coder`, `debugger`, `explorer`, `test-writer`, `librarian`, `reviewer-correctness`, `general-purpose`.
- Codex consults: 2. **Both found things the in-family reviewer did not** — the frame probe's untrustworthiness (predicted before the run that proved it) and the `set_loadout()` bypass in the two-cockpit guard.
- Windowed Godot runs: 6, all serialised by hand.
- Scoped suites at the gate: mech 250/250, ui 74/74, farm 31/31, world 3/3, run 461/461 — executed equal to authored in every case.
- Maintenance queue: 61 items enumerated, 47 closed as already-paid.
- User-facing questions: 6, all through the form. **Two of them contradicted settled rulings and had to be re-asked or re-affirmed.**

---

## 7. What I could not assess

Not exercised this session, and therefore not reviewed: the **gated pipeline** (runs, phases, `run_signal`, `run_state`, `run_escalate`), **`/sterling:cleanup`**, **`/sterling:init`**, **`/sterling:merge`**, the **council** deliberation pass, the **TUI dashboard**, **cron/watchdog** scheduling, **`knowledge_split`**, **`knowledge_promote`**, **`knowledge_retire`**, **`knowledge_supersede`** as a *call* (I used the `supersedes` link on create instead), **`handoff_read`/`handoff_write`**, and **domain-scoped stores** (everything I wrote was `scope: project`).

I also did not verify the absence of hooks I never saw fire. H3, H13, H15 and H21 may have fired silently or may not exist in this configuration; I did not read `hooks.json` to check, and the project's own CLAUDE.md forbids trusting a summary of it.
