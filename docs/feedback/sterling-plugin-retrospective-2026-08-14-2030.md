# Sterling plugin retrospective — 2026-08-14, evening session

**Project:** dome-farmer (Godot 4.6 + Blender asset pipeline). **Branch:** `feat/asset-pack-swap`.
**Session shape:** ~4 hours, 4 commits, ~20 subagent dispatches, ~15 store writes.
**Subject matter:** swapping the game's mech from one vendor asset pack to another.

⚠ **A retrospective for today already exists** at `sterling-plugin-retrospective-2026-08-14.md` (earlier
session). This is a separate file per the never-overwrite rule; I did not read the earlier one.

Every claim below cites something from this session. Where I could not measure something, I say so.

---

## 1. Where it genuinely helped

### 1.1 H20 delivered the exact defect record on the first dispatch — this was the session's single best moment

Dispatching a `coder` to fix a socket-placement bug, H20 fired with:

> ⚠ ANTI-PATTERN [WARN] — 'A PLACEHOLDER TEST THAT ASKS "IS IT AT ITS PARENT" INSTEAD OF "IS IT AT THE
> ORIGIN" — the proxy holds only while the parent sits at the origin, and the one node whose parent does
> not is read as deliberate authored intent'

That record named the exact line (`export_part_library.py:1838`), contained the corrected code in its
`right_way` field, and carried the vendor's authored value. **I had dispatched a read-only explorer
seconds earlier to diagnose the same thing; it came back and confirmed the record was already the
answer.** H20 saved a full diagnostic round on a bug that had already shipped once.

This is the strongest possible case for subject-axis delivery: the record was attached to a *mechanism*,
not to the path I was about to touch, so path-scoped H19 could not have found it.

### 1.2 H19's hazard delivery caught a live instance mid-edit

Editing `game/ui/garage.gd`, H19 delivered `04b71626` (gdformat rejects a multi-line `print("..." % [...])`
written the natural way). Two separate agents this session hit exactly that and reported hand-fixing it —
the record predicted the failure before either dispatch.

### 1.3 The `alternatives_rejected` field is the highest-value field in the schema

Twice this session, reading `alternatives_rejected` changed what I did:

- Decision `dd3e780d` ("the preview slice is built first") — its rejected list contained the option I was
  about to recommend, with the reason it lost. I stopped.
- Decision `4a94a17e` — its rejected list contained, **verbatim, the gate I had already shipped.** That is
  how I discovered my own error (§3.1).

No other field has that property. A `statement` tells you what was decided; `alternatives_rejected` tells
you what you are about to re-propose.

### 1.4 The vendor-authority convention, encoded as records, beat my judgement five times

Records `3e3a20d6` / `5c0b0948` / `4a94a17e` encode a user ruling that the asset vendor's authored data
outranks our measurement. This session that ruling was vindicated **five times**, each time against a
plausible-sounding engineering read of mine:

| # | Our reading | Reality |
|---|---|---|
| 1 | A socket value is a meaningless placeholder | Our test measured distance from the *parent bone*, not the origin |
| 2 | Six accessory parts are unplaced | Four are placed — on a host prefab nobody had looked at |
| 3 | A part has no mesh, hold it back | It is a Unity *prefab variant*; our parser cannot see through the hop |
| 4 | Our heuristic assigns mounts sensibly | The vendor contradicts it on **54 parts** |
| 5 | This mount name reads as an animation rig, not a socket | User overruled; no exception exists |

**This is what the store is for.** None of it is in the code.

---

## 2. Friction, and where the plugin made things worse

### 2.1 H19's "UNOWNED territory" signal fires on gitignored render output — ~10 times

Every time I opened a rendered plate to inspect it — which is this project's **core mandated discipline** —
H19 fired:

> STERLING FRONTIER SIGNAL (H19): territory 'tools/blender/out/seated/mount_cockpit_ruling/Lvl1__…png' is
> UNOWNED — no owning article exists in the store. H10 will demand the owning article at session end.

`tools/blender/out/` is gitignored by project ruling (decision `323b4954`) and contains **2,922 PNGs**.
None of them will ever have an owning article. The signal fired on at least 10 plate reads and was
correct zero times.

**Suggested fix:** H19's frontier check should skip paths matching `.gitignore`. One `git check-ignore -q`
per path, or a config key `frontier_ignore_globs`.

### 2.2 H10 counts file READS as "touched", so visual inspection triggers capture demands

H10 fired *"direct-mode work touched N file(s) but nothing was captured"* on turns where the only
"touching" was **opening PNGs to look at them** and dispatching agents. I filed `no_capture` /
`capture_pending` three times purely to satisfy it.

`no_capture` and `capture_pending` are good escape hatches and I used them honestly. But the demand
itself was miscalibrated: looking at a picture is not a change.

**Suggested fix:** exclude binary/image extensions from H10's touched-file set, or weight PostToolUse
`Read` lower than `Edit`/`Write`.

### 2.3 H1's injected conventions contradict the project's own CLAUDE.md on a live number

H1 injected at session start:

> Delegation: FIVE concurrent subagents is a CEILING…

The project's CLAUDE.md carries a user ruling from **the same day**: *"subagent ceiling is 15"* (decision
`3c77d757`). The template text is stale against a project ruling and could have caused under-dispatch —
which, separately, is exactly the failure I did commit (§3.3).

**Suggested fix:** H1 should read the ceiling from project config rather than hard-coding it in template
prose, or omit the number and defer to CLAUDE.md.

### 2.4 The librarian agent cannot touch the board

`librarian`'s tool list has `maintenance_query` / `maintenance_remove` and the `knowledge_*` surface, but
**no `board_add` / `board_update` / `board_remove`.** The board and the maintenance queue are both `todo`
records differing only by `source`, so this reads as an oversight rather than a design line.

Cost this session: I did two board writes by hand (a ~2,400-word rewrite and a removal) at conductor
token rates, at 57% context fill, precisely when the plugin's own pressure notice was telling me to
delegate mechanical work.

**Suggested fix:** give `librarian` the three `board_*` tools. It already has the more dangerous
`knowledge_update`.

### 2.5 Agent tool lists are not surfaced at dispatch time

I dispatched an `explorer` to run `git log` / `git merge-base` over 10 queue items. `explorer` has no
Bash. The agent burned ~69k tokens, salvaged 8 of 12 answers from stored evidence, and correctly reported:

> **BLOCKER — I have no git-execution tool in this session.** `ToolSearch` for `"bash"`, `"git"`,
> `"shell"`, `"execute"`, `"terminal"` returned no callable tool.

That was my error. But H20 already fires a PreToolUse hook on every `Agent` dispatch and reads the prompt
— it is well placed to catch it.

**Suggested fix:** H20 warns when a brief contains shell-command syntax and the target `subagent_type`
lacks Bash. Cheap regex, high value; this is `anti_pattern 55577e13` and it recurs.

---

## 3. Wrong information — including mine

### 3.1 ⚠ THE BIGGEST FAILURE: a superseded decision is indistinguishable from a live one in query results

I wrote an agent brief instructing a gate — *"a placement counts only if it resolves AND the parent is a
named `Mount_` node"* — and justified it by citing decision `e822ec54`.

**`e822ec54` is superseded by `4a94a17e`.** That superseding record contains, in `alternatives_rejected`:

> *"SCENE PARENTS — accept it only when the parent's NAME is informative … and refuse an anonymous
> grouping node"* → **DECLINED.**

It also records that the user was shown the exact consequence by name and kept the broader ruling, and
ends: **"Do not re-raise it."**

**Cost: 39 rows of vendor placement data withheld from the shipped manifest**, in commit `bf79999`. Every
gate check passed, the suite stayed green at 908, and the artifact was internally consistent and quietly
wrong. It was found only because an unrelated re-derivation mentioned it in passing.

**Why the plugin could not save me, and this is the actionable part:** the project's own CLAUDE.md states
that *"query results omit the supersedes chain (see `supersedes_count`)"*. So:

- `knowledge_query` results do not show `superseded_by`.
- H20's decision deliveries are pointers with a title snippet — no supersession marker.
- Only `knowledge_get` reveals it, and a superseded record still resolves and still reads authoritatively.

**Suggested fixes, in value order:**
1. **Never return a superseded record from `knowledge_query` without a marker.** A `status` of
   `superseded` (alongside `active`) in the projection would have been enough.
2. **H20/H19 should refuse to deliver a superseded record as a pointer**, or deliver the superseding one
   in its place with a note.
3. Consider a `knowledge_preflight`-style check on agent briefs: extract cited record ids from the prompt
   text and warn on any that are superseded. H20 already parses the prompt.

### 3.2 Four exact-duplicate maintenance items from one finding — a hook is over-firing

The `file_parked` lane held 12 items covering **9 unique paths**. Four of them were identical — same
article (`probes-mech-rig`), same path (`game/spike/mech_posed_silhouette_probe.gd`), same branch claim —
written at four different timestamps.

Separately, a librarian observed item `529be840`'s `updated_at` move from `19:24:44` to `20:06:36`
**with unchanged text, during its own drain.**

**Suggested fix:** dedupe queue items on `(system_reason, article, path)` at enqueue time.

### 3.3 `file_parked` items reached the wrong conclusion on 4 of 12

Each said an owned file was *"absent from the working tree but alive on `feat/<branch>` — INFORMATIONAL,
no reconcile owed."* Conductor-run git showed otherwise:

```
game/spike/mortar_arc_probe.gd         543a314  828 deletions  -> REACHED MAIN
game/spike/playtest_mortar_probe.gd    543a314  264 deletions  -> REACHED MAIN
game/spike/mortar_death_freeze_probe.gd 543a314 390 deletions  -> REACHED MAIN
game/test/mech/part_catalog_test.gd    1fa576f  546 deletions  -> NOT in main
```

Three are **retired files whose deletion is merged**; the articles claiming them are stale. The fourth is
inverted — deleted on the current branch, alive on main.

The check the item performs answers *"does a copy exist somewhere"*. The question is *"which side of the
divergence is authoritative"*. This project already has an anti-pattern for it (`4cd022bd`).

**Suggested fix:** `file_parked` detection should run `git merge-base --is-ancestor <last-commit-touching-path> main`
and classify DELETED-AND-MERGED separately from PARKED-ON-BRANCH. It is one extra git call at enqueue.

### 3.4 A promotion happened against a standing, unsuperseded user ruling

User ruling `38cb77d8` (2026-07-29), verbatim: *"Dont promote any knowledge"*, `superseded_by: null`.
Adjudication `b9e6cac5` (2026-08-13) nonetheless promoted one record, citing only the older
question-scope test and never retrieving the standing ruling. Same failure class as §3.1, three weeks
apart, with no mechanism between them.

### 3.5 Records I wrote or briefed that were wrong

Stated plainly, because the rest of this document is only credible with them:

- The `is_named_mount` gate (§3.1). Mine, shipped, cost 39 rows.
- I told the user the eyeball queue would "fall a long way" once vendor data landed. **It went 47 → 48.**
  I asserted a direction without measuring it.
- I briefed that a part's `scale x = -1` was a placement override and a mirror. The agent measured that
  it is the host socket's own scale, and that **not one of the 14 real overrides has a negative
  determinant** — the nearest has two negatives and is a 180° rotation.
- I gave four wrong line numbers in a brief (`1275/1879/2862/2892`; actual `2446/2450-2451/2859-2863`).
- I answered a watchdog with *"nothing worth dispatching"* while three disjoint jobs were available; the
  user corrected me in four words.

Three of five were caught **by agents contradicting my brief**, which is the single most valuable
behaviour in the whole system.

---

## 4. Too much / too little information

H19 and H20 deliveries were frequently **10–17 KB**. Three were large enough that the harness persisted
them to disk rather than inlining:

> `Output too large (17KB). Full output saved to: …hook-toolu_…additionalContext.txt`
> `Output too large (16.7KB)…` `Output too large (10.3KB)…`

A representative H20 delivery carried 3–4 full anti-pattern bodies plus 5 decision pointers. **Typically
one of those was relevant.** Rough estimate: 60–80% of delivered hook text went unused. Over ~20
dispatches this is a large fraction of a context window.

The `matched on:` keyword lists undermine confidence in the ranking — one read:

> matched on: game, mech, four, name, part, user, authored, vendor, many, placements…

Single common words. When the ranking signal is `game` and `four`, the delivery is closer to random than
the format implies.

**Suggested fixes:**
1. Deliver **trigger + record id** by default; full `wrong_way`/`right_way` only on `knowledge_get`.
2. Cap deliveries at 2 records, ranked, and say how many were suppressed.
3. Drop stopwords from `matched on`, or hide it below a relevance floor.

**Counterpoint, and it matters:** the one delivery that paid for all the others (§1.1) was a *full* body
including `right_way`. A pointer would not have saved the round. Perhaps: full body for `[WARN]`-severity
records, pointers for the rest.

---

## 5. Hook-by-hook

| Hook | Fired | Verdict |
|---|---|---|
| **H1** (session start) | 1 | Useful, but injected a **stale subagent ceiling (5)** contradicting a same-day project ruling (15). |
| **H4** (test-writer isolation) | 0 | No `test-writer` dispatched. Nothing to report. |
| **H7** (reconcile on touch) | many | Worked — but generated 19 `reconcile_needed` items of which **12 were already paid**, i.e. mtime noise from a wholesale asset regeneration. |
| **H10** (capture / article demand) | ~8 | **Mixed.** Article demands were right twice (two new probes had no owner). Capture demands fired on turns whose only "touch" was reading PNGs (§2.2). |
| **H14** (subagent Bash allowlist) | — | No denials observed. The quoting asymmetry it enforces (Godot unquoted, Blender quoted) was stated in every brief and cost nothing this session. |
| **H19** (path-scoped delivery) | ~15 | Good hazard hits; **frontier signal ~10 false positives on gitignored plates** (§2.1). |
| **H20** (mechanism-axis delivery) | ~20 | **The best hook in the set** (§1.1) and the most token-expensive (§4). Did not flag a superseded citation (§3.1). |
| **H21** (article-write watch) | 5 | Correct and well-calibrated. It nudged me toward `librarian` dispatches, which I then did. No false positives. |
| **Watchdog cron** | ~6 | Not a plugin hook (session cron), but see §7. |
| **⚠ Nothing** | — | **No mechanism caught the superseded-decision citation** — the session's most expensive error. |
| **⚠ Nothing** | — | **No mechanism caught that a correct reader's output had no consumer.** A tool resolved 349/349 vendor placements into a JSON that `export_part_library.py` never opened. Every component was individually green. |
| **⚠ Nothing** | — | **No mechanism caught a test asserting a feature's ABSENCE** (`resolves == false`, justified as *"a verified zero per the work order"*). It went red the day the feature shipped, and the failure was indistinguishable from a regression. |

---

## 6. What would have helped, ordered by value

1. **Mark superseded records in every projection.** `knowledge_query` and H19/H20 must not hand a reader a
   dead record that reads live. This cost the most this session, and §3.4 shows it recurring. (§3.1)
2. **Warn on cited-but-superseded record ids in agent briefs.** H20 already parses the prompt at
   PreToolUse; extracting uuids and checking status is cheap. (§3.1)
3. **Give `librarian` the `board_*` tools.** It already holds `knowledge_update`. (§2.4)
4. **`git check-ignore` before H19's frontier signal.** Kills ~10 false positives per session in any
   project with a render/output directory. (§2.1)
5. **Dedupe maintenance items on `(reason, article, path)` at enqueue.** (§3.2)
6. **`file_parked` must ask whether the DELETION reached main**, not whether a copy survives. One extra
   git call. (§3.3)
7. **Trim hook deliveries to trigger + id by default**, full body only for `[WARN]`. (§4)
8. **H20 warns when a brief needs a tool the target agent type lacks.** (§2.5)
9. **Exclude image/binary reads from H10's touched-file count.** (§2.2)

---

## 7. Other — what worked about the contract itself

- **"A subagent result is evidence, not a verdict"** paid three times. An explorer reported `0 matches`
  for a symbol appearing **24 times**; my own `grep -c` contradicted it. A second agent independently
  "confirmed" the same false claim. Without the standing rule, a stale board item would have been
  corroborated with a fresh date on it.
- **Requiring the conductor to open renders personally** caught two defects nothing else could: a
  produced-but-broken icon set (a producer that validated *after* `save_png`, leaving 8 known-bad files on
  disk with the log reporting `failures=8`), and an on-screen label telling the player *"fitting an
  accessory does not yet change what is rendered"* — false, and visible in the game. **No test reads that
  string.**
- **Briefs that end with "if this contradicts what you read, STOP and report — the ruling wins over this
  brief"** produced three corrections to my own instructions, including two measured refutations. Agents
  use that permission when it is explicit and (in my experience) do not when it is not.
- **The watchdog cron misread was mine, not the plugin's**, but the mechanism is worth reporting: at 54%
  context fill I answered *"nothing worth dispatching"* and justified it with the plugin's own hard-pressure
  notice — reading *"do not open substantial new work"* as a global stop, while ignoring the same
  sentence's *"and DELEGATE remaining reads and mechanical work to subagents"*. **Those are one
  instruction.** If the pressure notice put the delegate clause FIRST and the restriction second, the
  misread would be harder. Cheap wording change, real effect.

---

## 8. Verdict

**Strongest part: H20's mechanism-axis delivery, and the `alternatives_rejected` field.** H20 handed me a
record that named the exact broken line and its fix on the first dispatch of the session, and that record
was attached to a *concept*, not a path — nothing path-scoped could have found it. `alternatives_rejected`
is doing work no other field does: it is the only place that tells you the thing you are about to propose
has already been refused, and it is how I caught my own worst error.

**Weakest part: superseded records are invisible until you fetch them individually.** A dead decision
resolves, reads authoritatively, and gets cited into an agent brief that then re-imposes exactly what the
user rejected. It cost 39 rows of authored vendor data in a shipped commit, passed every gate, and was
found by luck. Section §3.4 shows the same shape three weeks earlier with a different record. **This is
one field in one projection.**

**Top suggestion: put supersession status in every projection, and let the hooks refuse to deliver a dead
record as though it were live.**

Honest overall: the plugin caught more of my errors than it caused, and the ones it caught were the
expensive kind — a shipped-broken asset set, a lying UI string, a stale board claim corroborated by a
second agent. The friction is real but mostly mechanical and mostly cheap to fix. The one structural gap
is supersession.
