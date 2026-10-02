# Sterling plugin retrospective — 2026-08-18

**Part A: the session evidence.** The design review is the companion file,
`sterling-plugin-assessment-whole-system-2026-08-18.md`. Prior retrospectives exist for 2026-08-14, -15
and -17 (twelve files); I did not read them, so anything here that repeats an earlier complaint repeats
it independently.

**Session shape.** dome-farmer, branch `feat/asset-pack-swap`, from HEAD `8aafb89` to `fea18d5`.
Three commits. Work: a 392-row mech-asset visual inspection sweep — I opened roughly 20 rendered contact
sheets with my own eyes and ruled 35 ledger rows, drained the maintenance queue, and diagnosed two real
asset defects. Twelve subagents dispatched. Context reached 52.6% of a 1M window.

⚠ **What I did NOT exercise, so this reviews none of it:** pipelines/runs (`run_state`, `run_signal`,
phase execution), `/sterling:cleanup`, `/sterling:init`, `/sterling:merge`, `/sterling:council`, the TUI,
`knowledge_promote` (I declined 13 promotions but never called it), `knowledge_retire`, `handoff_*`.
Everything below is about conductor-direct mode, the hooks, the knowledge/board/maintenance tool surface,
and the agent roster.

---

## 1. Where it genuinely helped — receipts, and the best cases are where it caught *me*

### 1.1 H19 delivered an anti-pattern that made me withdraw a FAIL verdict I was about to ship

The strongest single moment. On editing `docs/mech-asset-inspection-log.md`, H19 delivered
`21e3270c` — *"A SUBJECT-HIGHLIGHT PLATE ANSWERS WHICH PART IS THE SUBJECT AND NOT WHETHER IT IS
ATTACHED — at whole-machine zoom a correctly seated part reads as floating."*

I had just written, from a wide contact-sheet cell, that `Humanoids_Arm_R__Mech_Walker_Arm_R_Med` was
**floating free above a detached machine**. The record's trigger paragraph matched my reasoning almost
word for word. I opened the tight cell instead of writing the verdict: **the arm is plainly attached.**
Its host `Legs_Lt` is a shorter chassis, so at `pad=2.40` the arm filled the frame and the torso fell
far below it.

**A false FAIL on a shipped asset row would have gone into a tracked ledger and been trusted by every
later session.** Nothing else in the stack — not the probe's own assertions, not the suite, not a
reviewer — could have caught it, because every structural check on that plate was green.

### 1.2 H20 handed the right hypothesis to a debugger before it started

Dispatching an Opus debugger at *"why do some seated parts render pale and see-through"*, H20 fired on
the prompt's subject and delivered `c6d539c2` — *"A double-sided material HIDES reversed triangle
winding."* My brief's own leading hypothesis was cruder (negative scale plus backface culling). I
forwarded the record to the agent with a note to test it first.

The final diagnosis landed on exactly that flag: `doubleSided:true` in **359 of 361** exported `.gltf`
files, which Godot imports as `cull_mode = CULL_DISABLED`. **H20 is the only mechanism in the stack that
looks at a dispatch prompt rather than a file path**, and this is the case that justifies it — no path I
had touched owned that knowledge.

### 1.3 H3 blocked an edit on stale read-evidence, and it was right

```
H3 [direct mode]: no fresh read-evidence for 'docs/mech-asset-inspection-log.md' — Read the exact
file before editing. Evidence EXPIRES WHEN THE FILE CHANGES (read-time content hash vs current bytes)
```
A subagent had rewritten the file between my read and my edit. Content-hash expiry, not timestamp
expiry, is the correct design and it caught a real race. One extra `Read`, no damage.

### 1.4 The `knowledge_create` dedup gate forced me to justify a record

```
this anti_pattern overlaps existing '21e3270c' … Dice similarity 0.32 >= 0.3 …
Distinct lesson: re-submit with dedup_override: true.
```
The record I was writing genuinely was distinct — same symptom, **opposite remedy** — but the gate made
me write that distinction into the record itself before overriding. The override escape hatch with a
named flag is the right shape: it refuses by default and costs one argument to proceed.

### 1.5 H1's queue count was right and mine was wrong

H1 reported *"19 drainable items"*. I enumerated the queue by hand and briefed an agent with **18**,
missing `5f32c356`. The agent re-enumerated, found 19, and said so. H1's number was correct.

---

## 2. Friction

### 2.1 H19 has no ignore-file awareness, and it fired ~20 times on PNGs

Every single plate I opened produced:
```
STERLING FRONTIER SIGNAL (H19): territory 'tools/blender/out/sheets/sweep09/tight/sheet_03.png'
is UNOWNED — no owning article exists in the store.
```
`tools/blender/out/` is **gitignored at `.gitignore:74`** and is this project's designated scratch tree
for generated plates. It currently holds **2,922 PNGs**. Opening plates is the core activity of this
milestone, so the signal fired on ~20 of my most important reads and was noise every time.

**The check has no notion of "generated", "gitignored", or "binary".** A frontier warning on a `.png`
is never actionable — an image cannot have an owning article in any useful sense.

### 2.2 H10 then escalated the same non-problem into a Stop-hook demand

```
H10 article demand (§6): 25 touched file(s) have no owner … ["tools/blender/out/sheets/sweep02/parts.txt",
… sweep21/parts.txt"]
Create or extend the owning article(s) NOW
```
Twenty-five gitignored scratch batch files. I answered it by writing a standing decision
(`5e617854`) that no file under that tree gets an owner — which is the right durable answer, but I had
to spend a real authored record to silence a hook about files that are one `git clean` from not
existing. **The same ignore-awareness gap as 2.1, escalated from advisory to blocking-flavoured.**

### 2.3 H21's hand-work streak counter fired on the one activity that cannot be delegated

```
H21 hand-work streak: 10 distinct hand-work action(s) (reads + searches) since the last dispatch …
Delegate the remaining reads/searches.
```
Nine of those ten were `Read` calls on rendered plates. This project's CLAUDE.md says opening pictures
is the one duty that *cannot be delegated even in principle*, because it is exactly the judgement a
subagent structurally cannot make. **H21 counted the conductor doing its irreducible job as a delegation
failure.** The counter cannot distinguish "read a source file an agent should have summarised" from
"looked at an image".

### 2.4 H20's payload is large and its hit rate was about 1 in 15

Every dispatch — I made twelve — carried two or three full anti-pattern excerpts (trigger + right_way,
~1.5–3 KB each) plus five decision pointers. Call it ~3 KB × 12 ≈ **36 KB of delivered records**. Two
were decisive (§1.2, and `fa874551` arriving too late to help). Most were topically adjacent and unused:
a dispatch about applying ledger verdicts drew records about ammo belts, dome sky rendering and worker
personalities.

### 2.5 Four H19 deliveries were large enough to spill to a file

`Output too large (11.8KB)`, `(15KB)`, `(11.3KB)`, `(10.5KB)` — all on touches of one file,
`docs/mech-asset-inspection-log.md`, which is owned by several hazard records. When a delivery spills,
its content is *not* in context; only a preview is. So the largest deliveries are the ones least likely
to be read.

---

## 3. Wrong information — including mine

### 3.1 I misclassified a ruling as a defect. Twice. In two artefacts.

The contact sheet refuses cells with `vendor host 'X' is not exported (manifest row exists=true)`. I
wrote into the tracked ledger and into a new board item that this was *"an EXPORT GAP in our pipeline …
the most tractable of the three [causes]"*.

**It is not a defect at all.** A census applying the reader's own predicate found **11 such hosts, every
one `held_back: true, failed: false`**, each held back by a named ruling (duplicate-twin suppression, a
chassis dropped from v1, assembly-not-a-part, vehicle-not-a-mech-part, non-bipedal deferred).

⚠ **The store already contained the exact anti-pattern for this**: `fa874551`, *"A DELIBERATELY
HELD-BACK ROW AND A FAILED ROW ARE INDISTINGUISHABLE IN THE FIELD EVERYONE CHECKS."* **Nothing delivered
it**, because I was reading a probe's stdout and a `.txt` log — artefacts no article owns and no hook
watches. I found it only when an agent's census contradicted me.

### 3.2 I wrote an anti-pattern whose central claim was false, and nothing stopped me

I created `9fce1899` asserting that three cockpit parts *looked* detached but were fine — a slim
invisible column explaining their height. A per-mesh measurement an hour later refuted it outright:
there is no column, the void is real (**+1.03 m to +3.74 m**), and the parts are defective. I rewrote it
as `235d0ea3`.

**The record was accepted with no measurement behind its central claim.** The dedup gate checked whether
it duplicated another record; nothing asked whether it was *true*.

### 3.3 My brief's hypothesis was wrong and an agent corrected it

I briefed a debugger with a "self-eviction" lead: the failing parts are members of `_CHASSIS_BY_PACK`.
I claimed it covered 2 of 4 victims. The agent measured: **it covers 1 of 4.** `Heavy_Cockpit_Heavy` is
in the table but all five of its failing cells route through a different path, so the table is never
reached — a coincidence of membership. The real predicate is *"the reference machine already contains
the subject"*.

I had explicitly told the agent not to report the story as the answer unless it explained all four. It
didn't, and said so. **The brief instruction worked; my hypothesis did not.**

### 3.4 My brief asserted a row's state wrongly, and the agent refused rather than obeyed

I told a coder that `Humanoids_Cockpit_Humanoid_Lvl1` was `N` and to leave it. It was already `Y` from a
2026-08-16 ruling. The agent left column 3 untouched **and told me**, which meant only my appended prose
was wrong and I could fix it in one edit.

### 3.5 A board item and the inherited rotation note both carried stale counts

Board `3074cd0d`, the entry point for this whole milestone, carried *"392 rows, **188 `Y` / 204 `N`**,
independently re-measured 2026-08-18"*. By mid-session it was **229 / 163**. The rotation note carried
the same stale pair. Nothing connects a quoted number in a board item to the artefact it measures.

### 3.6 A subagent hit a `--path game` failure that another subagent did not

One debugger reported it could not run the Godot gate because its Bash cwd was
`tools/blender/out/sheets/sweep08`, so the allowlisted relative `--path game` could not resolve — exactly
anti-pattern `6d399cd3`. A different debugger in the same session reported `ls -d game` → `game`, i.e.
**its cwd was the repo root**. Same agent type, same session, different working directories.

---

## 4. Too much / too little information

| Delivery | Volume | Fraction used |
|---|---|---|
| H20 on 12 dispatches | ~36 KB of record excerpts | 2 records decisive (~1 in 15) |
| H19 on ~20 PNG reads | ~4 KB total, all "UNOWNED" | **0** |
| H19 on `mech-asset-inspection-log.md` | 4 deliveries spilled to file (10.5–15 KB) | 1 decisive (`21e3270c`) |
| H1 session start | conventions + rotation note + queue depth | high — the rotation note was load-bearing |
| `knowledge_get` on one article | **63,945 characters**, overflowed to a file | needed 1 fact |

**The single largest information failure was not volume — it was a miss.** Decision `a6dcef0a`
(2026-08-16) already contained the complete diagnosis of the cockpit void, proven "6 of 6 exact to six
decimal places", including the vendor's 0.335 m overlap and the ruling that *"the remaining work is
therefore the export fix alone"*. I dispatched an Opus debugger which spent **157,903 tokens and ~10
minutes** re-deriving it. It added exactly one genuinely new fact (the export fix has not reached the
artefacts). Roughly **80% of that dispatch was redundant with a record already in the store.**

Neither H19 nor H20 surfaced it: H19 fires on file touches and I was looking at PNGs and logs; H20 fired
on the dispatch but matched different records.

---

## 5. Hook-by-hook

| Hook | Fired | Verdict |
|---|---|---|
| **H1** SessionStart | 1 | **Valuable.** Restored the rotation note and consumed it. Queue count (19) beat my hand count (18). |
| **H3** contract gate | 1 | **Correct.** Blocked an edit whose read-evidence had expired by content hash after a subagent rewrote the file. |
| **H4** test-writer blind | 0 | Not exercised — no tests authored. |
| **H7** reconcile enqueue | not observed as a message | Cannot assess. |
| **H10** capture / article demand | 2 | **Mixed.** The capture demand was correct and I captured. The 25-file article demand was pure ignore-awareness noise. |
| **H14** subagent allowlist | indirect | Worked; one agent's cwd made an allowlisted relative path unresolvable (§3.6). |
| **H19** knowledge delivery | ~25 | **1 decisive save**, ~20 pure noise on gitignored PNGs, 4 spilled to file. |
| **H20** dispatch-axis delivery | 12 | **1 decisive save.** ~36 KB delivered, ~1 in 15 useful. Unique capability, poor precision. |
| **H21** write watch + hand-work streak | 4 | Write watch correct and unobtrusive. **Hand-work streak fired on plate-opening, the one undelegatable duty.** |
| **Nothing** | — | **My "export gap" misclassification, twice** — `fa874551` existed and described it exactly. Trigger was reading a probe log; no mechanism watches non-source artefacts. |
| **Nothing** | — | **An anti-pattern accepted with a false central claim** (§3.2). No record type asks whether an assertion was measured. |
| **Nothing** | — | **A 10-minute Opus dispatch re-deriving an existing decision** (§4). No pre-dispatch check against the store. |
| **Nothing** | — | **Stale numbers in a board item and a rotation note** (§3.5). Nothing binds a quoted count to its source. |
| **Nothing** | — | **Twelve dispatches, no cost surfaced.** Total subagent spend was ~1.4M tokens; I learned that only by adding up individual reports afterwards. |

---

## 6. What the session says about the plugin, in one line each

- The **delivery mechanisms are the best part** and their **precision is the worst part**.
- The store's **content quality is genuinely high** — every record that reached me was well written and
  right. The problem is *reaching* the right one.
- **Nothing in the system knows what a generated artefact is**, and in an asset-heavy project that is
  most of what gets touched.

The design assessment, including what is structurally missing and what Sterling does not attempt at all,
is in `sterling-plugin-assessment-whole-system-2026-08-18.md`.
