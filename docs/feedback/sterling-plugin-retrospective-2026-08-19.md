# Sterling plugin retrospective — 2026-08-19

**Project:** dome-farmer (Godot 4.6 + Blender; Sterling consumed, never developed here)
**Branch:** `feat/asset-pack-swap` · **Session span:** HEAD `0ca9565` → `72985a7` (5 commits by me; 24 commits on the branch today across sessions)
**Companion file:** `sterling-plugin-assessment-whole-system-2026-08-19.md` — Part B (the design review) lives there. **This file is Part A: the session evidence.**

A prior series exists on this desktop: 18 files dated 2026-08-14 through 2026-08-18. I did not read them; this is a fresh account.

**What the session was.** A visual-inspection campaign: render mech-part contact sheets in Godot, open every plate by eye, rule rows in a tracked ledger, correct the board, drain the store. 12 subagents dispatched. 26+12+16 = 54 plate images opened by me personally. Ledger moved 293 → 301 ruled of 392.

**What I could not assess, and am not reviewing:** the gated pipeline and run lifecycle (`run_state`, `run_signal`, `agent_exit`, phase execution) — no run was active; `/sterling:cleanup`; `/sterling:init`; the merge gate; the council; the TUI dashboard; `knowledge_promote`, `knowledge_link`, `knowledge_retire`, `knowledge_preflight`, `concept_designed`, `capture_pending`, `no_capture`, `handoff_*`. Also unexercised: the `test-writer`, `reviewer-correctness`, `reviewer-security`, `reviewer-performance`, `reviewer-skeptic` and `implementation-architect` agents — the session produced no logic-bearing diff to review.

---

## 1. Where it genuinely helped

I am putting the strongest case first because it is the whole argument for the design.

### 1.1 H20 delivered the record that overturned my own wrong verdict — the best single thing that happened

I opened a contact-sheet cell showing `Humanoids_Arm_Weapon_Hvy` on host `Shoulders_Rhino`. It read as plainly **detached** — the weapon well outboard of the machine with visible background between it and the torso, and the tight cell looking like two disconnected fragments. I drafted a `CONTESTED` verdict against an existing `Y`, wrote it into a `coder` brief, and dispatched it.

H20 fired on that dispatch and delivered `21e3270c` — *"A SUBJECT-HIGHLIGHT PLATE ANSWERS WHICH PART IS THE SUBJECT AND NOT WHETHER IT IS ATTACHED."* Its `right_way` block opens:

```
# 1. THE SEAT LOG, FIRST. One grep, and it is decisive.
#   PLACEMENT world_position=(1.5653, 2.8333, -0.9751)
#   subject centre - socket = 0.36 m outboard, ~0 vertical
#   0.36 m IS THE PART'S OWN HALF-WIDTH. It is sitting ON the mount.
```

I ran that grep against the probe log I already had on disk:

```
PLACEMENT host=Humanoids_Shoulders_Rhino socket=Mount_Weapon_L assembly_space=false
PLACEMENT world_position=(1.3684, 3.221001, -0.0225)
SUBJECT_BOX SIZE width=1.6777 height=2.1505 depth=1.6356 m (TRUE AUTHORED SCALE)
CHASSIS_CHAIN VERIFIED over 3 parts
VIEW_AXIS=chosen=+Z area=3.608 runner_up=-X area=3.517
```

The socket is 1.3684 m outboard; the part is 1.68 m wide. Far outboard is exactly where it belongs. I sent a `SendMessage` correction to the still-running agent and it applied the reversal.

**Why this is the strongest evidence in the document:** nothing else in the stack could have caught it. Every structural check passed — `status=OK`, `INSIDE_WITH_MARGIN true`, `FILL_RATIO 0.3248` against a 0.10 floor, `PLATE_COLOURS distinct=944`, `SCALEBAR err=0.0020 OK`, `SOCKETS_PARTIAL n=0`. A green test suite could not see it. A reviewer agent could not see it. **My own eyes produced the wrong answer.** A record written weeks ago, delivered automatically at the moment of dispatch, was the only thing standing between a fabricated defect and the ledger.

### 1.2 H20 caught that I had briefed a one-sided test

I dispatched a lane to adjudicate 57 `file_parked` maintenance items and briefed it with anti_pattern `4cd022bd` — *"a `file_parked` item whose branch claim is TRUE can still reach the WRONG conclusion — the DELETION is the thing that reached main."* H20 fired on the dispatch and delivered `84751127` — *"Absence from the working tree is NOT deletion — the store's file checks are branch-relative, and a parked branch makes the knowledge base look rotten when it is correct."*

These are the two halves of one test and I had briefed only one. Left alone, the agent would have been under pressure to find deletions. I sent the counter-record by `SendMessage` with an explicit discriminator (was the last commit a deletion, *and* is it an ancestor of `main`). The agent came back having invented a fourth verdict label — `PARKED-MISATTRIBUTED` — for 47 items that fit neither half, and said so explicitly rather than forcing them. That refusal was correct and I verified its basis myself: `git merge-base --is-ancestor 543a314 main` → YES (so 3 items genuinely owed a reconcile), `bd0c18a` / `1fa576f` / `52d532b` → NO (so 50 items were correctly deferred).

### 1.3 H20 caught an error in a commit I had just made

I committed `914465e`, fixing a `fit.py` docstring that cited `spread_sweep.py:304-305` for code at `319-321`. My replacement text said `spread_sweep.py:319-321`. On the very next dispatch, H20 delivered `34a50d38` — *"A line-number cite into a growing file rots silently, and the same wrong number breeds copies — cite a GREPPABLE ANCHOR instead."*

**My fix for a rotting pointer contained a fresh rotting pointer.** I corrected it in `82896c9` to a greppable anchor (`grep -n "_prefab_linear_is_vendor_replay" spread_sweep.py`) and recorded that the first draft carried the defect it was correcting.

### 1.4 The fabricated-citation check fired, for the second time in two days

A drain lane reported: *"This auto-drained the queue item (decision `8ecd435f`)."* One call:

```
knowledge_get 8ecd435f
→ "no record '8ecd435f' in the project store or any mounted domain, at any status — and no slug matches"
```

The action was correct — the record it updated was genuinely stale. The justification was invented. **This is the second occurrence of the same non-existent id**; anti_pattern `133e81d5` records the first, from 2026-08-18, by a different lane. I appended the second occurrence, noting that a recurring fabricated id suggests reconstruction from context rather than fresh invention — which makes it *more* plausible-looking, not less.

That the store already contained a record telling me to run that exact check is the design working.

### 1.5 H3 blocked an edit on a file an agent had changed under me

I tried to `Edit` `docs/mech-asset-inspection-log.md`. H3 refused:

> *"no fresh read-evidence for 'docs/mech-asset-inspection-log.md' … Evidence EXPIRES WHEN THE FILE CHANGES (read-time content hash vs current bytes)"*

Correct and load-bearing: a `coder` agent had rewritten the file between my read and my edit. Without the hash check I would have written against a stale mental model of a 3,700-line table.

### 1.6 H15 blocked a store read through the shell

My second command of the session was `cat .sterling/rotation-note.json`. H15 refused it with a clear explanation and pointed at the MCP surface. Correct — though see Part B §8 for the gap this exposes (there is no MCP read for the rotation note; only H1 can serve it).

---

## 2. Friction / made things worse

### 2.1 H19's frontier signal is unusable in a project with a render output directory — ~20 false positives, 100% false-positive rate

Every plate image I opened produced:

> *"STERLING FRONTIER SIGNAL (H19): territory 'tools/blender/out/sheets/sweep21/tight/sheet_01.png' is UNOWNED — no owning article exists in the store … H10 will demand the owning article at session end if this work lands here."*

I opened **54 plate images**. I counted at least 20 of these firings in transcript (some Read batches emitted one per file). **Every single one was a false positive**, and the reason is structural, not incidental:

- `tools/blender/out/` is **gitignored** (`.gitignore:74`). It holds **2,922 PNGs** by a prior measurement.
- The project has a *decision* saying these files must never be owned: `5e617854`, *"No file under `tools/blender/out/` is given an owning `feature_article`"*, with the "create one article for the whole tree" option explicitly listed in `alternatives_rejected`.

So the store **already contains the ruling that makes this warning wrong**, and H19 fires anyway. The check has no ignore-file awareness and no awareness of a decision that scopes it. Worse, the warning threatens a consequence — *"H10 will demand the owning article at session end"* — that a standing decision says will never be legitimate.

**Cost:** noise on every single plate open, in a session whose entire purpose was opening plates. Not expensive per firing; corrosive at volume, because it trains the reader to skip H19 output — and H19 is also the channel carrying the genuinely valuable hazard deliveries in §1.

### 2.2 H21's hand-work counter fires hardest on the one duty that cannot be delegated

H21 fired twice, both times mid-plate-opening:

> *"H21 hand-work streak: 10 distinct hand-work action(s) (reads + searches) since the last dispatch — moment 3 of decision 677f1639: hand-work that needed only its CONCLUSION was a dispatch."*

The project's CLAUDE.md names looking at pictures as one of six things that **cannot be delegated even in principle** — *"it is precisely the judgement the agent structurally could not make."* H21 counts image `Read` calls as hand-work indistinguishable from reading source files. In a visual-inspection session it is guaranteed to fire and guaranteed to be wrong.

The advice it gives is also unactionable in the specific case: I cannot delegate looking at a plate, and §1.1 is the proof — the one time an agent's structural report and my eyes disagreed, *both* were wrong and only the log was right.

### 2.3 The H14 allowlist is a literal prefix match, which makes correct commands undeniable and denied commands unexplainable

Three separate denials this session, all with the same root cause:

| What was denied | Why | Cost |
|---|---|---|
| `cp probe_log.txt probe_log_tight.txt` | `cp` is not in `run_commands` | Agent had to discover `fs-move.mjs` and that it takes **repo-relative** paths only |
| `--path "C:/Users/chulf/Dome Farmer/game"` | absolute path is not the allowlisted prefix `... --path game ...` | **One full round.** See §3.2 — this one was my fault. |
| `cd "..." && <godot>` | chaining | — |

And one denial reported by an agent that I could not have predicted:

> *"the shell's `grep -cE` was blocked by H14 on the pipe-heavy pattern — used the Grep tool instead, same regex semantics"*

**The design problem:** a prefix allowlist cannot express "this command, with these arguments in any order." The Godot path must be **unquoted** (or the prefix does not match) while the Blender path must be **quoted** (or the shell splits on the space). Same project, opposite rules, and neither is discoverable from the denial message. dome-farmer's CLAUDE.md carries a warning block about exactly this, which is documentation debt pushed onto the consuming project.

### 2.4 Knowledge-record ids change on every write, and two agents hit it mid-task

Two separate agents reported the same rejection:

> *"First attempt against `b1e13769…` was rejected: `supersede: record 'b1e13769...' is already superseded` (edit 1 had already minted a new id). Retried against `ef8dc09c…`."*

A second agent, editing a different record, hit it identically. **This is not a bug, it is the versioning model — but it means a two-field edit is a three-step dance** (edit field 1, capture the new id, edit field 2 against it) and the failure mode is a hard rejection mid-task rather than a transparent follow. See Part B §7.

### 2.5 Short ids are refused everywhere, and every human-readable surface prints short ids

`board_update` with `1c43b64c` → `no record '1c43b64c'`. `board_remove` with a uuid I reconstructed → refused. Agents reported `maintenance_remove` refusing 8-char ids.

Meanwhile the *audit report* I was working from — and every board digest — refers to items by their 8-char prefix, because that is what is readable. So the workflow is: read a short id → run a `contains:` query to recover the full uuid → act. **That is an extra round trip per item, on a lane that touched 13 items.**

---

## 3. Wrong info, or none — including mine

### 3.1 The board carried a 40-row error on its most-read item, stamped "re-measured"

Board `3074cd0d` is the mech-swap campaign tracker. It stated **`253 Y / 139 N`** in two places, one of them under a heading reading *"RE-VERIFY WHEN PICKED UP"* with the phrase *"re-measured 2026-08-19"* beside it.

I measured at HEAD: **`293 Y / 99 N`**. Forty rows of drift, with a freshness stamp on it.

A second tracker, `5728b586` (*"THE GOAL TRACKER — READ THIS FIRST, IT IS THE ENTRY POINT"*), independently carried **`130 / 262`** — off by 163 — plus two other falsified claims I verified myself:
- *"`804c4efb` PART 2 REMAINS OPEN"* → `grep -rn 'for intent in \["walk", *"idle"\]' game/ --include=*.gd` returns **0**; the loop is gone and `mech_controller.gd:3502` calls the replacement every frame.
- *"NONE of the seven new weapons is instantiated in any scene"* → all seven appear in `main.tscn` and in 3–5 production `.gd` files each.

**Two trackers for one objective, both wrong, in different directions, on the same day.** That is the mechanism: nothing binds a tracker to the artefact it summarises.

### 3.2 A read-only audit measured the damage: 19 of 31 high-priority items wrong or stale

I dispatched an `explorer` to re-verify every high-priority board item under two objectives against HEAD. It read **31 items in full** and returned:

| verdict | count |
|---|---|
| CLOSE (fully discharged) | 2 |
| REWRITE (partly done, claim wrong) | 11 |
| KEEP (still accurate) | 12 |
| STALE-EVIDENCE (concern survives, cites dead) | 6 |

**19 of 31 — 61% — carried something load-bearing and false.** This matches a figure the project had already measured on a smaller sample (5 of 8 in an earlier audit).

### 3.3 My own record was falsified within two hours of my writing it

I captured `research_finding` with slug `sheet-plan-dryrun-predicts-contact-sheet-cells-and-errs-only-optimistic-2026-08-19`, whose headline claim was:

> *"YES, WITH ONE STATED ERROR DIRECTION: it is exact or OVER-OPTIMISTIC, never pessimistic."*

Captured from two batches. **Violated on the third.** On batch `sweep15` the predictor said 12 planned / 2 refused; the probe planned **14** and refused **4** — an under-count, the direction I had declared impossible.

⚠ **And the errors cancelled.** Predicted net yield 12−2 = 10; actual 14−4 = **10 exactly**. Anyone checking only the rendered-cell count would have logged a clean hit. It was caught solely because I had briefed the render lane to check *both* columns with its own `grep -c` and to flag a surplus loudly.

I corrected the record in place (correction block above the original claim, original preserved, `volatility_hint` `medium` → `fast`). **The slug still contains the falsified claim** — I left it, because renaming a slug orphans every reference. That is a real design tension, noted in Part B §7.

### 3.4 My brief was wrong and the agent was right

I dispatched a render lane. H20 delivered `6d399cd3` — *"A SUBAGENT'S BASH CWD IS NOT THE REPO ROOT, so the allowlisted `--path game` gate cannot resolve."* I read it, believed it applied, and sent a mid-flight `SendMessage` telling the agent to use an absolute `--path`.

The agent replied:

> *"⚠ Conductor: your mid-task correction cannot be applied — H14 refuses it. … The relative `--path game` is simultaneously the only permitted form and demonstrably working — my shell CWD is the repo root, and all 16 Godot calls produced real output. Anti-pattern `6d399cd3` did not fire here."*

It was right. **H20 delivered a real, well-written record that did not apply to this case, and the delivery mechanism has no notion of applicability.** I over-applied it and cost the lane a round. This is the mirror image of §1.1–1.3 and belongs in the same review: the same channel that saved me three times misled me once, and the difference was entirely my judgement.

### 3.5 The maintenance queue was 51% duplicates of a handful of facts

At first measurement: **61 items, `capped: false`** — 57 `file_parked`, 3 `reconcile_needed`, 1 `article_oversize`.

The 57 `file_parked` items covered only about **25 distinct `(article, path)` pairs**. One example, all six items naming the same file under the same article:

```
game/spike/mech_weapon_survey_probe.gd @ probes-weapons-combat
  → items cf21f037, b1212a73, 3620944c, 73639351, 823339e3, e94c956c
  timestamps: 08-16 12:03 · 08-16 22:46 · 08-17 15:55 · 08-17 18:59 · 08-17 21:30 · 08-18 06:13
```

Two sibling files fired **at the same six timestamps to the second** — so one hook invocation re-raises a whole article's file set, repeatedly, across days, with no idempotency check. An agent measured **31 of 56 items as exact duplicates** (55%).

I removed 31 duplicates + 3 genuinely-retired items. Queue: **61 → 26**.

⚠ **And the queue misled in the *outstanding* direction, not the *live-defect* direction.** All 57 `file_parked` items claimed *"this closes when branch X lands"* — and for 47 of them the named branch was a red herring that had merely forked before our own deletion. The items were not wrong that work was owed; they were wrong about **what would discharge it**.

### 3.6 A `file_parked` item's self-description is not checkable from the item

The first lane I sent at the queue sampled 5 of 57, found each declares itself *"INFORMATIONAL: no reconcile is owed"*, and left all 57 on that basis. That is reading the item's conclusion instead of its evidence — and the store has an anti_pattern for exactly it. The item text asserts its own disposition and carries no field distinguishing "verified informational" from "asserted informational."

---

## 4. Too much / too little information

Four deliveries this session were large enough that the harness spilled them to files rather than inlining them:

| Delivery | Size | Fraction I used |
|---|---|---|
| H1 SessionStart conventions | **9.9 KB** | Low — it is the standing contract I already follow; the actionable part is the queue-depth line |
| H19 on `Read` of `fit.py` | **30.9 KB** | ~2 of 5 records were relevant; I used one (`d25f5a9e`, array truncation) |
| H19 on `Read` of the ledger | **16.5 KB** | Low — I had just written the section I was reading |
| H19 on `Edit` of the ledger | **13.1 KB** | Near zero — same file, seconds later, largely the same records |

**That last pair is the clearest waste: a `Read` immediately followed by an `Edit` of the same file produced 29.6 KB of overlapping delivery.** H19 fires on both PreToolUse and PostToolUse for `Edit|Write|MultiEdit` and on PostToolUse for `Read`, with no session-level memory of what it has already delivered for a path.

H20's per-dispatch deliveries were better calibrated — roughly 2–4 KB inline, 12 dispatches — and had the highest hit rate of anything in the stack (§1.1–1.3 all came from it). **But it also has no de-duplication**: `21e3270c` was delivered to me at least three times across different dispatches, and `9d3363fa`, `34a50d38` and `4447cbee` each arrived more than once.

**The asymmetry worth naming:** the *cheapest* channel (H20, inline, per-dispatch, ~3 KB) had the highest value, and the *most expensive* channel (H19 on file touch, up to 30 KB spilled) had the lowest. That is backwards, and it is a targeting problem rather than a volume problem — H19 fires on *what file you touched*, H20 fires on *what you are about to do*.

---

## 5. Hook-by-hook

| Hook | Fired | Verdict | Evidence |
|---|---|---|---|
| **H1** SessionStart | 1× | **Useful, oversized.** Injects standing conventions + queue depth. 9.9 KB spilled to file. | The rotation-note restore path is the valuable half and did not exercise this session (no `/clear` yet) |
| **H3** contract gate | 1× | **Correct and load-bearing.** Caught an edit against a file an agent had rewritten under me. Hash-based expiry is the right design. | §1.5 |
| **H4** test-writer blinding | 0× | Not exercised — no tests authored | — |
| **H7** reconcile-on-edit | ~2× (inferred) | **Worked.** My two `fit.py` comment edits raised `reconcile_needed` on both owning articles; a lane closed both as already-paid with cited evidence. | Queue showed `37c20629`, `ce21b5da` after my edits |
| **H10** direct-capture + pressure | 4× | **Mixed.** The capture demands were right twice and produced two real records (§1 of Part B). The pressure notices at 35.7% and 54.3% were accurate and actionable. | But see "Nothing" row below on *what* it demands |
| **H14** command allowlist | 4+ denials | **Correct in intent, opaque in practice.** Prefix matching cannot express argument-order-independent commands. | §2.3 |
| **H15** store guard | 1× | **Correct.** Blocked `cat .sterling/rotation-note.json`. | §1.6 |
| **H19** knowledge delivery | ~30× | **Two hooks in one trench coat.** The *hazard delivery* half is valuable; the *frontier signal* half was 100% false-positive here and threatens a consequence a standing decision forbids. | §2.1, §4 |
| **H20** subject-axis delivery | 12× (one per dispatch) | **The best mechanism in the plugin.** Three saves, one misdirection. Highest value per token in the stack. | §1.1–1.3, §3.4 |
| **H21** hand-work streak | 2× | **Wrong in this session type.** Counts image `Read` as delegable hand-work; plate inspection is explicitly non-delegable. | §2.2 |
| **Watchdog tick** | 2× | **Genuinely useful.** Its mandatory enumeration made me find owed store work I had not looked at — reconcile items my *own* edits had raised. | Both ticks produced a real dispatch |
| **Nothing** | — | **No mechanism flagged that a `research_finding` I wrote was contradicted by a later measurement in the same session.** | §3.3 — caught only by a brief I happened to write well |
| **Nothing** | — | **No mechanism flagged two board items carrying different counts for the same underlying artefact.** | §3.1 — two trackers, both wrong, found only by an audit I chose to run |
| **Nothing** | — | **No mechanism noticed the maintenance queue re-raising identical facts for four days.** The queue grew; nothing said "this is the same item six times." | §3.5 |
| **Nothing** | — | **No mechanism connected a `decision` scoping a directory to a hook firing about that directory.** `5e617854` says `tools/blender/out/` gets no owning article; H19 demanded one ~20 times. | §2.1 |

---

## 6. Session numbers, for the record

- **Subagents dispatched:** 12 (2 Opus render/audit, 10 Sonnet). Zero Fable, per project ruling.
- **Agent reports that corrected me:** 2 — the `--path` correction (§3.4) and the ledger heading left inconsistent after my own mid-flight change (a `coder` flagged it rather than silently fixing my prose, which was the right call).
- **Agent refusals that were correct:** 3 — a librarian refusing a 68 KB article edit it could not do safely; an explorer stating it had no shell so every commit claim rested on file state; a lane refusing to force 47 items into a two-way test.
- **Store writes:** 6 new records (2 anti-pattern extensions, 3 research findings, 1 decision), 13 board items corrected, 2 board items closed, 34 queue items removed.
- **Query caps hit:** 1 — `board_query source:"user"` with `cap: 60` returned `matched_filter: 246, capped: true`. Raising it was one call.
- **Tool rejections:** 6+ (short ids ×3, superseded-id ×2, closed-enum ×1, unknown-field ×1).
- **My errors caught by the stack:** 3. **My errors caught by nothing:** 1 (§3.3, caught by a brief I wrote, not by a mechanism).
