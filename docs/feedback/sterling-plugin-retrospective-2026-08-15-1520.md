# Sterling plugin retrospective — 2026-08-15, afternoon session

**Project:** dome-farmer (Godot 4.6 + Blender asset pipeline). Sterling is CONSUMED here, never developed here.
**Session shape:** ~3.5 hours, conductor-direct mode, 8 commits (`fff7708` → `1283ae7`), ~25 subagent dispatches, 2 windowed Godot render batches (278 parts then 62), 3 full Blender library exports.
**Prior files:** retrospectives already exist for 2026-08-14 (×2 + addendum) and 2026-08-15. This is a second 2026-08-15 file, time-suffixed. I did not read them; I grepped headings only for continuity.
**Companion:** `sterling-plugin-assessment-whole-system-2026-08-15-1520.md` carries Part B (the design review). This file is the evidence.

---

## 1. WHERE IT GENUINELY HELPED

### 1.1 A librarian's tool-list constraint caught a user-facing error nothing else would have

The highest-value event of the session, and it came from an agent being *unable* to do something.

I dispatched a librarian to append a history entry to the `probes-mech-assembly-seating` article. Its brief required it to report any passage the append now contradicted. It came back with this, unprompted and outside the scope of its edit:

> "Unrelated but still live and NOT touched by this append: *'UNTIL THAT IS FIXED THIS PROBE'S PLATES MUST NOT BE PUT TO THE USER FOR A MOUNT RULING'* (orientation/barrel-down defect) — this is a separate open issue, correctly still standing; flagging so it isn't mistaken for resolved by the new entry."

**I had already sent the user 14 plates from that probe and asked for a family ruling.** The project's convention is that a family is ruled ONCE for all its members, so that would have been one wrong ruling across twelve parts, written into a tracked ledger as settled.

The mechanism that caught it was **the librarian's mandate to report contradictions it is forbidden to fix**. An agent allowed to fix things would have edited the history and moved on.

### 1.2 Three agent reports disproved briefs I wrote

Each of these would have shipped as a confident fix. All three agents measured instead of complying.

| My brief said | The agent measured | Cost if unchecked |
|---|---|---|
| Subtract the datum from the **socket** so socket and meshes share a frame | The socket is the side that is RIGHT — `Mount_Weapon_L at (+0.81,0.00,+0.41)` is sane; the hull 15 m to one side is not. That repair is already recorded as tried and rejected at `export_part_library.py:1487-1501` | Would have made each file self-consistent and left geometry exactly as wrong |
| Compose the mesh-to-bind delta as `R_arm⁻¹ · R_mesh` | That is the delta in the armature's own axes and leaves dims 1.593 m off; the one that composes is `R_mesh · R_arm⁻¹` in world axes | A "fix" that measurably does not fix |
| The ledger's quoted regex is wrong and returns 380 | The live regex at line 81 returns 292 correctly; the wrong one is a *different* instrument for a different quantity, already self-corrected in place | An edit inserting a causal explanation the file's own evidence contradicts |

The third is the sharpest: the agent refused to edit and said *"forcing this specific fix onto either existing passage would insert a causal explanation the file's own evidence contradicts."*

### 1.3 A false alarm I raised was killed by a verification dispatch

I reported that `export_part_library.py --only` was not run-to-run reproducible, based on an agent's side observation (51 files one run, 29 the next). I held two verified fixes back on that basis and boarded it as high priority.

It was false. Two runs into **clean** directories: 41 files compared, 40 byte-identical; the single difference is `manifest.json` embedding its own `--out` path, identical once normalised. **The exporter never purges `OUT_DIR`** (`:3495` is `makedirs(exist_ok=True)`), so both original runs wrote into the same directory and 11 leftovers read as nondeterminism.

The store's value here was the *discipline*, not a record: the brief said "reproduce it first; if it does not reproduce, say so plainly — that is a valid and valuable answer."

### 1.4 H1's rotation-note restore worked exactly as designed

Session opened with the note injected and consumed single-shot, carrying the exact next slice, five risks, and pointers. **One of its facts was wrong** (see §3.1) but the mechanism did its job: I would otherwise have started from a 202-item board.

---

## 2. FRICTION

### 2.1 H19's frontier check is unusable in any project with a generated-output directory

Every time I opened a rendered plate — the core deliverable of this session — H19 fired:

> "STERLING FRONTIER SIGNAL (H19): territory 'tools/blender/out/seated/Heavy_Cockpit_Heavy/…__front.png' is UNOWNED — no owning article exists in the store."

Counted in my transcript: **6 firings**, one per plate `Read`. **All 6 are false positives by construction.** `tools/blender/out/` is gitignored at `.gitignore:74` **by an explicit user ruling** that generated plates must live in a gitignored folder. A record can never own those paths, so the warning can never be actioned, and H10 will "demand the owning article at session end" for territory that must not have one.

**Cost:** ~150 tokens per firing plus the cognitive cost of re-deciding each time that it is safe to ignore. **A warning that is always wrong trains you to ignore the channel.**

### 2.2 H19 stayed silent at the one moment it mattered — and that silence caused the session's worst error

The gate quoted in §1.1 lived in the article's `files[].role` for `game/spike/mech_seated_plate_probe.gd`. H19 delivers an article when you touch a file it owns.

**Consuming a probe's OUTPUT touches no governed path.** `Read` of a gitignored PNG → "UNOWNED, there is no knowledge to deliver." `SendUserFile` is not a hooked tool at all. So every delivery mechanism in the system was silent while I did precisely what the store forbade.

The two failures are the same design in two directions: **H19 fires on paths, and the thing being gated was an ACT.**

### 2.3 H20's subject-axis delivery ran ~20 times at high cost and low yield

Every dispatch drew a block of 3 anti-patterns + 5 decisions, matched on token overlap with the brief. Sampling my transcript, the matched terms are frequently generic — one delivery matched on `"item, directory, part, stage"` and returned records about stale absence claims and multi-stage probe preconditions, neither relevant.

Estimated **~2,500–3,500 tokens per dispatch × ~20 = 50–70k tokens**, and I can identify **two** occasions where it changed what I did.

⚠ It also fires *after* `AskUserQuestion` returns, labelled "POST-ANSWER AUDIT, NOT A GATE." That is honest but structurally odd: it tells you a settled ruling may contradict the answer you have already taken.

### 2.4 H10 counted agent edits as my uncaptured work

Three separate Stop-hook firings said "direct-mode work touched 2 file(s) but nothing was captured." On at least two, **the touched files were being edited by dispatched coders, not by me** — `game/spike/mech_seated_plate_probe.gd` and `game/spike/track_uv_probe.gd`. I was deliberately not committing them because racing an agent's edit lands a half-file.

The hook has no notion of "a file is currently held by an in-flight agent," so its capture demand fires against work whose author has not finished.

### 2.5 H14 denied `git log` to a debugger investigating a commit history question

Verbatim from the agent: `H14: command not on the allowlist: 'git -C ... log ...'`. It recovered by reading `.git/logs/HEAD` directly — a workaround that worked but is fragile.

This is defensible (git is conductor-only here) but the agent had been asked *when a fix landed*, which is a git question. The allowlist has no read-only git carve-out.

---

## 3. WRONG INFORMATION

### 3.1 The rotation note carried a wrong number into the session's first hour

The note said "279 is dead, it is 278 measured; 4 rendered, 274 left." An agent building the key list from the tracked ledger measured **278** and reported the discrepancy rather than forcing the number:

> "Minus '4 already rendered': **could not identify any — the ledger explicitly contradicts this premise.** *'Existing plate coverage of the 292 is ZERO.'*"

The "4 already rendered" was wrong. The rotation note is written by the previous session's conductor and nothing validates it.

### 3.2 A supersession chain made a LIVE gate read as stale

The gate cited `anti_pattern 0d3ca823`. Following it:

- `0d3ca823` → `status: "superseded"`, `superseded_by: 5fc265a8`
- `5fc265a8` → `status: "superseded"`, `superseded_by: 72d92a0e`

**Two hops.** A reader who stops at hop one sees a dead record behind a live gate and concludes the gate is dead. Worse, the terminus **reversed the cause**: `0d3ca823` says our exporter *invented* a rotation; `72d92a0e`'s title says it *"was not invented, it was the SOURCE FILE'S value kept because nobody read the one the vendor authored."* Same gate, opposite fix.

### 3.3 Records I wrote that were wrong

Stated plainly, because the rest is not credible without it:

- **I described a real measurement with the wrong noun** and propagated it into a decision the user ruled from: *"`Mount_Weapon_L` 15.0000 → 0.0000."* **No socket moves.** Every socket's local position is byte-identical before and after; the 15 m is the *geometry's* displacement from its own part origin. Corrected forward.
- **I stated the defect's direction backwards.** The 15 m is the *currently shipped* state; the fix removes it.
- **I raised the reproducibility alarm** (§1.3) and boarded it high-priority on one agent's unverified side observation.
- **I gave the user a confident wrong explanation for a defect** — twelve arm plates described as "the vendor mounts arms to the legs," which is actually a seating bug that puts the part at the world origin.

### 3.4 A board item described itself as the worst item on the board

`c0c379ea`, the objective tracker, opened: *"THIS ITEM'S ORIGINAL HEADLINE WAS FALSE AND IT WAS THE MOST MISLEADING ITEM ON THE BOARD. It told a fresh session the asset pack was NOT YET CHOSEN and the work must NOT START — while the swap is most of the way done."*

I then made it stale **twice more within the same session** — once by rendering 51 more parts, once by lifting a gate it had just been told to record. Nothing detects that a board item has been overtaken.

---

## 4. TOO MUCH / TOO LITTLE

| Delivery | Size | Fraction used |
|---|---|---|
| H1 session-start convention block | 10.3 KB, **spilled to a file** | ~20% |
| H20 per-dispatch delivery | ~2.5–3.5k tokens × ~20 | ~10% |
| H19 per-`Read` article delivery | ~1–9.9 KB; one spilled to a file | high when it fired on a real path |
| `knowledge_get` on a feature_article | `probes-mech-assembly-seating` returned ~15 `files[]` entries, several 3 KB+ | ~15% — I needed one role field |

**The `knowledge_get` case is the sharpest.** To read one `files[].role` I pulled the entire 15-entry article. The read that answered my question was maybe 600 tokens inside a payload an order of magnitude larger.

**Contrast — the best-value delivery in the session:** `knowledge_edit` with an array selector, `field: "files[path=game/spike/track_uv_probe.gd].role"`. Targeted, refuses on ambiguity, returned a digest receipt with `chars_before`/`chars_after`. **This is what the read side should look like.**

---

## 5. HOOK-BY-HOOK

| Hook | Fired | Verdict |
|---|---|---|
| **H1** rotation restore | 1 | **Worked.** Carried one wrong fact (§3.1) that nothing validates. |
| **H1** deep-queue notice | 1 | Accurate: 17 drainable + 12 file_parked. A librarian closed 9. |
| **H4** test-writer blindness | 0 | Not exercised — no tests authored. |
| **H7** reconcile marking | indirect | Queue items appeared correctly for touched articles. |
| **H10** capture demand | 4 | **Mixed.** Twice counted agent-held files as mine (§2.4). `no_capture` / `capture_pending` are the right escape hatches and I used both honestly. |
| **H14** subagent allowlist | several | **Correct but coarse.** Denied read-only `git log` to a debugger asking a git question (§2.5). Denied `python`/`node` to a sweep agent that then did the work with `grep` — arguably a better outcome. |
| **H19** path delivery | ~10 | **Both best and worst.** Delivered real hazard records on real paths. 6 unactionable firings on gitignored plates. **Silent at the one moment that mattered** (§2.2). |
| **H20** subject delivery | ~20 | **Lowest yield per token.** ~2 useful firings. |
| **H21** hand-write watch | 2 | **Correct both times** — both were single small-record touches, a named exception. Useful nudge, right threshold. |
| **Watchdog** | 5 | **High value.** Its mandatory enumeration (a–e) produced real dispatches every time. §1 (a) "what did the work that just landed INVALIDATE" caught my own stale board item twice. |
| **Nothing** | — | **No mechanism detected that I sent a user 14 plates against a standing gate.** Caught by a librarian's side comment. |
| **Nothing** | — | **No mechanism detected a board item going stale minutes after being written.** |
| **Nothing** | — | **No mechanism connected a probe's OUTPUT to the probe's own known defects.** |
| **Nothing** | — | **No mechanism flagged that I dispatched to agents structurally unable to do the work — 3 times, with `anti_pattern 55577e13` sitting in the store describing exactly that.** |

---

## 6. WHAT I DID NOT EXERCISE

Stated so this does not read as a review of everything:

- **Pipelines / gated runs** — conductor-direct throughout; `run_state`, `run_signal`, `agent_exit`, `handoff_*` were never used. Several agents reported "no active run — this text is the deliverable," which is the correct fallback.
- **`/sterling:cleanup`, `/sterling:init`, `/sterling:merge`, `/sterling:council`, the TUI dashboard, `/sterling:drain` as a skill** (I drove a librarian manually instead).
- **`knowledge_retire`, `knowledge_promote`, `knowledge_link`, `knowledge_preflight`, `concept_designed`, `maintenance_enqueue`, `board_update` for priority/file_keys.**
- **Domain stores / cross-project sharing** — two sibling projects are registered; nothing was shared.
