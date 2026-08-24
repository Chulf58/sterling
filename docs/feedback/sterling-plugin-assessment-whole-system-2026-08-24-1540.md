# Sterling plugin — whole-system assessment

**Companion to:** `sterling-plugin-retrospective-2026-08-24-1540.md` (session evidence)
**Project:** dome-farmer (Godot 4.6 / GDScript / Blender), consuming Sterling; never developing it
**Date:** 2026-08-24, 15:40

This is a review of the plugin's **design**. The session is evidence, not subject.

---

## THE HEADLINE: one design decision caused most of this session's damage

**`h7-file-touch.mjs` enqueues a `reconcile_needed` item on any Edit/Write/MultiEdit to an
article-owned path, with no content check of any kind.** It blocked a merge with 207 items. When I
actually verified them, **two articles out of fourteen were stale.**

Everything else in this document is smaller than that. It is §10; read that first if you read one section.

---

## 6. The record type system

**The types carve the space well, and I would collapse none of them.** The distinctions that earned their
keep this session:

- **`decision` vs `anti_pattern`.** A decision records *what we chose and what we rejected*; an
  anti-pattern records *what goes wrong and how to avoid it*. I wrote one of each and they are genuinely
  different artifacts — `d50439ec` (a decision) settled whether a socket may re-expose; `672eda6a` (an
  anti-pattern) tells a future reader how a mutation check lies. Merging them would force one shape onto
  both.
- **`anti_pattern`'s four-field body — `trigger` / `guidance` / `wrong_way` / `right_way` — is the best
  schema in the system.** `trigger` is the field that makes delivery possible at all: it states *when this
  applies*, which is exactly what a hook needs to decide whether to surface the record. And `right_way`
  being separate from `guidance` forces the author to write the remedy, not just the diagnosis. When H19
  delivered `f7c5ff5d` to me mid-review, I used `right_way` verbatim in a brief.

**The single best field I used:** `anti_pattern.trigger`. Runner-up: `decision.alternatives_rejected`,
because `d50439ec`'s rejected-alternatives list contained the exact phrase *"inverts the vendor rule"*,
which settled a live question faster than its `statement` did. **A decision's rejected alternatives are
frequently more useful than its conclusion**, because the reader arriving later is usually about to
propose one of them.

**Dead weight I encountered:** `feature_article.live_test_refs` — I wrote `[]` because the honest answer
was "no test covers this", and the schema gives no way to say *"deliberately untestable, here is why"*.
That distinction matters (see §13.2). `derived_unconfirmed` I never used and cannot assess.

**A gap in the type space:** there is no record type for **a measurement that will expire**. My crosshair
drift figure (5.18 px peak) is resolution-dependent and meaningless at a different window size. I wrote it
into a board item with a hand-written "VERIFY ON PICKUP" section. Nothing in the schema knows it is
perishable.

## 7. Identity, versioning, supersession

**Durable citation works, and the slug is why.** `knowledge_get d50439ec` resolved on an 8-char prefix, and
CLAUDE.md's advice to *"resolve a decision by TITLE or SLUG, not by a remembered id"* held up: slugs
survived edits and supersession in every case I tested.

**But the surface I actually used does not distinguish live from dead as well as it should.** Two specifics:

1. `knowledge_create` returned a `same_subject` block listing five related records — genuinely useful, it
   is how I found `dfac5eb5` and linked to it. **But `same_subject` shows `title` and `type` and not
   `lifecycle` or `status`.** If one of those five had been retired, I could not have told from that block,
   and I would have linked a new record to a dead one.
2. `board_query` digests show `updated_at` but board items carry their own hand-written staleness markers
   ("REWRITTEN 2026-08-24", "STALE ANCHOR", "⚠ CORRECTED") **in prose, inside `text`**. The mechanism has
   no idea. Item `9d344f25` was `freshness: "fresh"` and `lifecycle: "live"` while being completely
   obsolete — it burned an Opus lane. **`freshness` tracks record edits, not world truth, and the field
   name actively misleads.**

## 8. The tool/API surface

**What took N calls that should take one:**

- **Writing one `feature_article` took three attempts** (§2.2 of the companion). `knowledge_schema` marks
  `id`, `created_at`, `updated_at`, `type` as `required: true` and the write then **rejects them as
  server-owned**. The schema tool exists to prevent learning by rejection and here it caused it.
  **Fix: `knowledge_schema` should return `required_from_caller` separately from `required`,** and mark
  server-owned fields inline.
- **`current_ac[].verifiable_at`** accepts `"final"` or a string; I passed `"windowed run"` and got
  `Invalid` with no statement of the accepted form. `history[].date` needs full ISO; `2026-08-24` was
  refused. **Neither constraint is discoverable from `knowledge_schema`'s output** — it reports the type as
  `literal "final" | string`, which reads as permissive.

**The operation the design obviously wants and does not have:** a way to close a maintenance item as
**verified-not-stale**. Today there are two outcomes — `knowledge_update` (bumps the version, claims a
reconcile happened) or `maintenance_remove` (silent deletion, no record that anyone checked). CLAUDE.md
itself names the problem: *"a version bump claiming a reconcile that added nothing is itself drift."* So
the honest outcome for 12 of the 14 articles I verified has no representation. **Fix: `maintenance_resolve(id,
verdict: "verified_current", evidence: "<what was checked>")`** — closes the item, writes no version, and
leaves a trace so the next session does not re-verify the same thing.

**What worked well:** `board_query`'s `matched_filter` / `cap` / `capped` triple is exactly right — it
tells you the queue is deeper than the window instead of letting you conclude from a truncated read. Every
paginated API should do this. `knowledge_get`'s `field` + `offset`/`length` windowing is a good answer to
the oversize-record problem.

## 9. The agent roster

**H4's read wall on `test-writer` produced a better outcome than an unconstrained agent would have**, and
this is the clearest design win in the roster. The test-writer refused twice:

1. It could not construct an `ArmWeaponGeometry` fixture because my brief omitted the type's shape. It
   said so and wrote nothing, rather than inventing field names that would have compiled and pinned
   nothing.
2. On the second attempt it found that `game/test/fx/muzzle_anchor_resolver_test.gd` and decision
   `32691c41` both hold that **no test has ever `add_child()`'d a `MachineGun`, and that must stay true**.
   It refused to seat a fixture rather than silently falsify a live decision's premise. I verified:
   `grep -rn "add_child(.*[Gg]un" game/test | wc -l` → `0`. **It was right.**

An unconstrained agent reading the implementation would very likely have written a plausible test that
passed for the wrong reason — precisely the hollow-test failure this project has shipped four times in one
day historically. **The wall converted a silent failure into a loud refusal.** That is the whole argument
for the roster's constraint model, demonstrated.

**Where the roster is wrong:** `explorer` lacks `board_query` (H25 correctly flagged this). The board is a
primary evidence surface in conductor-direct mode, and an exploration agent that can read the knowledge
store but not the board has an arbitrary hole in its view. I had to run that half of a hunt myself.

**A roster/harness mismatch:** H25 cannot check `Explore` at all — *"no installed agent definition was
found at `.claude/agents/Explore.md`"* — because it is a harness built-in, not a Sterling agent. It said
so on **every** `Explore` dispatch. The hook should recognise built-ins and stay silent.

## 10. The board and the maintenance queue — the section that matters

### The measurement

`direct-merge.mjs` refused: **207 open `reconcile_needed` items covering files this branch changed.**
Grouped by owning article (`grep -oE "reconcile (article|reference) '[^']+'" | sort | uniq -c`): **68
articles.** Top concentrations: 18 `probes-world-visuals`, 16 `probes-cockpit-hud`, 13 `probes-mech-rig`,
10 `probes-weapons-combat`.

I dispatched four read-only lanes to verify ~90 of those items across 14 articles. Result:

| | |
|---|---|
| Articles verified | **14** |
| Genuinely STALE | **2** (`front-end`, `front-end-plate-probe`) |
| Verified STILL TRUE | **12** |

**The 18-item `probes-world-visuals` block was a single mechanical refactor** — all 18 probes adopting a
shared `preload("res://spike/probe_out_dir.gd")` output-path helper. No probe's measured subject, output
directory convention, or catalogue entry changed. Eighteen merge-blocking items for one refactor that
invalidated nothing.

The two real ones were worth having: `front-end` claims `project.godot:15` still boots `res://main.tscn`
and the front end is unreachable; it now reads `run/main_scene="res://ui/front_end.tscn"`.
`front-end-plate-probe` claims `LOAD_LIST_BUILT` is false and `_open_load_list()` is a bare
`push_warning`; `front_end.gd:215` is `true` and the real screen is wired.

### The two mechanisms, and why only one is defensible

A diagnosis lane read the emitting code:

- **Arm 1 — "touched in direct mode"** (`h7-file-touch.mjs:6800-6839`, PostToolUse on Edit|Write|MultiEdit):
  when no run is active it looks up every article owning the touched path and **unconditionally enqueues**.
  There is **no content hash and no baseline check anywhere in this path**. `changedLineRanges` (`:6816`)
  computes only the cosmetic "near lines N-N" text and filters nothing.
- **Arm 2 — "changed on disk (out-of-band edit)" / "N owned files drifted"**
  (`packages/mcp-server/src/tools.ts` ~1082 and ~1150): mtime is only a pre-filter; it must **also** pass
  `contentChanged(path, file_baselines, treeRoot)`, a real hash comparison against the article's recorded
  baselines. **This arm is earned.**

Both dedup on `(system_reason, feature_link, file_keys)`, so repeat touches to one file collapse — but the
key includes `file_keys`, so **one item per distinct owned file**. The `probes-*` articles list every probe
script individually in `files[]`, which is why an 18-file refactor produces 18 merge blockers.

### Why this is a design fault and not a usage problem

**Arm 2 proves the plugin already knows how to do this correctly.** `file_baselines` exists, hashing exists,
`contentChanged()` exists — and Arm 1, the arm that fires constantly and blocks merges, does not call it.

The consequences compound:

1. **The queue's depth stops carrying information.** 207 items where ~15 were real means depth signals
   nothing, so nobody drains, so it deepens. The H1 injection already reported *"MAINTENANCE QUEUE IS DEEP
   — 247 drainable items"* and advised draining *"before taking new work"* — advice no session can follow
   at that size, which trains sessions to ignore it.
2. **It converts a merge gate into a toll booth.** The reconcile precondition (decision `9df61181`) is a
   good idea: do not merge with stale knowledge. But gating on an unfiltered touch-log means the gate
   fires on noise, and **the only ways past are hours of verification or mass deletion** — one of which
   trains the exact habit the gate exists to prevent.
3. **It punishes exactly the right behaviour.** An article that carefully lists all 18 of its probes in
   `files[]` generates 18 blockers. An article that lists none generates zero. **The mechanism rewards
   vague ownership.**

### The fixes, cheapest first

1. **Make Arm 1 call `contentChanged()` before enqueueing.** The function already exists and Arm 2 already
   uses it. On this session's evidence this alone removes the great majority of the 207.
2. **Add `maintenance_resolve(id, verdict: "verified_current", evidence)`** — see §8. Gives verification an
   outcome that is neither a lying version bump nor a silent delete.
3. **Group the merge gate's refusal by article.** It printed 207 near-identical lines (~40 KB); I reduced
   it to the real decision surface — 68 articles — with one `uniq -c`. The gate has the data.
4. **Let an article mark a path as `catalogued` rather than `described`** — the probe catalogues want "I
   list this file's existence and purpose", not "my correctness depends on this file's contents". Today
   `files[].role` is free text and the hook cannot read intent from it.

## 11. The conductor contract — enforced vs prose

**Enforced by mechanism:** the review-receipt trailer (`commit-reviewed.mjs` refuses with an empty ledger;
`direct-merge.mjs` refuses a code-touching commit without `Reviewed-By-Agent`); the reconcile precondition;
the H14 command allowlist; H4's read wall; H5's frozen paths; H24's gate-exit lint.

**Prose only, and load-bearing:**

- **"Verify by mutation."** Nothing checks that a mutation targets the diff. This session's most expensive
  near-miss (see companion §1.1) passed a mutation check that verified the wrong file.
- **"The conductor opens every image."** Nothing checks that a plate was ever read. A probe printing
  `PROBE_DONE failures=0` looks identical whether or not a human looked.
- **"Every brief carries a return contract."** Enforced by me typing it into each brief. It was the single
  biggest lever on my context this session — a 205k-token lane returned ~250 words — and there is no
  mechanism behind it.
- **"Re-verify a board item against HEAD before dispatching."** Unenforced; I skipped it and burned an Opus
  lane on already-shipped work.

**The highest-value unenforced rule is the mutation one**, because it is the only one whose violation
produces a *false green* rather than a missing step — and a false green is invisible by construction.

## 12. What is structurally missing (the design reaches for it and stops short)

1. **`maintenance_resolve` with a verified-current verdict** (§8, §10).
2. **`knowledge_schema` distinguishing caller-required from record-required fields** (§8).
3. **`same_subject` returning `lifecycle`/`status`** so a suggested link cannot point at a dead record (§7).
4. **A `perishable` marker on a measurement**, with the condition that invalidates it (§6).
5. **`explorer` granted `board_query`** (§9).

## 13. WHAT STERLING DOES NOT DO AT ALL — AND SHOULD

Ranked by damage caused **in this session**.

### 13.1 There is no mechanism that checks a mutation test actually targets the diff

**The incident.** The mandatory mutation check passed on two sabotages, both of `barrel_heat.gd`; the diff
changed `machine_gun.gd`. Replacing the production call with its exact pre-fix line — deleting the whole
fix — left the scoped suite **38/38 green**. Found by `reviewer-correctness` and, independently, by the
Codex outside-family reviewer. My own check had passed.

**The shape of the fix.** A hook at commit time, or a `mutation_check` field on the pre-commit path, that
takes the diff's changed files and asks: *does any named sabotage touch a file in this diff?* If not, warn:
`SABOTAGE TARGETS <file>, WHICH THIS DIFF DOES NOT CHANGE`. Purely mechanical — it needs the diff's file
list and the sabotage's target, both of which are already written down in the flow.

**The cost here.** Would have shipped an unguarded fix if the review floor had not existed. Cost two extra
review rounds and roughly three additional lanes to discover and then correctly disclose.

### 13.2 There is no way to record that a property is *deliberately untestable*, with its blocker

**The incident.** The production repair route cannot be pinned at unit level: doing so requires
`add_child()`-ing a `MachineGun`, which decision `32691c41` forbids. A test-writer discovered this,
refused, and I boarded it (`68234e8d`). But the article's `live_test_refs: []` and `known_gaps` say nothing
about *why*, and the next session will re-derive the whole chain.

**The shape of the fix.** `feature_article.current_ac[].untestable_because: { reason, blocking_record_id }`.
Then "no test covers this" and "no test *can* cover this, because `32691c41`" stop looking identical.

**The cost here.** One full test-writer dispatch to rediscover a blocker already recorded in a decision,
plus a second dispatch after I supplied the missing type shape.

### 13.3 There is no verification of a rotation note's factual claims

**The incident.** H1's `/clear` injection carried `pointers: ... FOURTEEN commits`. I added today's and told
the user **"fifteen commits are unmerged"** — twice, once inside a decision form. The real figure:
`git rev-list --count main..HEAD` → **39**.

**The shape of the fix.** The rotation note already has structured fields (`branch`, `head_sha`, `at`). Add
`commits_ahead` as a **generated** field, computed at write time, and have H1 **recompute it at injection
time** and flag a mismatch — it already does this for `head_sha` ("a moved HEAD ... is disclosed").

**The cost here.** A wrong number stated to the user twice and used to frame a decision. Low direct damage
this time; the mechanism for catching it (HEAD disclosure) exists and simply does not extend to the prose
fields.

### 13.4 There is no check that a document's cited ruling exists in the store

**The incident.** `tools/blender/FULL_EXPORT_RUNBOOK.md:117-124` cites *"the user's ruling (2026-08-23,
'riser-style re-expose')"*. No such record exists — searched at cap 50 of 569 decisions across several
vocabularies. A live decision, `d50439ec`, rules the same mechanism the opposite way. It had blocked a HIGH
board item for a day.

**The shape of the fix.** A periodic (or pre-merge) scan of tracked docs for ruling-shaped citations —
`decision <8-hex>`, `` `slug-like-this` ``, *"user ruling, YYYY-MM-DD"* — resolving each against the store
and reporting unresolvable ones. Reference-material records already track owned documents, so the file set
is known.

**The cost here.** One read-only lane to establish absence, one vendor-data lane to settle the question,
and one user question that turned out to be answerable from the vendor's own files.

### 13.5 There is no freshness signal on a board item derived from the world rather than the record

**The incident.** Board item `9d344f25` was `freshness: "fresh"`, `lifecycle: "live"`, HIGH priority, with a
detailed brief — and completely obsolete. I dispatched a full Opus lane (162k subagent tokens) which
returned *"the work order was already fully shipped at HEAD. I changed no files."*

**The shape of the fix.** Board items already carry `file_keys`. At `board_query` time, compare each item's
`updated_at` against the last commit touching its `file_keys` and annotate:
`⚠ file_keys changed in 3 commits since this item was written`. Not a verdict — a prompt to re-verify,
exactly where the reader is about to act.

**The cost here.** One wasted Opus lane and my adjudication of its report.

**Speculation flag:** 13.5 generalises from one incident this session, though CLAUDE.md records a prior
audit finding 5 of 8 board items wrong, which suggests it recurs.

### 13.6 There is nothing that notices an instrument has never been executed

**The incident.** `playtest_ui_sweep_probe.gd` was substantially reworked twice and **has never been run
since**. It passed `--check-only`, `gdlint`, `gdformat` and three code reviews — and no suite loads
`game/spike/**`, while `--check-only` does not resolve cross-script property access. It is shipped,
committed, unexecuted code whose entire job is to produce trustworthy measurements.

**The shape of the fix.** A `last_executed` field on an article describing a probe, stamped when a probe's
known command line is run, with the merge gate or H10 noting *"probe X modified but not executed since"*.

**The cost here.** None yet — disclosed on board `aa0f2c93`. But this exact file has already emitted two
false findings that cost real lanes, so an unexecuted rework of it is a loaded gun.

---

## 14. What would have helped, ranked

**Structural — there are genuinely three:**

1. **Content-check Arm 1 of the reconcile hook** (§10). Biggest single win available. Removes most of a
   207-item merge block; restores the queue's depth as a signal. The function it needs already exists in
   the codebase.
2. **A verified-current outcome for maintenance items** (`maintenance_resolve`, §8). Without it, honest
   verification has no representation and the only cheap path is deletion.
3. **A mutation-targets-the-diff check** (§13.1). The only unenforced rule whose violation produces a false
   green.

**Cheap and mechanical:**

4. Group the merge gate's refusal by article (§10.3).
5. `knowledge_schema`: separate caller-required from record-required; mark server-owned (§8).
6. `same_subject`: include `lifecycle`/`status` (§7).
7. Board items: annotate "file_keys changed in N commits since written" (§13.5).
8. Rotation note: generate and re-verify `commits_ahead` like `head_sha` (§13.3).
9. `explorer` gets `board_query`; H25 stays silent on harness built-ins (§9).
10. `untestable_because` on an AC (§13.2).
11. Cited-ruling resolution scan over tracked docs (§13.4).
12. `last_executed` on probe articles (§13.6).

## 15. Verdict

**The strongest part of Sterling is the record schema plus delivery.** `anti_pattern`'s
`trigger`/`right_way` split makes a record deliverable at the moment it matters, and I watched the full
loop close inside one session: I wrote an anti-pattern at 09:40 about mutation checks verifying the wrong
file, and H19 delivered it back to me at 10:20, unprompted, on the path it governs. Nothing else in my
toolchain does that. The constraint model on agents is the second-strongest thing — H4's read wall turned
what would have been a plausible hollow test into two correct refusals.

**The weakest part is the maintenance queue's producer.** One hook enqueueing without a content check
generated 207 merge blockers of which roughly one in seven was real, and it does so while a correct,
hash-based implementation sits in the same codebase serving the other arm. That single decision cost this
session its merge, four verification lanes, and a user decision that should never have needed making.

**Would I rather work with it than without it?** Yes, and not narrowly. Three defects reached the edge of a
commit this session — an unpinned fix, a probe that could report a dead button as alive, and a fix that
froze accumulated state — and **every one was caught by something Sterling's contract put in the way**: the
mandatory reviewer, the outside-family second opinion, the receipt ledger refusing a stale stamp. My own
green gates missed all three. A system that catches the author's own false greens is worth a noisy queue —
but the queue does not have to be noisy, and §10 is how it stops.
