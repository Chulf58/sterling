# Sterling plugin retrospective — session evidence
**2026-08-29, 08:48.** Project: dome-farmer (Godot 4.6 / GDScript game). Branch `chore/retire-knowledge-skills`, session ran from HEAD `58697c4` to HEAD `5ab7fed`. One commit, 33 paths staged, ~30 subagent dispatches, conductor-direct mode with a large fan-out.

This is Part A: what happened, with receipts. The design review is the companion file `sterling-plugin-assessment-whole-system-2026-08-29-0848.md`.

**What I did not exercise, and therefore do not review:** the gated pipeline / runs (`run_state`, `run_signal`, `run_escalate`), `/sterling:cleanup`, `/sterling:init`, `/sterling:merge`, `/sterling:council`, `/sterling:dashboard` (the TUI), `knowledge_promote`, `knowledge_split`, `knowledge_supersede`, `knowledge_retire`, `concept_designed`, `handoff_read`/`handoff_write` (agents reported these as run-scoped and unavailable outside a run). Everything below is about the surfaces I actually used.

---

## 1. Where it genuinely helped

I am listing the cases where a Sterling mechanism caught an error **in my own work** first, because those are the ones nothing else in the stack could have caught.

### 1.1 H4 (test-writer blind to implementation) — the strongest single mechanism in the plugin

The `test-writer` agent is blocked from reading implementation files. Over this session that constraint produced **six refusals, and every one was correct**:

1. Refused to write a pin without a callable entry point: *"I have the math but not a callable entry point: no method name/signature for the function performing this was given, and I could not find one via legitimate store search."*
2. Refused a second pin needing three implementation facts: *"guessing any one of them would produce a silently-vacuous fixture (zero shots fired, every arm 'passing' for nothing)."*
3. Refused again citing the project's own store: *"anti_pattern `73d60ad0`: an assumed signature does not fail red, it hard-errors gdUnit4's parse and blocks every suite in the project."*
4. Declined to pin "warns exactly once while the overflow persists", explaining in the file header that the latch dictionary's state cannot distinguish a once-only guard from one firing every frame.
5. Refused my proposed fixture-depth increase with a geometric counter-argument (below, §1.4).
6. Disclosed a field-name inference explicitly rather than silently assuming it — and that inference later turned out **correct** (`_locomotion_strafe_left_clip` / `_locomotion_strafe_right_clip` exist at `mech_controller.gd:3514-3515`), verified independently by another lane.

**The counterfactual matters here.** An unconstrained agent would have read the implementation and written assertions that matched it. That is precisely how a hollow test is born — it certifies whatever the code does. H4 is the reason this session shipped one honest gap instead of five green tests that pinned nothing.

### 1.2 The store's own anti-patterns caught defects in my briefs

- `70c2d423` (*"a blast radius is a DIFFERENCE BETWEEN TWO OUTCOMES, never the magnitude of the cause; a zero needs a FORCED-CHANGE CONTROL"*) was cited by name in four separate agent reports as the reason to distinguish "nothing to look at" from "meshes present, zero matched". One lane built its whole announcement design around it.
- `fb3d5e48` (*"copying a precedent whose safety comes from a property YOUR case does not have"*) was delivered by H20 into a light-parenting dispatch and the coder used it correctly: it argued `FrontalLight` is safe for the **opposite** property to `FloodLight`, same parent, and wrote that into the docstring. A reviewer later verified the argument and called it *"stronger than the author claimed"*.
- `73d60ad0` was what the test-writer cited to justify refusal #3.

These are cases where a record written in a previous session changed the outcome of this one. That is the knowledge base doing its job.

### 1.3 H20 mechanism-axis delivery blocked a question I should not have asked

I put a `max-file-lines` exemption question to the user. H20 **denied it before it reached them**:

> STERLING DENY-ONCE (H20, decision 68332e4b) — this question is DENIED before it reaches the user: its subject strongly matches a settled store ruling. […] TO OVERRIDE: resubmit this exact sub-question citing one of the ruling ids above AND stating the UNRESOLVED DELTA.

The override path worked exactly as documented — I cited `1eff1b60` and named the delta (the cited ruling records *existing* exemptions but not *who may grant a new one*), and the resubmitted question went through. **This is good design: it is a speed bump with a documented bypass, not a wall.** It also correctly identified that part of my question was already settled.

### 1.4 The agent roster's constraints produced better answers than an unconstrained agent would have

Four lanes overruled me, and all four were right:

| Lane | What I said | What it said | Who was right |
|---|---|---|---|
| coder (`weapon_aim.gd`) | "apply `.orthonormalized()` at `:786`" | Refused with a worked counterexample: `parent=diag(1,1,2)`, `rest=I`, `muzzle_local=(1,0,-1)` → current code yields exactly `(1,0,0)`, the "fix" yields `(1.3416, 0, 0.8944)`, **33.7° off** | The lane |
| coder (CI gates) | "remove the two `continue-on-error` flags" | Refused: they are deliberate per decision `7400acfe`, with a stated removal trigger ("the day the count reaches zero"), and measured a 5-file sample showing **17 gdlint problems, exit 1** — trigger not met | The lane |
| coder (`swarm.gd`) | "compact the carcass slots" | Refused: compaction is unsafe until board `201c67cd`'s raw-index holders are fixed, and the item is half-retired anyway | The lane |
| test-writer (weapon fixture) | "increase target depth to 20–30 m" | Refused: *"if `resolve_aim_point` returned the target, the muzzle line would TERMINATE on it and 0.05 m would still hit — it did not"*; more depth makes the arm **less** discriminating | The lane |

I would have shipped a 33.7° regression, a red-on-arrival CI, an index-invalidating compaction, and a weaker test. **The plugin's contribution here is the roster design and the review-receipt requirement that forces an independent pass** — not any single hook.

### 1.5 Codex as an outside-family reviewer earned its seat a third time

Codex and the roster `reviewer-correctness` **independently found the same defect** in `building_chunks.gd:818`: a latch checked before the branch, so a benign empty-load would silence every genuine name-mismatch for the rest of a run. Two model families converging on one line is the closest thing to proof available without running the game.

They then **contradicted each other** on the mech beam — roster said clause 2 satisfied, Codex rated it HIGH defect. A debugger lane settled it: both partly right. The body genuinely carries no pitch (roster correct), but the published crosshair is the camera axis **plus a screen-space spring offset** (`cockpit_crosshair.gd:268`), so the beam follows the camera, not the crosshair (Codex correct). Bounded at 1.34° drift + 4° hull attitude against a 55° cone.

**The disagreement was the finding.** A single-family review would have returned "satisfied" and closed it.

### 1.6 H3 contract gate stopped a blind edit

I attempted to edit `CLAUDE.md` without having read it:

> H3 [direct mode]: no fresh read-evidence for 'CLAUDE.md' — Read the exact file before editing. Checked […] conductor-reads.json (0 entries) […] Evidence EXPIRES WHEN THE FILE CHANGES (read-time content hash vs current bytes) and on context compaction.

Correct block, clear message, and the hash-based expiry is the right semantics. Cost me one `Read` of 12 lines.

### 1.7 H24 gate-exit lint caught a masked exit code

My first export command ended `…; echo "EXPORT_STEP1_EXIT=$?"`. H24 denied it:

> H24: gate invocation masked — […] is followed at top level by ';', which swallows the gate's real exit code.

I had written exactly the bug the hook exists to prevent. One-line fix.

---

## 2. Friction / made things worse

### 2.1 H26 dispatch-overlap advisory — high volume, low precision

H26 fired on **at least 9 dispatches**, and I judged every one a false positive. Representative:

> H26 DISPATCH OVERLAP ADVISORY — this dispatch's brief names file(s) that overlap a LIVE in-flight dispatch's declared territory: 'docs/design-ruling-index.md', 'game/main.gd'.

The overlaps it named were **files I explicitly listed in ⛔ FORBIDDEN blocks** — i.e. the brief mentioned them precisely to keep the lane off them. The hook's own text concedes the mechanism: *"the prompt extraction only approximates write territory"*. It also fired for read-only lanes (explorer, reviewer, librarian) that cannot write anything.

**Cost:** low per firing, but it trained me to skip the block. A warning I learn to ignore is worse than no warning, because it occupies the slot where a real one would go.

### 2.2 H20 mechanism-axis delivery fired on weak subject matches

H20 fired on most dispatches. Several matches were genuinely useful (§1.2). Others were not:

- On a dispatch about aim geometry: *"matched on: godot, point, real, need, four, gaps, line, defect"* → delivered a decision about **coop netcode**.
- On a dispatch about a farm build placer: *"matched on: field, farm"* → delivered a decision about **worker positioning**, plus a research finding about *"what makes field work READ as work"*.
- On the retrospective-adjacent capture lane: *"matched on: shot, radius, weapon, damage"* → delivered `pellet-damage-probe` (a shotgun draw-time probe), unrelated.
- On a dispatch about a light cycle: *"matched on: project, rather, ruling, never, cycle, mech"* → delivered two decisions about **worker repair release** and **workers as visible entities**.

The match terms it prints (`rather`, `never`, `need`, `four`, `real`) are stopword-grade. When the delivery quotes its own match basis as those words, the pointer is noise.

**This is fixable cheaply:** suppress delivery when the match set is dominated by high-frequency terms, or print a confidence and let the reader skip below a threshold.

### 2.3 `board_query contains:` does not match the `objective` field

This cost two lanes real work. From one lane's report:

> **True count: both objectives are complete at 7 items, not the 4 the `contains` filter returned.** `board_query contains:` matches item TEXT only, never the `objective` field — I had to page all 306 board items (3 pages) to find them.

A second lane independently hit it and worked around it the same way. Neither the tool description nor any project note warns of this. The tool has `file_keys` as a structured filter but no `objective` filter, despite `objective` being the field the board is organised around and the field `board_add` requires.

### 2.4 Board paging appears lossy at the head of the ordering

One lane reported, and I could not explain it:

> `a250fc04` carries `objective: "THE UI PASS"` and `updated_at 2026-08-29T00:09:23` — *newer* than `d4172c4a` (00:04:16), which appeared at position 5 of page 1. Under the documented `updated_at DESC` order it should have been near the top of page 1. **It was in neither page, and the pages returned 200 + 106 = 306 against `matched_filter: 306`.**

A later lane ran a `cap:20, offset:0` head-check and found nothing missing, so it is not reproducible on demand. ⚠ **I am reporting this as an unexplained observation, not a confirmed defect** — I did not spend calls establishing the mechanism, and the counts reconciled. But a paging contract that returns the documented total while omitting a very recent item is a serious class of bug if real, because the omission is invisible.

### 2.5 `librarian` has no `knowledge_create`

The `librarian` agent's tool list includes `knowledge_update`, `knowledge_append`, `knowledge_edit` — but **not `knowledge_create`**. It reported this itself:

> Note: no `knowledge_create` tool exists in my toolset (consistent with the clerk scope forbidding creation), so item 1's "capture as decision record" was fulfilled by correcting the existing decision `1ab2dc9c` in place […] flagging this since the work order phrasing implied a new record.

And on a later dispatch:

> All four items created as new board items (source:user), since I hold no `knowledge_create` and none of these are verbatim drafts to an existing article.

**The consequence is a routing distortion.** The project's contract says the conductor drafts knowledge content and a librarian applies it verbatim. But a librarian cannot create anything, so every *new* record must go to a `general-purpose` agent with the full tool surface — an agent with no clerk discipline, which then authors content rather than applying it. I dispatched three such lanes this session. The constraint that was supposed to protect knowledge quality routes around itself.

### 2.6 `research_finding` cannot hold an open question

I needed to durably record a question with two live hypotheses and no answer. The capture lane reported:

> The schema makes `research_finding` require `question` + `answer`. There is no answer — two hypotheses are live and `R` is unmeasured. Writing one would force an invented answer field.

It correctly used a board `todo` instead. But the board is near-term work and the store is the durable surface; an open, evidenced, unanswered question has no home in the knowledge types. This is the single clearest type-system gap I hit.

### 2.7 Codex has no store access

Codex returned, twice:

> Sterling knowledge records were unavailable. / no Sterling connector was available.

Codex is the project's designated outside-family second reviewer. It reviews diffs **without being able to read the decisions those diffs implement**, so every ruling has to be pasted into its prompt by hand. I did that — my Codex briefs ran 400–600 words largely because of it. It worked, but the same rulings were re-transcribed three times.

---

## 3. Wrong info, or none

### 3.1 Records I wrote this session that were wrong

**I created board item `a250fc04` and had it struck about an hour later.** I boarded a "possibly stale FINAL DEFENSE banner" at `farm_hud.gd:1108` on a lane's report that it *"could not establish who clears that label"*. A later lane found `farm_hud.gd:1019` `_on_phase_changed()` clears it unconditionally on every phase transition, with a comment stating the contract. My item's premise was false on the day it was written.

**A brief of mine was wrong and a lane had to correct it mid-flight.** I told the test-writer that calling `_try_cycle_lights()` directly avoids the key read. The key read is *inside* that method, above the increment, behind a phase gate (`_input_enabled()` requires `_phase == BREACH`). The pin could never have reached the increment. An article lane found this by source read; the test-writer then dropped the arm and recorded the gap.

**I proposed a fixture-depth increase that would have made a test weaker**, and was argued out of it (§1.4).

### 3.2 An article was stale within hours of being written

Article `042101ba` was authored this session, before the suite ran. By the end of the same session it asserted *"BOTH INSTRUMENTS ARE UNEXECUTED"* and listed AC2 (a discriminator arm) as live coverage — after that arm had been deleted while red. A librarian corrected it to v2, carefully preserving the distinction that the **logic pin has now run** while the **plate probe still has not**.

**Nothing detected this.** The article's `files[]` included the very test file whose arms were deleted. A file-hash reconcile would have caught it; instead a human noticed.

### 3.3 A store article carried a falsified claim

`feature_article 7de2bc96` (`turn-clip-reachability-probe`), `known_gaps[3]`, stated *"Strafe remains unreachable on F3/F4/F5"*. A lane measured it false at HEAD: strafe resolves at `mech_controller.gd:5594`, `_resolve_strafe_clip()` at `:5376`, intents at `mech_part_library.gd:171,176`, A/D inputs at `:181-182`. Corrected via `knowledge_edit`.

Note the shape: the article's `known_gaps` — the field specifically for recording what is *not* covered — is where the false claim lived. Gaps rot faster than descriptions, because nobody re-checks a claim of absence.

### 3.4 Eleven board items claimed work that was already built

This was the session's dominant finding. Items claiming outstanding work that was in fact committed:

`ce016621` (turn clips unreachable — fixed at `32b59ae`/`23e1288`), `58995cfb` (convergent aim doesn't point at crosshair — fixed at `c8f6ea2`), `d4172c4a` (run-end ledger unbuilt — built at `breach_ledger.gd:199,258-328`), `d8b26e5b` (FUN FOCUS tier 2 — landed at `4f301c5`), `77d8bee8` (sensor-scaled warning — built at `breach_warning.gd:48`), `e3df8e0a` gaps 2 and 3 (garage ruling unenforced — enforced at `mech_part_seater.gd:1553-1568`, pin exists), `5108eab7` framing half (fixed at `c8f6ea2`), `5d2750dd` (audio seam probe missing — exists, 681 lines), `c1729303` (both halves done), `7f0e016d` (trader deck untested — `trader_deck_consume_test.gd:77` covers all four functions), `0537d0ce` partially (one of four files already fixed).

Each cost an Opus lane to discover. **Two lanes then swept the board specifically to stop paying that toll.**

⚠ **The direction matters:** these were stale by claiming work was OUTSTANDING, not by claiming a defect was live. That direction is invisible — nobody goes looking for what they were told is missing.

### 3.5 The board's own staleness annotation exists and did not prevent this

`board_query` printed `⚠ N commits since measured` on many items. It is genuinely useful. But it flags *file movement*, not *claim falsification* — an item can sit at "⚠2 commits since measured" while its entire premise has been dead for a week, and an item with zero commits since measured can still be wrong (as `a250fc04` was, at zero).

---

## 4. Too much / too little information

Rough token accounting for delivery mechanisms, from what I observed:

| Delivery | Volume seen | Fraction I used |
|---|---|---|
| H20 mechanism-axis | ~15 firings, ~150–400 tokens each (~3–4k total) | ~3 of 15 changed a brief. **~20%** |
| H19 path-axis | ~6 firings, one **spilled to a file at 21.1 KB** | The spilled one: I read the 2 KB preview only |
| H23 output-axis | ~6 firings, 3–5 pointers each | ~1 of 6 acted on (the `fa874551` held-back-vs-failed record, which shaped a debugger brief) |
| H26 overlap | ~9 firings, ~120 tokens each | **0%** |
| H10 | ~8 firings | **~100%** — every one changed behaviour |

**The 21.1 KB spill is the notable one:**

> `<persisted-output>` Output too large (21.1KB). Full output saved to: […] Preview (first 2KB)

That was H19 + H23 firing together on a single `Bash` command. The preview showed pointers to `playtest-response-instruments`, three anti-patterns about vendor packs and winding, and `(+7 more matched)`. **I acted on none of it** — the command was reading an export log, and the delivered records were about Blender asset conversion. A 21 KB delivery with a 0% action rate is the clearest over-delivery signal in the session.

**Under-delivery:** the reverse never happened to me. I was not left short of context by the store; I was left short by my own briefs, which is a different problem.

---

## 5. Hook-by-hook

| Hook | Fired | Verdict |
|---|---|---|
| **H1** (rotation restore) | Once, at session start | ✅ **Excellent.** Restored the note, consumed it single-shot, disclosed `source=clear`, `head_sha`, `commits_ahead: 14`. The note's warnings (the missing review trailer on `58697c4`; the parked items) were all live and all used. Also flagged the Sterling clone 35 commits behind and the sibling-project registry. |
| **H3** (contract gate) | Once (blocked) | ✅ Correct block on a blind `CLAUDE.md` edit. Hash-based expiry is the right semantics. |
| **H4** (test-writer blind) | Continuously | ✅✅ **The best mechanism in the plugin.** Six refusals, six correct. See §1.1. |
| **H5** (frozen test paths) | Reported by ~6 coder lanes | ✅ Worked as designed. Every coder correctly reported "a pin is owed, H5 denies me" rather than attempting it. |
| **H10** (context/capture) | ~8 | ✅ **Highest signal-to-noise of any hook.** Correctly deferred duties while dispatches were live (*"duty re-arms when they land […] not a stuck nag"*), tracked fill 35% → 56.2%, and drove the commit boundary. The capture duty forced three records that would otherwise have died in the rotation note. |
| **H14** (agent bash allowlist) | Reported by lanes | ⚠️ Mixed. Correct in principle. But a debugger reported: *"H14 denies `git log`/`git diff --name-only` with ANY argument, so I could only bound it by file mtime"* — that materially weakened a diagnosis. And a coder reported auto-mode telling it to use Bash while *"H14 denies `cat`/`sed`/writes"*, forcing a tool switch. |
| **H19** (path-axis) | ~6 | ⚠️ Useful pointers, but one 21 KB spill with 0% action rate. Correctly labels itself a pointer, never a ruling. |
| **H20** (mechanism-axis + deny-once) | ~15 + 1 deny | ✅ for the deny-once (§1.3) and ~3 genuinely useful deliveries. ❌ for stopword-grade matching (§2.2). |
| **H23** (output-axis) | ~6 | ⚠️ One useful (`fa874551`). The rest matched on generic terms and delivered asset-pipeline records into weapon/UI work. |
| **H24** (gate exit lint) | Once (blocked) | ✅ Caught a real masked exit code in my own command. |
| **H25** (test-authoring advisory) | 2 | ⚠️ Both false positives — fired on an `explorer` and a `coder` brief whose text *mentioned* tests while explicitly forbidding test writes. Warn-only, so harmless. |
| **H26** (dispatch overlap) | ~9 | ❌ **All false positives.** See §2.1. |
| **H15, H21, H27, watchdog/cron** | Not observed | Cannot assess. H27 is documented as opt-in and I used no `STERLING-SIGNATURES` block. |
| **`commit-reviewed.mjs`** | Once | ✅ Committed and stamped 6 trailers. Its multi-spend warning correctly named cause (2): *"AN EARLIER code-touching commit made with bare 'git commit'"* — which is exactly true of `58697c4`. Good diagnostic. |

### The "Nothing" rows — real failures no mechanism existed to catch

These are the most valuable lines in this document.

| Failure | What would have caught it | What actually caught it |
|---|---|---|
| **11 board items claiming built work as outstanding** | Nothing. `⚠ N commits since measured` flags file movement, not claim falsification. | Two Opus lanes dispatched specifically to falsify the board — after nine had already been found one at a time. |
| **Article `042101ba` stale within 3 hours of creation** | Nothing. Its `files[]` listed the exact test file whose arms were deleted. | A capture lane happened to read it while looking for a home for a different record. |
| **My brief's false premise** (key read is inside the method) | Nothing. No mechanism validates a conductor's stated implementation facts against source. | An article lane reading the implementation for an unrelated reason. |
| **The dash pin's hollow `is_empty()` assertions** | Nothing — and critically, **the suite could not have caught it**: the file was red for an unrelated cast defect, so a green would have looked like a pass. | A repair lane reading the source. Now captured as anti_pattern `327b6985`. |
| **A probe measuring a door instead of debris for weeks** | Nothing. Its in-frame check passed the entire time. | A lane comparing the probe's private marker constant against the GLB bytes. |
| **A probe writing an empty baseline and exiting 0** | Nothing. It poisoned every later comparison run. | A lane sent to fix a different defect in the same file. |
| **My own board item `a250fc04` with a false premise** | Nothing — `board_add` performs no verification of a claim against HEAD. | A lane re-verifying an adjacent item. |
| **6 review receipts spent on 1 commit** | The multi-spend warning fired *after* the commit, advisory only. | Nothing prevented it; the warning documented it. |

---

## 6. What the session cost, in one line

Roughly 30 dispatches, ~3.5M subagent tokens, one commit, 527/527 scoped tests green. **Of the 30, at least 8 were spent discovering that boarded work was already done.** That is the single largest waste in the session, and it is a plugin-surface problem, not a project one.
