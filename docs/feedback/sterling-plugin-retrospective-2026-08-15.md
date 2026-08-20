# Sterling plugin retrospective — 2026-08-15

**Project:** dome-farmer (Godot 4.6 + Blender, GDScript/Python). Sterling is *consumed* here, never developed here.
**Session shape:** one conductor-direct slice — regenerate a 392-row asset manifest, fix the consuming GDScript reader, and render a before/after plate for a user ruling. 11 subagent dispatches, 0 commits at time of writing (the slice is at its boundary, gates green).
**Branch:** `feat/asset-pack-swap`, HEAD `8a4fb7e`.

> A prior retrospective series exists on this desktop: `sterling-plugin-retrospective-2026-08-14.md`, a second at `-2030`, an assessment at `sterling-plugin-assessment-whole-system-2026-08-14.md`, and an `ADDENDUM-2026-08-14-2045`. This file is a fresh account, not a revision of those. The system-design half of today's feedback is in the companion file `sterling-plugin-assessment-whole-system-2026-08-15.md`.

---

## 1. Where it genuinely helped — receipts, own-goals first

The single most valuable thing Sterling did today was **catch four defects in briefs I had already written and dispatched.** Not defects in the code — defects in my own instructions to agents, which is the class of error nothing else in the stack can see, because a subagent reasons *from* its brief rather than doubting it.

**H20 (mechanism-axis delivery) — 4 caught briefs, all mine.**

| # | What my brief said | What H20 delivered | Cost avoided |
|---|---|---|---|
| 1 | *"Do not dump it. Fetch it once, then read ONLY that file's own entry in the article."* | anti_pattern `252e7042` — *"A BRIEF CONSTRAINT WRITTEN TO PROTECT THE CONDUCTOR'S CONTEXT THAT BLINDS THE AGENT TO THE THING IT WAS SENT TO DO."* | I had written an **input** restriction meaning an **output** one. The agent was being sent to rewrite article prose while told not to read it. Corrected mid-flight via SendMessage; the agent returned complete verbatim FIND/REPLACE drafts for 3 fields. |
| 2 | *"Wrap line 368 so it is within 100 characters."* | anti_pattern `2e4010e6` — never hand-wrap a gdUnit4 `assert_*` chain; gdformat rewrites it into a dangling `. is_true()`. Record says this cost three round trips in one day previously. | A guaranteed second gate failure. |
| 3 | Render brief assumed the in-frame proof would behave normally | anti_pattern `7e996bec` — `unproject_position` returns **stretch-base** coordinates (3440×1440 basis), not saved-image pixels; a naive bounds check rejects good plates | I forwarded this to the agent so it would not misread a `PROBE_INVALID` as an instrument artefact. The probe already handled it (`factor=(1.0000,1.0000)` printed on every view), but I could not have known that when briefing. |
| 4 | Dispatched `test-writer` to change one line | anti_pattern `6faa528e` — test-writer's tool list has **no `Edit`**, so any change is a whole-file `Write` that re-types every frozen case by hand | I warned the agent to transcribe faithfully and planned a `git diff` verification. Without this the risk was a silent transcription slip across a 925-case-backed file. |

That is a genuinely high hit rate for a delivery mechanism, and **none of these were reachable by path-scoped delivery** — H20's own header says so each time: *"matched on this prompt's SUBJECT … rather than any file you touched. Path-scoped delivery cannot find these."* That is the correct architectural claim and today it paid off four times.

**H10 (direct-capture) — 2 firings, both correct, both produced a real record.**

- Firing 1: *"direct-mode work touched 1 file(s) but nothing was captured."* → produced `research_finding b3f69c14`, the full export measurement (counts block, the exact command, the census-file trap at `export_part_library.py:3208`, the 1,546 benign FBX warnings).
- Firing 2: *"touched 2 file(s) … Test-integrity vs git HEAD: modified [game/test/mech/mech_part_library_test.gd]"* → produced `anti_pattern e2b689bb`, the silent base-promotion finding described in §3.

Neither would have been written without the nudge. I was mid-flight on a render and would have moved on. The second firing's **test-integrity line** is a nice touch — it named the modified test file unprompted, which is exactly the file a capture ought to account for.

**H5 (frozen tests) — 1 firing, correct, and it caught *my* dispatch error.**
I sent a `coder` at `game/test/mech/mech_part_library_test.gd` for a one-line lint fix. H5 denied every write:

> `H5: '…mech_part_library_test.gd' is a test path ('game/test/**/*_test.gd', none toolchain) — tests are frozen during the fix loop.`

The agent read the hook's own source, confirmed the check is unconditional with no whitespace carve-out, and **refused to route around it** — reporting three legitimate options instead. That is the system working exactly as designed: a hard block plus an agent that treats a conductor instruction as not-authorisation-to-bypass. The right move (dispatch `test-writer`) was mine to make and I made it.

**H14 (subagent command allowlist)** blocked `git status --short` from the export agent. Correct — git is conductor-only here. The agent reported the denial cleanly rather than retrying, and I ran it myself.

**H1 rotation restore** re-hydrated the session after `/clear` with the exact next slice, the verbatim export command, and the prediction that MPL7 would go red at `mech_part_library.gd:416`. That prediction was **exactly right** — measured `static_count` 326 vs manifest `exported_static` 324. Without it I would have spent a dispatch rediscovering it.

---

## 2. Friction — what fired wrongly or fought the task

**H19 frontier signal has no ignore-file awareness. 3 false positives today, and the mechanism is structurally unable to be right here.**

Every time I opened a render plate — which the project's own conduct rules *require* me to do personally — I got:

> `STERLING FRONTIER SIGNAL (H19): territory 'tools/blender/out/assembled/tank_before/front.png' is UNOWNED — no owning article exists in the store. … H10 will demand the owning article at session end if this work lands here.`

Fired on `tank_before/front.png`, `tank_before/left.png`, `tank_after/front.png`. **`tools/blender/out/` is gitignored at `.gitignore:74`**, by an explicit user ruling (`323b4954`) that all generated plates live in a gitignored folder. There are ~2,900 PNGs under that tree. No article will ever own them, none should, and the threat *"H10 will demand the owning article at session end"* is a threat about work that by construction cannot land.

This is not "a bit noisy" — it is a check whose precondition (untracked territory implies undocumented work) is inverted for any project with a build- or render-output directory, which is most of them. **The fix is one line: consult `.gitignore` before emitting a frontier signal.**

**H20's payload is large and its hit rate, while good, is not that good.** Each dispatch carried 3 anti-patterns quoted at ~150–250 words each plus 5 decision pointers with rejected-alternatives — I estimate **1,800–2,600 tokens per dispatch**, and there were 11 dispatches, so roughly **20–28k tokens** of H20 delivery in this session. Four of those payloads changed my behaviour. That is a ~36% hit rate at the *payload* level, and much lower at the *individual record* level: of roughly 33 anti-patterns delivered, 4 were acted on. The rest were plausible, on-topic, and irrelevant to what I was actually doing.

I want to be careful here, because **I would not trade the four catches away**. The problem is not that H20 is wrong; it is that it has no way to rank. See the companion assessment, §8.

**PostToolUse Read delivery on `mech_part_library.gd` spilled to a file** — 13.3 KB, persisted to `tool-results\hook-toolu_…-3-additionalContext.txt` with a 2 KB preview. A delivery large enough to be spilled is a delivery that has failed at its job, because I read the preview and moved on. The one record in it I would have wanted (`2de272e4`, two classes owning the same predicate name) I saw only because it happened to lead the preview.

---

## 3. Wrong information — including mine

**The most expensive wrong claim in this session was one *I* wrote, in Sterling's own handoff mechanism.**

The rotation note (written by me before the `/clear`, restored by H1) stated as settled fact:

> *"a BEFORE and AFTER of `Spiders_Chassis_Tank_Lvl1`, showing that without the carrier the tank body has no host and **silently vanishes** … That pair also shows what a player fitting a carrier would see, which is **nothing**."*

**Every clause of that is false.** Measured: the body renders complete without the carrier (I opened the plates — full hull, both track runs, road wheels), and fitting the carrier produces **SHA-256-identical** plates on all three views. The real mechanism, found by the render agent at `mech_part_seater.gd:390-401`: a part whose declared host is absent is **silently promoted to its own base** at the origin, with no `SKIPPED` entry, so the success log and the failure log are the same log.

I then **propagated the false premise into an agent brief**, and worse, pre-authorised the wrong outcome: *"RUN 2 is EXPECTED to seat nothing … IF THAT HAPPENS, THAT IS THE CORRECT RESULT."* Had the run failed for an unrelated reason, that instruction would have laundered it into a confirmation. As it happens RUN 1 *did* fail for a completely unrelated reason (the carrier `.gltf` had never been imported, so `ResourceLoader.exists()` returned false).

Captured as `anti_pattern e2b689bb`. **No Sterling mechanism caught this, and none could have** — see the "Nothing" rows in §5.

**Agent reports that corrected me — 3, all load-bearing:**

1. The probe-mapping agent corrected my framing of the carrier: I described it as `held_back: true, glb_path: null`; at HEAD it is `kind: "socket_carrier"`, `held_back: false`, `glb_path` populated. It told me plainly: *"that is stale against HEAD … State this precisely in the work order."*
2. The render agent refuted the entire BEFORE/AFTER premise and told me the honest pair was *"unattached at origin vs seated on the hull, which is a different claim from the one in the brief."*
3. The reconcile agent **refused to write three sets of numbers** it had not measured, naming `anti_pattern b3c87ca1` as its reason: *"editing only the file count while leaving an unverified socket-node figure sitting beside it as if both were re-measured together would itself be a false consistency."* That is a subagent applying a stored anti-pattern to decline work. It is the best single moment of the session.

**Stale records found in the store:**

- `mech-part-export` article **title** reads `358-part .gltf library`; truth is 360. Its `what_it_does` and `intended_behavior` each carry a `358` with a dated "MEASURED 2026-08-14" annotation. **The annotation did not stop it rotting** — it rotted in one day. `anti_pattern b3c87ca1` exists in this store *specifically* about counts rotting in prose, and it happened again to the article that anti-pattern was written about.
- `e31c7e1d` (a live decision) still asserts `mount_chassis_shake` is exposed only by *"a mesh-less marker prefab — `held_back`, `glb_path: null` … UNREACHABLE, not excluded."* Ruling `0b6c8be1` exported that carrier. A live decision carrying a falsified premise, found only because I ran a contradiction check.
- `docs/mech-asset-inspection-log.md` (the tracked ledger that survives `/clear`) described the same carrier as held-back with no mesh, at 4 locations. Corrected this session.

---

## 4. Too much / too little information

| Delivery | Size | Fraction used |
|---|---|---|
| H1 session-start conventions + rotation note | 11.7 KB, spilled to file | ~90% — the rotation note was the highest-value single artefact of the session |
| H20 per-dispatch payload | ~1.8–2.6k tokens × 11 | 4 of 11 payloads changed behaviour |
| H19 PostToolUse on a `.gd` Read | 13.3 KB, spilled to file | ~5% (read the 2 KB preview only) |
| H19 frontier signal on plate reads | ~60 tokens × 3 | 0% — structurally inapplicable |
| H19 Bash pointer block (manifest paths) | ~400 tokens, 13 pointers | ~10% — 1 record I already had open |

**The pattern: deliveries are sized by what matches, not by what is likely to matter.** Two of the five rows above were large enough to be spilled to disk, and spilling is the system conceding it over-delivered.

**Too little, in one place:** `knowledge_query` gave me a window and no way to widen it usefully. The contradiction check returned `matched_filter: 635, returned: 200, capped: true` — the agent read 200 titles and told me honestly: *"435 matched records I never saw at all. My 'nothing forbids auto-fitting' is a statement about 200 titles and 8 full reads — NOT about the store. Do not upgrade it."* That is correct agent behaviour and an unacceptable API position: I cannot establish absence, and absence is exactly what a contradiction check needs.

---

## 5. Hook-by-hook — including what nothing caught

| Hook | Firings | Verdict |
|---|---|---|
| **H1** (session start / rotation restore) | 1 | **Excellent.** Restored the exact next slice, the verbatim command with its quoting trap, and a correct prediction of which test would break and where. Also disclosed the deep queue with a lane breakdown. |
| **H5** (frozen tests) | 1 | **Correct.** Blocked a `coder` write to a `_test.gd`; the agent refused to route around it. Caught my dispatch error. |
| **H10** (direct capture) | 2 | **Correct both times.** Produced one `research_finding` and one `anti_pattern` that would otherwise not exist. The test-integrity line naming the modified test file is a good detail. |
| **H14** (subagent allowlist) | 1 | **Correct.** Denied `git` to a subagent; clean report, no retry. |
| **H19** (path-scoped knowledge) | ~6 | **Mixed.** The `.gd` Read delivery was useful but oversized and spilled. The **frontier signal on gitignored plates was wrong 3/3 times** and cannot be right without ignore-file awareness. |
| **H20** (mechanism-axis on dispatch) | 11 | **The best thing in the plugin, and the most wasteful.** 4 real catches on my own briefs; ~20–28k tokens spent; no ranking. |
| **H21** | 0 observed | Did not fire in this session; cannot assess. |
| Watchdog tick | 2 | **Useful as a forcing function.** The mandatory enumeration in Q1 made me name the deferred queue items as parallel work instead of hand-waving "nothing to dispatch". Both ticks produced a real dispatch. |
| **Nothing** | — | **No mechanism validates a rotation note's factual claims.** My note asserted a falsified prediction as settled fact; H1 restored it faithfully; I briefed an agent from it. The handoff is trusted end-to-end with zero verification, and it is *the* artefact a fresh session trusts most. |
| **Nothing** | — | **No mechanism noticed that a tracked project doc contradicted the manifest.** `docs/mech-asset-inspection-log.md` was stale at 4 places for a day. It was caught only because an agent I sent for something else happened to read the manifest row. |
| **Nothing** | — | **No mechanism connects a re-exported artefact to the articles asserting counts about it.** The manifest changed; four articles carrying `358`/`33` did not go red anywhere. The maintenance queue raised `reconcile_needed` on *file mtime*, which is right, but nothing checked whether the numbers *inside* the prose still held. |
| **Nothing** | — | **Nothing enforces "the conductor opens the plates".** This project's most-repeated rule, the one the user has restated at least three times, is prose only. I complied; a tired session would not, and the system would not know. |

---

## 6. What I did not exercise, and therefore cannot assess

Stated plainly so this does not read as a review of everything:

- **Pipelines / gated runs** — none. This was conductor-direct throughout; `run_state`, `run_signal`, `run_escalate`, phase gating and the disposal gate were never touched.
- **`/sterling:cleanup`, `/sterling:init`, `/sterling:merge`, `/sterling:council`, `/sterling:dashboard` (TUI), `/sterling:drain` as a command** — not used. I drained the queue by hand-drafted librarian dispatch instead.
- **`knowledge_promote`, `knowledge_link`, `knowledge_retire`, `knowledge_preflight`, `capture_pending`, `no_capture`, `concept_designed`** — not called.
- **`board_add` / `board_update` / `board_remove`** — not called this session; the board was read (199 items, per the rotation note) but not modified.
- **H21 and any cron/scheduled behaviour** — no observed firing.
- **`handoff_read` / `handoff_write`** — several agents reported these refused with *"no active run"*, which is presumably correct outside a run, but I did not verify that is intended.

---

*Companion document: `sterling-plugin-assessment-whole-system-2026-08-15.md` — the design review.*
