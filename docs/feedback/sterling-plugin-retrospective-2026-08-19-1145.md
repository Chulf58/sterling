# Sterling plugin retrospective — 2026-08-19, 11:45

**Project:** dome-farmer (Godot 4.6 + Blender, Windows). Sterling is CONSUMED here, never developed here.
**Session:** post-`/clear`, roughly 10:20 → 11:45. Branch `feat/asset-pack-swap`, `a060766` → `9ba466d`.
**Two commits landed.** Suite green at 1076/1076 across 86 suites.

⚠ **A prior retrospective exists for today** (`sterling-plugin-retrospective-2026-08-19.md`) plus an
assessment (`sterling-plugin-assessment-whole-system-2026-08-19.md`), from an earlier session. This is a
NEW file for a NEW session and does not revise them. The system-design half of this account is in
`sterling-plugin-assessment-whole-system-2026-08-19-1145.md`.

**What the session actually did**, so the evidence below has a shape to sit in: fixed a retry defect in a
render probe that had shipped hours earlier; took a Blender clip census from 221 to 280 clips; consolidated
a duplicated rule into one definition; and ruled six rows of a 392-row asset-inspection ledger by opening
plates by eye (353 → 359 `Y`).

---

## 1. WHERE IT GENUINELY HELPED — with receipts

I am putting the cases where Sterling caught **my own** error first, because those are the ones nothing
else in the stack could have caught.

### 1.1 ⭐ The single best save: a stored anti-pattern stopped me ruling from a poisoned plate

The ledger row for `Humanoids_Cockpit_Humanoid_Riser_Lvl3` ended with the instruction:

> *"Its plate is `sweep08/tight/sheet_04.png` — open it, then rule."*

An agent had surfaced that row as immediately actionable. I was one tool call from opening it. What stopped
me was `anti_pattern bfc53113`, delivered by H19 on my touch of the ledger, which records that any plate
rendered before the lights-follow-camera fix is contaminated and **must be re-rendered, not opened**.

I checked instead of opening:

```
plate written : 2026-08-18 23:32:01
commit 239e313: 2026-08-19 05:31:32   (lights follow the camera)
```

**The plate predated the fix by six hours.** Had I opened it, I would have ruled a 392-row ledger entry
from a known-invalid image, and the ledger's own text would have been my justification. Nothing else in the
stack — not the suite, not lint, not the probe's own structural gates — could have caught that. It is a
pure knowledge-base save.

### 1.2 An anti-pattern handed me a one-command test that resolved an ambiguous plate instantly

Opening the `Humanoids_Gadget_Saw` plate, I saw a large flat saturated orange square. `anti_pattern
2234bfaf` (delivered by H20 on the dispatch, then again by H19 on the file) describes exactly that
symptom — effect cards shipping inside hardware parts — and prescribes the decisive check:

```
grep -oE '__FX_[A-Za-z0-9_.]*' game/assets/mech_parts/Humanoids_Gadget_Saw.gltf
→ (nothing)
"name":"Gadget_Saw_Arm_Geom.001" / "Gadget_Saw_Base_Geom.001" / "Gadget_Saw_Blade_Geom.001"
```

No FX geometry. The orange square was the 1 m reference cube — the render convention's own furniture. **The
record turned a plausible wrong diagnosis into a settled question in one command.** Without it I would
have reasoned about missing textures or dropped alpha, which is precisely the three-wrong-diagnoses trap
that record was written to close.

### 1.3 H3 blocked an edit I had no right to make

I had `grep`-ed four ledger rows and went straight to `Edit`:

> `H3 [direct mode]: no fresh read-evidence for 'docs/mech-asset-inspection-log.md' — Read the exact file
> before editing. […] Grep/Glob hits are not read-evidence.`

**Correct catch.** I was about to edit a 4,500-line tracked ledger from grep output. Cost: one `Read` of
one line. This is the cheapest true positive of the session.

### 1.4 `55c513ac` led me to falsify a citation in an otherwise flawless agent report

A librarian returned a correct, careful report — both edits matched exactly once, both queue items drained,
it volunteered an oversize warning nobody asked about, and it counted the queue itself rather than
asserting. It explained the auto-drain as *"confirmed by decision `8ecd435f`'s versioned-write re-baseline
behavior."*

`anti_pattern 55c513ac` says a decision id is the one claim in a report that is falsifiable in one call.

```
knowledge_get 8ecd435f → no record … at any status — and no slug matches
```

**Second recorded instance of that exact failure, with the exact same phantom id.** See §3.4 — the
mechanism behind it is the most interesting finding in this document.

### 1.5 H10 was right four times out of four

H10 fired four times demanding a capture after file-touching work. On every occasion something durable had
genuinely happened and was sitting only in my context or in a harness task description:

| firing | what it forced out |
|---|---|
| 1 | `decision f755a2e4` — a conductor shape call that existed only in a task description |
| 2 | `anti_pattern b523b471` — the session's most reusable finding |
| 3 | correction of that same anti-pattern after its control failed |
| 4 | `anti_pattern 27073600` — the sibling-control method |

**Zero false positives.** Of these, the shape call is the one that would definitely have been lost — the
harness task list dies with the session, and I had parked a real design decision in it.

### 1.6 The dedup gate refused a near-duplicate and named the override path

```
knowledge_create: this anti_pattern overlaps existing '552a0bbf…' (Dice 0.36 >= 0.3,
assisted by a shared file_key (the false-positive-prone branch …)).
Same finding: knowledge_update that record. Distinct lesson: re-submit with dedup_override: true.
```

This is good error design and rare: it states the score, states the threshold, **names which branch of its
own heuristic is unreliable**, and gives both remedies. I judged the lesson distinct and overrode. A gate
that tells you how much to trust it is worth more than a gate that is merely right.

### 1.7 The librarian's constraint produced a better result than a free hand would have

Briefed to append a `history` entry to a `reference_material` record, the librarian hit a schema refusal and
**stopped rather than guessing a substitute field**:

> *"I did not retry with a guessed field (e.g. `summary`). `reference_material` has no array field for a
> running log — this contradicts the drafted plan's premise."*

My brief was wrong. An unconstrained agent that "helpfully" wrote into `summary` would have hidden my error
and produced a malformed record. **The roster's "never author content" constraint is doing real work.**

---

## 2. FRICTION — where it fought the task

### 2.1 H15 blocked my very first command of the session

```bash
git log --oneline -3 && git status --short | head -20 && ls .sterling/
```
→ `H15: shell access to the Sterling store is denied`

The gate matches **command text**, so `.sterling/` appearing anywhere in a compound command kills the whole
call, including the `git log` that had nothing to do with the store. The hook's own message discloses this
(*"a store path appearing only as PROSE … trips it too"*), which is honest, but it cost a full round on the
first action after a `/clear` — the exact moment a session has least context to spare.

### 2.2 The frontier signal fired on every gitignored image I opened

Every plate I read produced:

> `STERLING FRONTIER SIGNAL (H19): territory 'tools/blender/out/seated/…/…__closeup.png' is UNOWNED — no
> owning article exists in the store. […] H10 will demand the owning article at session end if this work
> lands here.`

**That directory is gitignored** (`.gitignore:74`), by an explicit project rule that all generated plates
live there precisely because they are disposable. I opened roughly eight plates; that is roughly eight
identical false signals, each carrying a threat of an end-of-session demand that cannot be satisfied and
should never be raised. Detail in the assessment file, §2.

### 2.3 H19's repeat delivery on one file was the session's largest single token drain

`docs/mech-asset-inspection-log.md` is one file. I touched it six times (three reads, three edits). Each
touch delivered the same set of ~5 anti-patterns, and each was large enough to be spilled to disk:

```
Output too large (14.5KB) … 15.6KB … 12.9KB … 12.1KB … 11.0KB … 10.7KB
```

**≈76 KB of hook output for one file, of which the novel content after the first delivery was zero.** I used
four of those records all session (`bfc53113`, `2234bfaf`, `c156f3e8`, `4447cbee`) and had them after the
first firing.

### 2.4 H20's post-answer audit arrives after the decision it is auditing

On my `AskUserQuestion` about vendor sub-range animation clips, H20 fired with:

> *"you have just put a CHOICE TO THE USER. The store already governs this subject […] **THIS IS A
> POST-ANSWER AUDIT, NOT A GATE — it reaches you with the answer, never before the ask** (probed
> 2026-08-11)."*

The hook knows it is too late and says so. In this case the ruling was genuinely novel, so no harm. But the
stated purpose — stop me spending the user's decision rights on a settled question — is structurally
unreachable in the current wiring.

### 2.5 H21 fired four times, all four on legitimate exceptions

Every hand-run article write I made was one of the three exceptions the hook itself names (a small authored
create, a write needing live adjudication, a single small-record touch). Four advisory firings, zero
actionable. Cheap, but it is pure noise at a 4/4 rate.

---

## 3. WRONG INFORMATION — including mine

### 3.1 A live board item cited three record ids that do not exist

The goal tracker (`5728b586`) lists three board items as *"probably closeable"*. All three:

```
knowledge_get 804c4efb → no record … at any status
knowledge_get 6cb0dcb7 → no record … at any status
knowledge_get fedbbe22 → no record … at any status
```

They were closed some time ago. **The item that names them opens with a warning that it has been wrong four
times** — and it was wrong again, in the same way, about three more things. Its `garage.gd` line citations
were also stale: it says `:1883`, `:1284`, `:2824`; measured values are `:2113`, `:855`, `:3159`.

### 3.2 I made the campaign tracker stale twice in one session — the second time within four hours

This is the most damning item in the document and it is mine.

At roughly 10:33 I rewrote the campaign tracker (`3074cd0d`) with corrected counts (`353 Y / 39 N`), a
re-counted FX total (11, not the 12 it claimed), a replacement for a dead "roughly 27 rows" figure, and a
new six-group taxonomy of the unruled rows. I labelled it conductor-measured.

By roughly 11:27 that rewrite was wrong: the ledger had moved to `358/34`, and **three of the eight rows I
had personally filed under "no fittable vendor host" turned out to need nothing built.** I rewrote it again.

**The record whose header warns "this has been wrong three times, re-derive before quoting" acquired its
fourth error from the person who had just written that header.** `anti_pattern 4c7a977a` predicts exactly
this — a staleness warning sharing one body of text with the thing it warns about is documentation, not a
control — and it predicted it about me, four hours in advance, and I did it anyway.

### 3.3 Two articles asserted a premise that had been falsified three minutes after they were written

Both `asset-swap-mech-census` (written 05:27:27Z) and `mech-part-export` (05:27:14Z) contained a passage
saying a source docstring *"still"* claims a gate reports 35, warning readers not to copy that figure
forward. Commit `914465e` at **05:29:59Z** corrected that docstring to 34.

**The warning was accurate for about three minutes and then silently inverted.** Their line citations had
rotted too — `:1119-1146` → `~1141-1168`, `:1232-1237` → `:1254-1259`, `:1681-1682` → `:1703-1704`.

### 3.4 ⭐ A warning record is propagating the fabrication it warns about

`anti_pattern 55c513ac` documents an agent citing a non-existent decision id, and quotes the example
verbatim in its trigger: *"per decision `8ecd435f`, this is a re-baseline, not a content rewrite"*.

This session a librarian cited **`8ecd435f`** — the same id — to explain auto-drain behaviour. It does not
exist.

**H19 and H20 deliver that record to any agent touching a governed store path. The record's own trigger text
puts the phantom id into the agent's context, wearing store authority. The agent then emits it as a
citation.** The warning is the vector.

It is also harder to catch the second time: the 2026-08-15 instance used the citation to justify breaking a
rule, so the citation was suspicious. Here the agent broke no rule and did everything correctly — only the
explanation was invented. I appended this to the record and marked the string contaminated.

### 3.5 My own errors, listed plainly

| my error | how it surfaced | cost |
|---|---|---|
| Briefed a librarian to `knowledge_append` a `history` entry onto a `reference_material` | Schema refusal; the type has no `history` field | one librarian round |
| Claimed a keyword sweep had cleared the ledger of instrument-scoped blocks | It found 2 already-governed rows and missed **all three** real ones | I published a control that did not work, then corrected it |
| Read a 217-line `probe_log.txt` when I wanted the image | Realised on reading it | pure context waste, no information gained |
| Relayed a confident hypothesis (`core.autocrlf` storm) to a lane | Lane tested and **refuted** it: `core.autocrlf=false` repo-local | none — the lane did its job |
| Ruled `XL_Throne` FAIL before opening its sibling control | Noticed retrospectively when I opened `XL_Worker` | correct verdict, no defence; recorded as luck |

The sweep failure is the worst of these because I asserted it in a durable record. The correction is now in
that record, including the two reasons it failed.

---

## 4. TOO MUCH / TOO LITTLE INFORMATION

**Too much, and repetitively.** Measured deliveries this session that were large enough to spill to disk:

| source | size | novel content |
|---|---|---|
| H1 SessionStart conventions | 10.1 KB | first delivery only |
| H19 on the ledger × 6 | 10.7–15.6 KB each, ≈76 KB total | first delivery only |
| H20 on dispatch × 5 | ≈3–5 KB each, inline | genuinely useful on 2 of 5 |

**Estimated fraction used:** of the ~86 KB of H19/H1 delivery, the content that changed a decision was four
anti-patterns, all available after the first firing — call it under 10%, and near 0% after the first touch
of each file.

**Too little, in one place:** H19 pointers on `Bash` give an id and a title but not the substance. That is
documented and defensible, but it means a Bash-driven survey reads as "governed, go look" without ever
saying what the governance is — and a tired session will not go look.

---

## 5. HOOK-BY-HOOK

| hook | fired | verdict |
|---|---|---|
| **H1** | 1 (SessionStart) | Worked. 10.1 KB spilled to file. Conventions block is largely duplicated by CLAUDE.md. |
| **H3** | 1 block | ✅ **True positive.** Stopped an edit backed only by grep evidence. Cheapest good catch of the session. |
| **H4** | 0 | Not exercised — no test-writer dispatched. |
| **H7** | indirect | Reconcile items appeared correctly for every file the session's commits touched, including three new ones within minutes of the consolidation commit. Working. |
| **H10** | 4 | ✅ **4/4 true positives.** Forced out one decision that existed only in a dying harness task list. Best value-per-firing in the system. |
| **H14** | 0 observed | Agents ran allowlisted commands successfully; no denial reported. |
| **H15** | 1 block | ⚠ **False positive.** Killed a compound `git` command because `.sterling/` appeared in it. |
| **H19 (file)** | ~10 | Mixed. One outstanding save (§1.1) and ≈76 KB of repeat delivery on a single file. |
| **H19 (frontier)** | ~8 | ❌ **All false.** Fired on gitignored render output; threatens an end-of-session demand that cannot be satisfied. |
| **H19 (Bash pointers)** | ~3 | Worked as documented. Pointers only. |
| **H20** | 5 dispatches + 1 post-answer | 2 of 5 dispatch firings materially useful (`2234bfaf`, `4447cbee`). Post-answer audit fires after the decision, and says so itself. |
| **H21** | 4 | 4/4 advisory-only; every flagged write was a named exception. Noise, but cheap. |
| **Nothing** | — | ❌ No mechanism validated the three dead record ids in a live board item (§3.1). |
| **Nothing** | — | ❌ No mechanism caught the campaign tracker going stale **twice**, the second time four hours after I corrected it (§3.2). |
| **Nothing** | — | ❌ No mechanism noticed that two articles' premise was falsified three minutes after they were written by a commit in the same repo (§3.3). |
| **Nothing** | — | ❌ No mechanism flagged that a warning record is seeding the phantom id it warns about (§3.4). I found it by hand. |
| **Nothing** | — | ❌ Nothing connects a *board taxonomy* claim to the *ledger rows* it describes; three rows were blocked in a summary, and a sweep of the rows themselves found none of them. |

**The five "Nothing" rows are all the same shape: free-prose claims inside records — ids, counts, line
numbers, premises — that nothing validates.** That is the through-line of this session and it is developed
in the assessment file.

---

## 6. WHAT I DID NOT EXERCISE

Stated so this does not read as a review of the whole plugin:

- **Pipelines / runs** — `run_state`, `run_signal`, `run_escalate`, `agent_exit`, the phase machine, the
  disposal gate. Conductor-direct mode throughout; no run was opened.
- **`/sterling:cleanup`, `/sterling:init`, `/sterling:merge`, `/sterling:council`, `/sterling:drain`,
  the TUI dashboard, `/sterling:projects`.**
- **`knowledge_promote`, `knowledge_link`, `knowledge_retire`, `knowledge_preflight`, `concept_designed`,
  `handoff_read` / `handoff_write`, `no_capture`, `capture_pending`.**
- **Domain stores** (`~/.sterling/domains/<tag>/`) — never touched.
- **H4 and H14** — no test-writer ran, and no agent reported a denial.

I used, and therefore can speak to: `knowledge_create`, `knowledge_get`, `knowledge_query`,
`knowledge_edit`, `knowledge_append`, `knowledge_schema` (indirectly, via refusal messages), `board_query`,
`board_update`, `board_remove`, `maintenance_query`, `maintenance_remove`, the `librarian`/`coder`/`Explore`
agent types, and hooks H1/H3/H7/H10/H15/H19/H20/H21.
