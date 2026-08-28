# Sterling plugin retrospective — session evidence

**Date:** 2026-08-28, written 07:07
**Project:** dome-farmer (Godot 4.6.3 game, Sterling consumed not developed)
**Branch:** `chore/retire-knowledge-skills`, 5 commits ahead of main
**Session commits:** `c6d5012` (the slice), `f988972` (a user ruling on CLAUDE.md)
**Mode:** conductor-direct, no active run. ~20 subagent dispatches, 1 Codex consult.

Companion document: `sterling-plugin-assessment-whole-system-2026-08-28-0707.md` (the design review).
This file is the evidence base only.

---

## 1. Where it genuinely helped

Ordered by how much damage each prevented. The first three caught errors **in my own work**, which is
the strongest evidence available that the design is sound.

### 1.1 H24 (gate-invocation exit lint) — 2 firings, 2 true positives, zero false

I twice wrote a gate followed by `; echo $?`:

```
cd "C:/Users/chulf/Dome Farmer" && ... && gdlint game/test/ui/garage_base_swap_test.gd; echo "lint exit=$?"
```

H24 denied it both times with:

> H24: gate invocation masked — 'gdlint' is followed at top level by ';', which swallows the gate's real
> exit code. Never append ';' or '||' after a gate — a red suite must never read green.

**This is the best hook in the plugin.** It is deterministic, it has a precise trigger, it cites its
decision (`6cdd1b02`), and both firings were real. Had it not fired, I would have read a masked exit code
as a pass on the very gates protecting a commit. Note the hook understood `&&` and pipes are safe and did
not object to them — the rule is narrow enough to be correct.

### 1.2 H25 (dispatch capability advisory) — ~5 firings, 4 true positives

It caught that I briefed the `explorer` agent to use `board_get`, which is **not in its grant**:

> H25 DISPATCH CAPABILITY ADVISORY — you are about to dispatch 'explorer', and the brief mentions tool(s)
> its installed grant does not hold: - 'board_get' — not held by this agent's grant

This was correct and I had made the same mistake in **three separate briefs**. I sent mid-flight
`SendMessage` corrections to all three telling them to use `board_query ... contains:` instead. It also
correctly flagged that I had briefed an `explorer` with test-authoring verbs.

It is warn-only, which is right — a mention is not proof of a requirement.

**Where it did NOT save me:** I separately briefed a `test-writer` to run `gdlint`, `gdformat --check`,
`--check-only` and the suite. `test-writer` holds **no Bash**. H25 did not flag it (the brief named
commands, not tool names), and the agent came back with *"no Bash tool held (test-writer role), so gates
were not run — conductor must run them"*. There is a store anti-pattern for exactly this (`fa61dc5b`) and
I still made the mistake. See §5.

### 1.3 H10 article demand — 4 unowned files caught, one at a genuinely dangerous moment

H10 flagged `tools/blender/mech_port/clip_census.py` as having no owning article **at the exact moment a
user ruling changed its counting unit**. That is the shape most likely to rot: a governing producer, a
fresh ruling attached to it, and no record owning either. I created the `clip-census` article in response.

Also caught: `game/spike/wall_band_gradient_probe.gd`, `game/test/run/worker_clips_test.gd`,
`game/test/run/run_mode_peacetime_rim_test.gd`.

### 1.4 The `capped` disclosure on `board_query` / `maintenance_query`

```json
{"matched_filter":299,"returned":60,"cap":60,"capped":true,
 "note":"cap reached — showing 60 of 299 matching items (offset 0); page with offset:60 ...
         a drain that stops at the cap leaves the tail behind"}
```

This single field is why I paged instead of concluding. A capped window that did not say so would have let
me assert a board total of 60. The deterministic `updated_at DESC` ordering guarantee in the same doc
string is what made paging trustworthy.

### 1.5 `board_remove`'s refusal of an abbreviated id

```
board_remove: no record 'd46b805d' — and this tool addresses items by their EXACT full uuid only ...
Board rows are HARD-DELETED, so an abbreviation that once named a now-removed item can silently retarget
to a different, live item and destroy it irreversibly
```

A refusal that **explains the blast radius** rather than just rejecting. I resolved the full uuid and
proceeded. This is the best error message in the tool surface.

### 1.6 The review-receipt ledger

`commit-reviewed.mjs` stamped two `Reviewed-By-Agent: reviewer-correctness` trailers, verified after an
`--amend`:

```
git log -1 --format='%(trailers:key=Reviewed-By-Agent,valueonly,unfold)'
reviewer-correctness
reviewer-correctness
```

The mechanism worked end to end. CLAUDE.md's warning that `--amend -F` can destroy the trailer block was
accurate and I followed it deliberately.

### 1.7 H23 (output-axis delivery) surfacing a directly-relevant hazard

When I was about to edit `ROADMAP.md`, H23 surfaced anti-pattern
`a-tracking-row-that-prescribes-the-next-fix-keeps-reading-as-open-work`. That is precisely what I was
fixing — roadmap rows describing work already shipped. Path-scoped delivery could not have found it from
the files I had touched.

---

## 2. Friction / made things worse

### 2.1 `agent_exit` / `handoff_write` refuse in conductor-direct mode — ~12 wasted calls

**Every single subagent** reported some version of:

> NO ACTIVE RUN — `handoff_write`/`agent_exit` would refuse with "no active run" ... this message is the
> deliverable per that refusal.

Conductor-direct is the **primary mode** in this project by a user decision from 2026-08-09. The agent
roster's exit protocol assumes a pipeline run exists. So roughly a dozen agents each burned a tool call
discovering a fact the roster could have told them, and several spent report tokens explaining the
refusal to me. This is the single highest-frequency friction in the session.

### 2.2 H26 (dispatch overlap advisory) — ~6 firings, approximately 0 true positives

Every firing was on a `librarian` or `explorer` dispatch whose brief **cited** paths as evidence but which
structurally cannot write files. Examples of what it flagged as overlapping territory:

> 'game/main.gd', 'game/spike/mech_assembled_plate_probe.gd', 'game/test/mech/mech_part_library_test.gd'
> ... Overlapping live dispatch(es): coder:a6b06c0bf8f704efe

and, most clearly wrong:

> this dispatch's brief names file(s) that overlap ... 'addons/gdUnit4/bin/GdUnitCmdTool.gd',
> 'Users/chulf/AppData/Local/Programs/Godot/Godot_v4.6.3-stable_win64_console.exe'

It flagged the **Godot binary path and the gdUnit4 CLI tool** as contended territory, because every brief
quotes the gate commands. The hook itself discloses that "the prompt extraction only approximates write
territory", which is honest, but the precision is low enough that I stopped reading it — which is the
real cost, because a true positive would now be missed.

### 2.3 Delivery payload size

Three deliveries were large enough to be spilled to files by the harness:

- `hook-toolu_018zFyxwHBrstu2HNYZq8rp7-6-additionalContext.txt` — **10.5KB**
- `hook-4fa2819c-...-3-additionalContext.txt` — **37.3KB**
- `hook-4ccd09e2-...-3-additionalContext.txt` — **13.9KB**

Plus many inline H19/H20/H23 blocks of 2–6KB each. My rough estimate is **60–90KB of hook-delivered
context across the session**, of which perhaps 10% changed a decision. The "PRIOR ANSWERS in the store"
sections in particular fired on nearly every dispatch and I acted on approximately one of them.

### 2.4 H24's correct rule has an awkward workaround

Because I could not write `<suite>; echo $?`, capturing a suite's exit code plus filtered output required
`run_in_background` and a second call to read the file. That is the right trade, but a first-class
"run this gate and give me exit + summary" affordance would remove it.

---

## 3. Wrong info, or none

### 3.1 The board's single highest-priority planning item was ~10 claims of which most were false

Board `67cbdf96`, priority **high**, titled *"THE VERIFIED FAN-OUT PLAN FOR THE NEXT LARGE SESSION — USE
THIS INSTEAD OF RE-AUDITING"*, written 2026-08-23. Measured against HEAD `9e14c0a` this session:

| Claim | Reality |
|---|---|
| LANE A: "the mech does not track ground height AT ALL" | False — `mech_controller.gd:4331`, eye is hull-relative |
| LANE A: "Veskari and workers run at y=0" | False — `swarm.gd:2290-2291` writes per-agent ground Y |
| LANE A: "player-placed buildings past 320 m would float" | False — `build_placer.gd:737` averages 5 `height_at()` samples |
| LANE A: "the two wall bands span the old flat line" | False — `world_visuals.gd:384` samples per chunk |
| LANE C: "`dome_theme.gd` styles Panel/Button/Label ONLY" | False — `dome_theme.gd:195-241` styles LineEdit |
| LANE E: "NO SUITE LOADS `FrontEnd`, `RunConfig`..." | False — three suites exist |
| LANE D: save header `day` hardcoded 0 | False — `_elapsed_days` wired at `main.gd:897/3606-3653/2836/3164` |
| LANE F: `save-slot` title stale | False — already fixed |
| LANE F: `weapons` article half-stale | False — covers 14/14 |
| LANE F: `mill-works` AC3 missing Fate | False — it mentions it |

The item explicitly said *"USE THIS INSTEAD OF RE-AUDITING"*. I dispatched three builder lanes at LANE A
work; all three correctly built nothing and reported the claims false. **The item's own confidence is what
made it dangerous.**

### 3.2 Other stale board numbers

- `d46b805d`: *"THE MAINTENANCE QUEUE STANDS AT ROUGHLY 96 OPEN ITEMS"* — live queue was **15**.
- `0698b431`: cited *"191/206 open items"* — measured **294**.
- `c683c496`: cited `router.gd:512-528` — the actual branches are at **581-582 and 676-678**.
- `ROADMAP.md` M1.5 item 6 read as unbuilt; `building_chunks.gd:13/52/166/215` shows HP-driven toppling
  is built.
- `d514aded` (FARMING BIG PASS) claimed orchards/greenhouse "UNBUILT/DEFERRED";
  `field_plots.gd:158` declares `enum PlotType {FIELD, ORCHARD, BUSH, GREENHOUSE}`.

**Eleven falsified claims of absence in one session.** Every one had the same shape: a confident,
well-evidenced-looking assertion that something was missing.

### 3.3 Records and briefs *I* got wrong — the honest counterweight

1. **I asserted an arithmetic double-count that did not exist.** I briefed a lane that
   `_vendor_clip_coverage.py:81` would "double-count all five" newly-counted clips. The lane measured it
   and reported: *"The 'double count' is NOT an arithmetic double count — `_vendor_clip_coverage.py`
   produces no clip total to inflate."* It then found a **worse** real defect I had not seen (an acquittal
   branch that would pass a genuinely LOST clip as OK).
2. **I overrode a board item and weakened a test.** Board `80d122f4` specified a *"stub recording
   `set_peacetime_rim` args"*. My brief substituted a real `DomeSky`, reasoning a real object beats a fake.
   That made the pin blind to a `set_peacetime_rim(false)` regression during PEACETIME. Codex caught it;
   the board had been right.
3. **I briefed three `explorer` agents with `board_get`**, which they do not hold (see §1.2).
4. **I briefed a `test-writer` to run gates** it has no Bash for.
5. **I claimed the working tree had lost its CRLF line endings** based on a `grep -c $'\r'` that omitted
   `-a`. Re-measured with `-ac`: `garage_base_swap_test.gd` has 740 CR in HEAD and 740 in the working copy.
   No conversion had happened. I corrected this within two calls.
6. **I briefed a librarian on a premise that did not match the item.** It refused: *"`9ab596aa` — not
   touched... Its current text is about gdlint `max-public-methods` cap on `worker_crew.gd`, not a silent
   garage refusal, so the brief's assumption does not match."* Correct refusal.
7. **I used PowerShell here-string syntax (`@'...'@`) in the Bash tool**, mangling a commit message and
   creating two junk files named `284,` and `285` where `->` was read as a shell redirect.

### 3.4 A lane read a file mid-edit and reported a defect that does not exist

A board-triage `explorer` reported: *"`router.gd:693-706` does have a `push_error` on the goal_cell
rejection branch in the CURRENT code"*. It did not. The lane had read `router.gd` while a `coder` lane was
writing to it. I caught it only because I checked `git show HEAD:game/sim/router.gd` — and that check also
revealed a **second** silent branch nobody had found. There is an existing anti-pattern for this
(`e8d45a38`, *"Dispatching a BOARD AUDIT beside the writer wave it audits"*) which H20 had surfaced to me,
and I dispatched the audit anyway.

---

## 4. Too much / too little information

**Too much**, consistently. The H19/H20/H23 delivery blocks are the dominant non-work token cost of the
session. A representative single dispatch produced: 1 mechanism-axis block with 3 "PRIOR ANSWERS", 3
"ARTICLES", 3 full anti-pattern bodies including `RIGHT WAY:` code samples, and 5 decision pointers with
their `alternatives_rejected` — several KB, for one `Agent` call.

The anti-pattern bodies are delivered with substantial inline code. That is the correct content for the
one case where the hazard applies, and pure cost for the other nine deliveries where it does not.

**Too little** in exactly one place, and it is important: **the deliveries never told me what a record's
`measured_at_head` was relative to current HEAD.** `board_query` does compute a *"⚠ file_keys changed in N
commits since this item's evidence was measured"* annotation and reported `provenance: "checked"` — but I
never saw that annotation fire on any of the ~10 stale items in §3.1/3.2, because most carried no
`file_keys`. The one item that did carry them (`f7ae471a`) showed `⚠1 commits since measured` and was in
fact still accurate. So the mechanism exists and was silent on every item where it mattered.

---

## 5. Hook-by-hook

| Hook | Firings | True positives | Assessment |
|---|---|---|---|
| **H1** rotation restore | 1 | 1 | Injected and consumed the prior note at session start; `source=clear`, HEAD matched. Worked exactly as designed and set up the whole session. |
| **H4/H5** test-writer wall / frozen tests | implicit | 2 | Two `test-writer` agents refused to infer specs from implementation and named the missing constants instead. Both refusals were correct and produced better outcomes than compliance would have. |
| **H10** capture / articles / pressure | ~6 | 6 | Caught 4 unowned files and 2 capture-owed states. Its fan-out-aware deferral (*"duty re-arms when they land"*) correctly did not nag while lanes held files. |
| **H14** subagent Bash allowlist | 0 observed | — | No denials seen. Agents ran Godot/gdlint/gdformat/Blender successfully, so the allowlist is correctly configured for this project. |
| **H19** path-axis delivery | ~8 | ~2 | Mostly re-delivered hazards I was not near. The `ROADMAP.md` tracking-row hazard was a genuine hit. |
| **H20** mechanism-axis delivery | ~15 | ~2 | Fires on nearly every dispatch; the largest single token cost in the session. Its own header admits it matches "this prompt's SUBJECT" rather than a touched file, which is why precision is low. |
| **H23** output-axis delivery | ~6 | 1 | The ROADMAP hazard. Others were tangential. |
| **H24** gate exit lint | 2 | 2 | **Best hook in the plugin.** Deterministic, narrow, correct both times. |
| **H25** capability advisory | ~5 | 4 | Caught a real brief defect I repeated three times. Warn-only is the right severity. Missed the `test-writer`-has-no-Bash case. |
| **H26** overlap advisory | ~6 | ~0 | Flagged the Godot binary and gdUnit4 CLI as contended. I stopped reading it. |
| **H27** dispatch signatures | 0 | — | Opt-in, not enabled here. Not assessed. |
| **Nothing** | — | — | **No mechanism caught that my brief asserted a false premise** (the `_vendor_clip_coverage.py` double-count). A lane had to measure it and tell me. |
| **Nothing** | — | — | **No mechanism warned that board `67cbdf96` was 5 days old and self-describing as authoritative.** I dispatched 3 lanes at falsified work. |
| **Nothing** | — | — | **No mechanism checked the review receipt's `at` against the diff.** CLAUDE.md warns in prose; `commit-reviewed.mjs` stamps regardless. I caught the 21-minute gap by hand and ran a second review. |
| **Nothing** | — | — | **No mechanism caught that I overrode a board item's stated test approach** and weakened a pin. Codex did, one review pass later. |
| **Nothing** | — | — | **No mechanism verified a pin by mutation.** CLAUDE.md rule 6 requires it; I did it voluntarily and it was the only proof the fix worked. |

---

## 6. What I did not exercise, and therefore cannot assess

Stated so this reads as a review of what I used, not of everything:

- **The gated pipeline** (`/sterling:feature`, runs, phases, `run_signal`, `run_state`) — no run was
  active at any point. Every agent's `agent_exit` refusal is a *symptom* of this, not an assessment of it.
- **`/sterling:cleanup`**, **`/sterling:init`**, **`/sterling:merge`**, **`/sterling:council`**,
  **`/sterling:dashboard`** (the TUI), **`/sterling:update`** — none invoked.
- **`knowledge_promote`** — forbidden by a standing user ruling; never called.
- **`knowledge_split`, `knowledge_supersede`, `knowledge_retire`, `knowledge_link`, `knowledge_extract`,
  `knowledge_preflight`, `concept_designed`, `run_escalate`, `capture_pending`, `no_capture`** — not used.
- **Cron/watchdog** — none fired.
- **Domain stores** (`~/.sterling/domains/<tag>/`) — not touched; all work was project-scoped.

---

## 7. Session shape, for context

- **2 commits**: `c6d5012` (20 files, +1775/−118, both review trailers), `f988972` (CLAUDE.md ruling).
- **~20 subagent dispatches** across coder, test-writer, explorer, librarian, reviewer-correctness, debugger.
- **1 Codex consult** (outside model family), which found 2 HIGH defects and 1 data-loss risk that
  `reviewer-correctness` had passed clean.
- **2 user rulings taken** through the question form, both captured as decisions.
- **3 knowledge records created**: 2 decisions, 1 anti-pattern, 1 feature article.
- **Maintenance queue**: 15 → 2. Of the 13 closed, **6 were already paid** (~46%).
- **Board**: 294 items measured; 5 closed, 8 rewritten.
- **Gates**: `gdlint`/`gdformat --check`/`--check-only` on 7 scripts; scoped suites 792 cases, 0 failures,
  run with `-c`.
