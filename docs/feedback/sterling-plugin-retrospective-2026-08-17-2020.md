# Sterling plugin retrospective — 2026-08-17, evening session (20:20)

**Evidence base:** one session in `dome-farmer` (Godot 4.6 + GDScript + Blender), branch
`feat/asset-pack-swap`, HEAD `6da5270` throughout — **nothing was committed**, so every claim below is
about store and tool behaviour, not about code that shipped.

**Two workloads, deliberately different in shape:**
1. **A full maintenance-queue drain** — the user opened with *"actually start the drain. get that queue
   to zero. having it so high is redicules"*. 102 items, eight parallel lanes.
2. **One build slice** — running an authored-but-never-run clearance probe to close two acceptance
   criteria on a procedural weapon recoil.

The drain is the better evidence for the plugin, because it exercised almost the whole tool surface in
anger. The slice is the better evidence for the hooks.

**Prior retrospectives exist** on this desktop for 2026-08-14, -15 and -17 (three today already:
unsuffixed, `-1045`, `-1820`). I did not read them; this is a fresh account. The companion design review
is `sterling-plugin-assessment-whole-system-2026-08-17-2020.md`.

**What I did NOT exercise, and therefore do not review:** pipelines/runs (`run_state`, `run_signal`,
`agent_exit`, phase execution), `/sterling:cleanup`, `/sterling:init`, `/sterling:merge`, the council, the
TUI dashboard, and `knowledge_link`. Anything I say about those would be from documentation, so I say
nothing.

---

## 1. WHERE IT GENUINELY HELPED

### 1.1 H20 stopped me from corrupting eleven articles — the single most valuable event of the session

This is the case that justifies the whole subject-axis delivery mechanism, so it gets the detail.

I had reasoned my way to a confident, wrong conclusion. 42 of the 102 queue items were `file_parked`,
each saying an owned file was *"absent from the working tree but ALIVE on `feat/<branch>` —
INFORMATIONAL"*. I checked the branches with `git branch --merged main` and found that
`feat/boot-state-machine`, `feat/farm-selection-panel` and `feat/meals-and-quotas` were **all merged**. I
then verified with `git ls-tree` that the files existed on `main` and confirmed each was absent at HEAD.

My conclusion: the "informational" gloss is stale, these are real drift, strip the dead paths. I wrote a
detailed brief and dispatched a librarian at eleven articles.

**H20 fired on the dispatch and delivered `4cd022bd`:**

> *"A `file_parked` item whose branch claim is TRUE can still reach the WRONG conclusion — the file lives
> on some branch, and the DELETION is the thing that reached main… THE TELL IS THAT YOU ONLY ASKED WHERE
> THE FILE EXISTS, NEVER WHERE THE DELETION WENT."*

That is exactly what I had done. The deletion commit `bd0c18a` is in the `main..HEAD` range — **not
merged**. `main` was still authoritative, the items were correctly parked, and my brief would have
stripped 24 live path entries from 11 articles. It also delivered `84751127` ("Absence from the working
tree is NOT deletion — the store's file checks are branch-relative"), which states the consequence.

I halted the agent with `SendMessage`. **Zero writes had landed** — it was still in its read phase, and
the one `knowledge_update` it had attempted was independently refused by the permission classifier.

**Why this is the strongest possible evidence for the design:** nothing else in the stack could have
caught it. The queue item's own text argued *for* my error. Git agreed with me on every question I
thought to ask. The only thing that knew was a prior incident record, and the only reason it reached me
was that H20 matches on the *subject* of a dispatch prompt rather than on files touched. A path-scoped
hook would have been silent — I had not touched any of those paths.

### 1.2 The store caught a false prohibition that was blocking real work

`mech-part-export`'s `files[].role` for `tools/blender/mech_port/fit.py` carried a standing gate:

> *"⛔ DO NOT RE-EXPORT INTO `game/assets/mech_parts/` FROM `b35f9c0`"*

with a supporting clause: *"Because no re-export has run, every statement here still describes the
SHIPPED assets correctly."* An agent found the contradiction — the same article's `what_it_does` recorded
a full conductor-run re-export on 2026-08-17 — and correctly refused to resolve it, because only git
could, and it had no git.

Two commands settled it: `b653279` ("The exporter tests the premise it was guessing, and the wheel stays
on") fixed the defect, and `git merge-base --is-ancestor b653279 a8c6b9e` confirmed the fix preceded the
full re-export. The gate had been discharged for hours.

**This is a failure mode worth naming: a stale record that does not cause a wrong answer, it *prevents
correct work*.** It would never surface as a bug. It just quietly makes a safe operation look forbidden.
`4f0f99a9`-style detection cannot see it, and neither can any test.

### 1.3 Agents' constraints produced better results than freedom would have

Three cases, all from constraints the plugin imposes:

- The `librarian` cannot author content. When I halted it, it reported precisely which writes had landed
  (none) rather than trying to self-heal.
- The `test-writer` is walled off from implementation by H4. It therefore could not quietly reproduce the
  tautology it was hired to remove, and when it hit a case it could not assert without reading the
  implementation, it **said so and left the assertion out**, flagging the decision.
- A `debugger` given a command it could not execute **reported a checked, evidenced blocker** instead of
  improvising around H14. Its report named the exact refusals (`cd` not on the allowlist, chaining
  denied) rather than saying "permission error".

### 1.4 The two-clock `research_finding` and the promotion test did real work

Of eleven `promotion_review` items, exactly **two** promoted. The nine that did not were closed with
stated reasons, and the agent flagged a genuine limitation rather than forcing a call: four of the nine
carry a *portable method half* (e.g. *"ask is-it-in-main, not which branch holds a copy"*) wrapped around
a local payload of twenty dome-farmer item ids. `knowledge_promote` retires the original, so promoting
would have exported the ids and lost the local content. **That is a real gap in the promotion model**
(see the assessment file, §8).

---

## 2. FRICTION, AND WHERE IT MADE THINGS WORSE

### 2.1 H19 fired six times on gitignored PNGs, and was wrong every time

Every plate I opened produced:

> *"STERLING FRONTIER SIGNAL (H19): territory `tools/blender/out/recoil_clearance/…/rest.png` is UNOWNED —
> no owning article exists in the store… H10 will demand the owning article at session end if this work
> lands here."*

**This project has a standing user ruling that all generated plates go in a gitignored directory**, and
2,922 PNGs live there. They are unowned *by design* and can never be owned. The hook has no ignore-file
awareness, so in any project with a render or report output directory it produces guaranteed noise on
exactly the artefacts the conductor is required to inspect by hand.

Worse, the threat is hollow but not obviously so — "H10 will demand the owning article at session end"
invites you to pre-empt it by creating a junk article.

### 2.2 The maintenance queue's own count misled me at session open

H1 injected: *"MAINTENANCE QUEUE IS DEEP — 60 drainable items … plus 42 file_parked (close at branch
merge, not by drain — excluded from this count)."*

The real total was **102**, confirmed by `maintenance_query cap:400` returning `matched_filter: 102,
capped: false`. The 60 was itself a capped read. I only discovered the true depth because I habitually
raise `cap` — an operator who trusted the injected summary would have drained 60 and stopped.

**A summary that is silently capped is worse than no summary**, because it reads as an inventory.

### 2.3 Two agents wrote the same article concurrently, and nothing prevented it

I partitioned eight lanes to be record-disjoint. It leaked anyway: I permitted the `article_missing` lane
to *extend an existing article of its choosing*, and it chose `probes-mech-assembly-seating` — the very
article another lane was splitting for being oversize. The append pushed it from 64,013 to 67,276 chars
and auto-queued a **new** `article_oversize` item while the split was in flight.

I caught it only because the appending agent mentioned the oversize warning in its report, and I warned
the splitting agent by `SendMessage`. **This is my briefing defect, and the plugin gave me no way to
avoid it:** there is no record-level lock, no "who is writing what" query, and no advisory warning when a
second writer touches a record another agent touched minutes ago.

### 2.4 A subagent was structurally unable to run the project's own toolchain

The `debugger` I sent to re-run the probe could not run it at all. Its Bash cwd was
`.../tools/blender/out/recoil_clearance`, not the repo root. `--path game` resolves against process cwd;
`cd` is not on the H14 allowlist; chaining with `&&` is denied; and the allowlisted Godot prefix is a
**literal string containing `--path game`**, so no absolute path can be substituted without breaking the
prefix match.

Result: a whole dispatch produced no execution. The agent recovered gracefully — it found the probe's own
`probe_log.txt` on disk and transcribed the verdicts, cross-checking two values against ones I supplied —
but that was luck, not design.

**The toolchain contract assumes a cwd it does not establish or verify.**

### 2.5 H15 blocked a legitimate read, correctly, with no sanctioned alternative

I tried `cat .sterling/config.json` to look at a detector threshold. H15 refused:

> *"H15: shell access to the Sterling store is denied — the store is read and written through the §10 MCP
> tool surface ONLY."*

That is the right call and I did not route around it. But **there is no MCP call that reads config.** The
gate is correct and the door it points at does not exist for this purpose. I abandoned the threshold
question and fixed the underlying ownership instead — which was the better fix anyway, so no harm here,
but the gap is real.

---

## 3. WRONG INFORMATION — INCLUDING MINE

This section is the honest counterweight. **Three of the wrong things below are mine.**

### 3.1 Records that were wrong (found and fixed this session)

| Record | Claimed | Measured | How it was found |
|---|---|---|---|
| `mech-assembly-graph` | 45 bases, 190 attach-bearing, 15 fittable | **61 / 321 / 9** | Agent re-ran the article's own probe |
| `mech-assembly-graph` | `mounts_on_basis` is "a closed set of four" | **seven values**, summing to 392 | Manifest parse |
| `demo-scene-mount-reader` | *"NOT YET WIRED IN… the manifest is not regenerated from it"* | **189 of 392 rows** carry its basis | Manifest parse |
| `mech-part-export` | ⛔ standing re-export prohibition | Discharged by `b653279` hours earlier | Conductor git check |
| `mech-part-export` ×2 roles | *"THERE IS NO `fire_clip` FIELD"* | True for the singular; **`fire_clips` non-empty on 59 rows** | Agent read the manifest |
| `mech-part-seater` | *"`garage.gd` is the intended consumer and does not call this yet"* | Calls it at `garage.gd:3147` and `:3159` | Agent grep |
| `mech-control` ×2 | `mech_controller.gd` *"sits at exactly 1600 lines against a hard cap"* | Carries a per-file exemption; **6134 lines** | Agent `wc -l` |
| `mech-control` | Owns key bindings R, Q, E, X | Q and E deleted the same day and reassigned | Agent read the file |
| `farm-radio` | `CallKind` has 13 members at `:73-87` | **16 at `:101-118`** — third time this number was wrong (11→13→16) | Agent `grep -c` |
| `farm-radio` | `BEDS_SHORT` reuses `DAMAGE_1`'s clip | Reuses `PEOPLE_IN_DANGER`'s | Agent read the file |
| `probes-mech-assembly-seating` ×2 | *"⚠ DELETED 2026-08-15 at `bd0c18a`. This file no longer exists."* | **Both files exist at HEAD** | Agent filesystem check |
| `probes-mech-assembly-seating` | A duplicate `files[]` entry *"was folded into this entry and removed 2026-08-15"* | The fold was **recorded but never executed**; both entries still present | Agent counted |
| `multiplayer` | Owns six `game/spike/mps_*.gd` files | `probes-multiplayer` **already owned all six** — double ownership since 2026-07-29 | Agent query |

The `farm-radio` row is the most instructive: **both commits that added the missing enum members are
recorded in that article's own `history`**, and neither corrected the count in the prose. The audit trail
was complete and the summary was still wrong.

### 3.2 Wrong things I produced

**(a) My `file_parked` premise** — §1.1. Would have damaged 11 articles. Caught by H20, not by me.

**(b) I misattributed a probe failure.** I told the user, and wrote into an agent brief, that two families
saved no plates because they failed a projected-area floor. I had seen `REJECTED - area 0.0879 below the
0.15 floor` lines in the output and associated them with the wrong families. The debugger checked and
contradicted me loudly, as instructed:

> *"Neither family has **any** `REJECTED - area` line… Both fail at **seating**, before framing ever
> runs: `!! PROBE_INVALID … PROMOTED TO ITS OWN BASE (form=promoted_root)`."*

The area rejections belonged to a third family that then succeeded at two other angles. **A brief is read
by every agent in a fan-out; this one was read by one, and it still cost a wrong premise.**

**(c) I under-counted my own lane.** My weapons brief said 17 items and enumerated 18. The agent
reported the discrepancy rather than silently working to my number.

### 3.3 An agent's wrong number that reached the store

A reconcile agent measured `game/weapon/missile.gd` at **1523 lines** and concluded its lint exemption was
unnecessary, writing both into `weapon-barrel-ring` v9. Two independent commands (`wc -l`, `awk
END{print NR}`) give **1682** — 82 *over* the 1600 cap, so the exemption is load-bearing and removing it
would fail the gate. The file had *grown*, not shrunk.

Cause: the count was asserted from a file `Read`, and a truncated read produces a **confident short
count** with no signal that anything was missed. I caught it only because I re-measure any number I am
about to put to the user as a ruling. I fixed it forward and recorded the mechanism.

**The same agent's other headline finding in the same report was correct** (the sniper recoil family
discrepancy, which I verified independently with `grep -rln` and put to the user). One report, one true
finding, one false one, both stated with identical confidence.

---

## 4. TOO MUCH / TOO LITTLE INFORMATION

**H20 deliveries are large.** Each `Agent` dispatch received roughly 4–6 full anti-pattern records
(trigger + a chunk of `right_way`, often 1.5–3 KB each) plus 5 decision pointers with their
`alternatives_rejected`. I estimate **4–8 KB per dispatch across ~14 dispatches**, so on the order of
70–100 KB of injected context.

**Fraction actually used: low, but the one that mattered justified all of it.** I acted on `4cd022bd` and
`84751127` (§1.1), noted `f915b279` and `b3c87ca1` when writing a new record, and used `e75bb3b3` in two
briefs. Call it 5 of ~60 delivered records. **I would not trade the 95% waste for missing `4cd022bd`** —
but that is an argument for better ranking, not for the current volume.

**Two deliveries were large enough to spill to a file:**
- H1's session-start context: **10.3 KB**, persisted to disk with a 2 KB preview.
- One `knowledge_query types:["decision"] cap:3`: **51.6 KB** persisted. Three records. It also reported
  `matched_filter: 474, capped: true` — I wanted one decision's family list and got three full bodies I
  could not use. `projection: "digest"` exists and I should have used it; the default is the expensive one.

**Where there was too little:** `maintenance_query` digest text is clipped mid-sentence with `…`, and the
`article_missing` items' clipped text **does not name the files**. I had to instruct an agent to re-query
with `projection: "full"` purely to learn which paths four items referred to. The digest omits the one
field the item is about.

---

## 5. HOOK-BY-HOOK

| Hook | Fired | Verdict |
|---|---|---|
| **H1** (session start) | 1 | Mixed. Rotation note restored cleanly and was accurate. Its queue count (60) was a **capped read presented as a total** (real: 102). |
| **H4** (test-writer blindness) | Enforced silently | **Positive.** Prevented the test author from reproducing the tautology it was hired to remove. |
| **H7** (reconcile marking) | Continuous | Worked, and **over-fired**: duplicate `file_parked` items for the same (article, path) pair appeared at 4+ distinct timestamps. 48 items represent ~24 distinct facts. |
| **H10** (capture demand) | 2 | **Positive.** Both fires were correct — real uncaptured work existed. `capture_pending` was the honest answer both times and the hook accepted it. |
| **H14** (agent command allowlist) | ~3 refusals | **Cost a whole dispatch** (§2.4). Correct in intent; the literal-prefix design plus an unestablished cwd makes it unusable from a non-root cwd. |
| **H15** (store shell guard) | 1 | **Correct refusal, no alternative path** (§2.5). |
| **H19** (path knowledge delivery) | ~12 | Split. Useful on `game/weapon/weapon_recoil.gd` — delivered the owning article with its ACs exactly when I was about to reason about them. **Six pure false positives on gitignored PNGs** (§2.1). |
| **H20** (subject-axis delivery) | ~14 (every dispatch) | **The highest-value mechanism in the plugin this session.** Caught an error nothing else could (§1.1). Also the most expensive (§4). |
| **H21** (hand-run article write watch) | 3 | Correct and non-blocking. All three of my hand-run writes were legitimate exceptions (live adjudication of a number I had just re-measured). The nudge is well-judged: it informs without gating. |
| **Post-answer audit on `AskUserQuestion`** | 2 | Fired *after* the answer both times, as documented. Neither contradicted the ruling. Genuinely useful as a check, structurally unable to prevent a bad question. |
| **Nothing** | — | **No mechanism detected that two agents were writing one record concurrently** (§2.3). |
| **Nothing** | — | **No mechanism detected that a `reconcile_needed` item was auto-drained before its reconcile happened** — found by an agent noticing a 9-second timestamp gap (§6). |
| **Nothing** | — | **No mechanism flagged that an acceptance criterion was a tautology.** A directional AC restating the implementation's own axis stayed green for the life of the feature while the behaviour was inverted. Only a rendered plate caught it. |
| **Nothing** | — | **No mechanism flagged an article's `history` silently rotating**, dropping the oldest entry at 21. The agent noticed the receipt; nothing warned the operator. |
| **Nothing** | — | **No mechanism noticed a record asserting a *prohibition* that had been discharged** (§1.2) — the class of staleness that blocks correct work rather than causing a wrong one. |

---

## 6. THE ONE SESSION FINDING WORTH SENDING UPSTREAM ON ITS OWN

**A `knowledge_update` re-baseline can auto-drain a `reconcile_needed` item BEFORE the reconcile happens.**

Observed with timestamps, during the drain:

- **19:03:36** — items `24427151` and `a044976c` (demanding `probes-mech-assembly-seating` stop listing
  two deleted files) were **auto-removed**. Trigger: a *different* agent's unrelated `files` append to
  that same article. The versioned write re-baselined `file_baselines` and the server drained matching
  drift items as a side effect.
- **19:03:45** — the agent actually assigned to those items read the article at v34 and **confirmed both
  dead paths were still listed.**

The queue recorded the reconcile as done **nine seconds before it happened**. It got fixed only because
someone was already assigned.

**The defect is that the drain keys on THE WRITE, not on WHAT THE WRITE CHANGED.** Any versioned write
re-baselines every file its record owns and closes every drift item naming those files — including files
the write never examined.

**It is self-concealing and it is worst exactly where drains are busiest.** The queue is the inventory of
what is owed; when it closes an item early the debt does not merely persist, it becomes *unfindable*.
Concurrency is the trigger, so a deep queue invites parallel drainage, parallel drainage causes early
closure, and early closure hides the remainder.

Captured as a `research_finding` and promoted to the shared `sterling` domain store this session.

---

## 7. THE DRAIN, BY THE NUMBERS

| Lane | Start | End |
|---|---|---|
| `reconcile_needed` | 41 | **0** |
| `promotion_review` | 11 | **0** |
| `article_missing` | 4 | **0** |
| `refresh_reference` | 3 | **0** |
| `article_oversize` | 1 | **0** |
| `capture_owed` | 1 | **0** |
| `state_review` | 1 | **0** |
| `file_parked` | 42 | **48** |
| **Total** | **102** | **48** |

**Every drainable lane reached zero.** `file_parked` grew by 6 through hook duplication, and the
remaining 48 represent ~24 distinct facts, all correctly parked pending a branch merge — a user ruling
taken this session after H20 corrected my premise.

**Signal-to-noise of the drainable 54:** roughly **19 already paid** (closed with no write), **31 real
prose defects** found and fixed, **4 structural** (missing owners, an oversize split). So about **57% of
the queue described work that genuinely still needed doing** — considerably better than the "expect it to
be mostly already-done" prior in this project's own conventions, and the errors it surfaced (§3.1) were
substantive rather than cosmetic.

**The queue misled in both directions**, which is the important nuance: items claiming work was
outstanding that was already done (19), *and* items whose "INFORMATIONAL: no reconcile implied" gloss
argued against work that — had the deletion been merged — would have been real.
