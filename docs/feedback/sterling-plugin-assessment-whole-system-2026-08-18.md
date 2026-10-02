# Sterling — whole-system assessment, 2026-08-18

**Part B: the design review.** Session evidence is in `sterling-plugin-retrospective-2026-08-18.md`.
Prior assessments exist for 2026-08-14, -15 and -17; I did not read them, so overlaps are independent.

**Evidence base.** One long conductor-direct session in dome-farmer: a visual asset-inspection sweep,
~20 rendered plates opened by eye, 35 ledger rows ruled, a 19-item maintenance drain, two asset defects
diagnosed, twelve subagents, three commits.

⚠ **Not exercised, therefore not reviewed:** pipelines/runs, cleanup, init, merge, council, the TUI,
`knowledge_promote`, `knowledge_retire`, `handoff_*`. If this document reads like a review of Sterling,
it is a review of *conductor-direct Sterling*.

**If you read one thing:** §13.1. One capability — a pre-dispatch check against the store — would have
prevented the single most expensive event of the session, and it is cheap.

---

## 6. The record type system

**The types carve the space well, and I would not collapse any of them.** The session used four and each
did work only it could do:

- **`decision`** — the type that earns its place most. `a6dcef0a` records not just *what* was decided
  about six cockpits but the **rejected alternatives with reasons**, an amendment that voided its own
  first instruction, and a blocker recorded *inside the statement* rather than boarded separately. Code
  can never carry that. Its `alternatives_rejected` field stopped me re-offering a settled question.
- **`anti_pattern`** — the type with the highest per-record value, because it is the only one whose
  content is *"you are about to do X"*. Both of the session's saves came from anti-patterns.
- **`research_finding`** — the right home for a measurement with two clocks.
- **`feature_article`** — used mostly as an ownership index. Its `files[]` is what makes H19 work at all.

**Best field I used: `anti_pattern.trigger`.** Not `guidance`, not `right_way` — **`trigger`**. It is
written in the second person describing the reader's current mental state, and that is why `21e3270c`
worked: I read *"your conclusion is about CONTACT and your evidence is about IDENTITY"* and recognised
the sentence I had just written. A record that describes the *symptom of being wrong* is findable by
someone who does not yet know they are wrong. This is the single best design decision in the schema.

**Dead weight I observed.** `research_finding.volatility_hint` did no work: I set `stable` and `medium`
by feel and nothing consumed either. `stack_tags` on project-scoped records likewise — 13 findings all
tagged `godot`/`gdscript` and all declined for promotion precisely *because* they are not portable, so
the tag was noise on every one.

**One real gap in the schema.** `anti_pattern` has `source_evidence`, which is prose. Nothing
distinguishes *"I measured this"* from *"I inferred this"*. I created `9fce1899` whose central claim was
an unmeasured hypothesis; it was refuted an hour later. **A `basis` enum on assertions —
`measured | inferred | ruled` — would have made me write `inferred` and would have made the next reader
discount it correctly.** See §13.2.

---

## 7. Identity, versioning, supersession

**Every update mints a new id.** In one session I watched a single reference record pass through
`90539dba` → `0d0d2687` → `e91a0f50` → `3d41156d`, three of them my own edits minutes apart. An
anti-pattern I created as `9fce1899` is now `235d0ea3`.

**This is survivable only because of slug resolution, and I used it constantly.** The project's own
CLAUDE.md instructs resolving records by slug, and one board item explicitly says *"resolve it by TITLE,
never by an id, since every `knowledge_update` mints a new one."* **When a consuming project's
documentation contains a workaround for your identity model, that is the finding.**

The concrete cost this session: I wrote id `9fce1899` into a ledger row and into a coder's brief, and
both are now stale pointers to a superseded version. Nothing warned me. **Citing a record durably
requires knowing not to cite the thing the API just returned to you** — the create/update response leads
with `id`, which is exactly the field you should not write down.

**Can a reader tell a live record from a dead one in the surface they actually use?** Partly.
`knowledge_get` on an id returns `superseded_by`. But H19 and H20 deliver *content* with an id appended,
and I never once checked whether a delivered record was current. **The delivery surface is where trust is
extended and it is the surface with the least staleness signal.**

**Improvement, cheap:** have create/update/append return a `cite:` field — the stable slug — beside the
volatile `id`, and have H19/H20 deliver the slug rather than the id. This is a formatting change, not an
architectural one.

---

## 8. The tool / API surface

**What worked.** `knowledge_append` for arrays and `knowledge_edit` for a passage inside a long string
are exactly right, and the reason is quantified in this session: the article I needed to touch is
**63,945 characters** and overflows a single `knowledge_get`. Without `append`, reconciling it would have
required retransmitting an array I could not read — the truncation trap the store's own anti-pattern
`d25f5a9e` documents. `knowledge_edit`'s *"find must match exactly once, refused with the count
otherwise"* contract is the right severity.

**What took N calls that should take one.**

- **Refreshing one bullet in a board item took a full read-plus-rewrite.** `board_update` replaces `text`
  wholesale, so correcting a stale count in an 8,055-character item meant retrieving it, reproducing it
  byte-for-byte, and writing 8,463 characters back. I delegated it *specifically because it was
  dangerous* — a truncated board item would have destroyed the run configuration the next session
  depends on. **`board_update` needs the `knowledge_edit` treatment: a find/replace with match-count
  enforcement.** This is the most-wanted missing call in the whole surface.
- **Ids must be full uuids, but the ecosystem displays short ones.** A librarian's first pass at
  `maintenance_remove` used 8-character ids — the form every board digest, every log line and every
  human conversation uses — and was rejected. It retried with full uuids. **Either accept an unambiguous
  prefix or stop printing prefixes.**

**Learned by rejection, not documentation.** The `knowledge_create` dedup refusal is *good* — it names
the overlapping record, gives the Dice score and the threshold, and names the override flag. That is how
a rejection should read. Contrast the id-length rejection, which the agent had to solve by guessing.

**The strongest evidence about this API is dome-farmer's own CLAUDE.md.** It carries roughly 40 lines of
Sterling call-shape lore: which types use `files[{path, role}]` versus `file_keys[]`, that
`research_finding` has no path field *and the plugin's own template says it does*, that `volatility_hint`
is a closed enum where `"low"` is refused, that `current_ac` is objects not strings, that `dependencies`
is an object of slugs not paths, that `concept_family` is a string not a boolean, that `file_baselines`
is server-owned. **Every one of those lines was paid for with a rejected write.** A project should not
have to maintain your schema documentation. `knowledge_schema(<type>)` exists and is the right answer —
it needs to be what agents reach for first, which means the error messages should point at it by name.

---

## 9. The agent roster

**Tool lists are wrong in at least two places, and each cost a round.**

- **`explorer` has no `maintenance_query`.** I dispatched one to verify the maintenance queue. It
  correctly reported it could not: `ToolSearch select:mcp__sterling__maintenance_query` → no match. A
  wasted dispatch, ~26 seconds and ~50k tokens, and I had to run the query myself and re-dispatch.
- **`librarian` has no `board_add`/`board_update`/`board_remove`.** It has `maintenance_remove` but
  cannot touch the user board. Since draining a queue routinely surfaces board work, this split forces
  either a second dispatch or conductor hand-work. I used a `general-purpose` agent for board writes,
  which defeats the point of having a constrained librarian.

**Where constraint produced a better result.** The `librarian` and `coder` contracts — *apply
conductor-drafted text verbatim, author nothing* — were the session's most reliable lanes. A coder
applying 14 ledger verdicts verified its own counts against my stated expectations (`220` / `172`) and
reported them before claiming success. Another **refused an instruction of mine that was wrong**: I said
a row was `N` and to leave it, it was already `Y`, and the agent left column 3 alone *and told me*. **A
constrained agent that reports a contradiction instead of resolving it is worth more than a clever one.**

**The `debugger` contract — diagnose, do not fix — was right every time.** Both debuggers returned
measurements and a proposed fix without applying it, which let me adjudicate. One of them corrected my
hypothesis outright (my lead covered 1 of 4 cases, not the 2 I claimed).

**A roster-level inconsistency worth fixing:** two `debugger` dispatches in the same session had
different Bash working directories — one at the repo root, one inside `tools/blender/out/sheets/sweep08`
— which made an allowlisted relative path (`--path game`) resolvable for one and not the other. **Agent
cwd should be deterministic and documented.**

---

## 10. The board and the maintenance queue

**The queue's signal-to-noise, measured.** `maintenance_query cap:120` returned **76 items, `capped:
false`**. Of those, **58 were `file_parked`** — informational, closing at a merge gate, not drainable.
So **76% of the queue was not work.** Of the 19 that were, verification found **3 already paid** and 16
owed — but of those 16, **13 were `promotion_review`**, all of which I declined in a single decision
because every finding was a measurement of *this project's own* assets and instruments.

**So the honest reading is: 76 items, of which about 3 needed a real write.** The queue is not lying,
but its density is low enough that reading it is a cost.

**The `promotion_review` lane has a design problem.** It fires per finding and asks the conductor to
judge portability. But portability is nearly always decidable from the finding's *subject*: a
measurement of `manifest.json` or of a project probe's pad constant is never portable to another Godot
project. **The lane generates one item per finding for a question whose answer is "no" almost every
time.** I wrote a standing decision (`7f920d95`) with a rule to close the lane in future, which is a
project-side patch for a plugin-side default.

**The board is 241 items** (`board_query source:"user" cap:60` → `matched_filter: 241, capped: true`).
That is past the point where anyone audits it. Its own discipline rules say *"a board too large to read
is a board nobody will audit"*, and the board has outgrown them.

**Staleness runs in both directions**, and I hit the less obvious one: board `3074cd0d` claimed
**188 `Y` / 204 `N`** when the true figure was **229 / 163**. The item was stale by understating progress,
which sends a session to re-measure work already done.

---

## 11. The conductor contract — enforced versus prose

| Rule | Enforced by | Held this session? |
|---|---|---|
| Read before edit | **H3, content-hash** | Yes — caught a real race |
| Test-writer blind to implementation | **H4** | n/a |
| Capture before session end | **H10** | Yes — prompted a real capture |
| Owning article for touched territory | **H10** | Fired, but on gitignored scratch |
| Subagent command allowlist | **H14** | Yes |
| No duplicate knowledge records | **create-time dedup gate** | Yes — and the override was right |
| **Verify an agent's "all N" claim yourself** | **prose only** | Yes, by discipline — and it mattered twice |
| **Re-verify a board item against HEAD before acting** | **prose only** | Partly — I missed one stale count |
| **A record's central claim must be measured** | **nothing** | **No — I shipped a false one** |
| **Check the store before dispatching** | **prose only** | **No — cost a 10-minute Opus dispatch** |

**The highest-value unenforced rule is "check the store before you dispatch."** It is in the retrieval-
first section of the project's CLAUDE.md in strong terms, I believe in it, and I broke it on the single
most expensive dispatch of the session. **A rule everyone agrees with and nothing checks is a rule that
fails on a long session** — which is exactly when it matters most, because that is when you are tired and
the store is largest.

---

## 12. What is structurally missing — the design reaches for it and stops short

1. **`board_edit(id, find, replace)`.** `knowledge_edit` exists for records; the board has no equivalent
   and its items are the largest free text in the system. §8.
2. **A `cite`/slug field on every write response**, and slugs rather than ids in H19/H20 deliveries. The
   supersession model already has stable slugs; the surfaces just do not use them. §7.
3. **Ignore-file awareness in H19/H10's frontier check.** The store knows about paths; it has no notion of
   *generated*. One `.gitignore` read at hook start.
4. **A `basis` enum on assertion-bearing fields** (`measured | inferred | ruled`). The schema already
   distinguishes record *types* by epistemic status; it does not distinguish claims *within* a record.
5. **Prefix-tolerant id resolution**, or stop printing prefixes.

---

## 13. What Sterling does not do at all — and should

Ranked by damage caused **in this session**. Every entry is anchored to something that actually went
wrong.

### 13.1 There is no pre-dispatch check of the brief against the store — **the most expensive gap**

**The gap.** Nothing compares a dispatch's *question* against decisions and findings that already answer
it, before the agent is spawned.

**The incident.** I dispatched an Opus debugger to measure why five cockpit parts render with a void
between body and head. It spent **157,903 tokens over 595,899 ms (~10 minutes)** and produced an
excellent report. Decision `a6dcef0a`, written 2026-08-16, already contained the entire answer: the
per-mesh void, the cause (*"the double-apply landing on the head node"*, proven *"6 OF 6 EXACT TO SIX
DECIMAL PLACES"*), the vendor's **0.335 m overlap**, and the ruling *"THE REMAINING WORK IS THEREFORE THE
EXPORT FIX ALONE."* The dispatch added exactly one new fact: the export fix has not reached the artefacts.

**Why nothing caught it.** H19 fires on file touches; I was reading PNGs and a `.txt` probe log. H20
fired on the dispatch prompt and matched other records. The record was reachable by an obvious query I
did not run.

**The shape of the fix.** H20 already inspects dispatch prompts. Add a second pass that ranks
`decision` and `research_finding` records by overlap with the prompt's *question* and emits at most
three, formatted as a challenge rather than a delivery:
```
⚠ H20 PRIOR-ANSWER CHECK — 1 record may already answer this dispatch's question:
  decision a6dcef0a "THE SIX VENDOR-SILENT HUMANOID COCKPITS…" (2026-08-16)
  → measured the head/body void and ruled the fix. READ BEFORE DISPATCHING.
```

**The cost.** ~158k tokens and ten minutes of wall-clock, ~80% redundant. Speculation flag: **none** —
this is one measured incident, but the mechanism that allowed it (delivery keyed on file paths, while
investigation happens over logs and images) is structural, not incidental.

### 13.2 There is no way to mark a claim as unmeasured, so a hypothesis can be written as knowledge

**The gap.** No field, and no gate, distinguishes an assertion the author *measured* from one they
*inferred*. Records read with uniform authority.

**The incident.** I created anti-pattern `9fce1899` at 20:48 asserting that three cockpit parts were
fine and a *"slim invisible column"* explained their apparent detachment. At 20:56 a per-mesh measurement
refuted it: no column, real void of **+1.03 m to +3.74 m**, parts genuinely defective. **Eight minutes.**
Had the session ended between those points, a confidently-worded, well-cited, false anti-pattern would
have been the store's standing guidance on exactly the class of defect the milestone is about.

**The shape of the fix.** A required `basis` enum on `anti_pattern.source_evidence` and
`research_finding.answer`: `measured | inferred | ruled | reported`. On `inferred`, the create response
emits an advisory and the record renders with a marker wherever it is delivered:
```
⚠ INFERRED — this record's central claim was not measured when written.
```
Plus a `maintenance_enqueue` reason `inference_unconfirmed` so the queue holds it until someone measures.

**The cost.** One false record created and rewritten within the hour; ids `9fce1899` and `235d0ea3` both
now cited in a tracked ledger row and a subagent brief, one of them stale. Recovered only because I chose
to measure. **Speculation flag: I observed this once. I am confident the mechanism generalises, because
nothing in the schema even gestures at the distinction, but I have one incident.**

### 13.3 There is no binding between a number quoted in a record and the artefact it measures

**The gap.** A record can quote a count from a file; nothing notices when the file changes.

**The incident.** Board `3074cd0d` — the entry point for a ~70-hour milestone — carried *"392 rows,
**188 `Y` / 204 `N`**, independently re-measured 2026-08-18."* The true figure at the time I read it was
**194 / 198**, and by mid-session **229 / 163**. The inherited rotation note carried the same stale pair.
Nothing flagged either.

**The shape of the fix.** An optional `measurements[]` block on board items and records:
```json
{"label": "ledger inspected", "value": 188, "command": "grep -cE '^\\|[^|]+\\|[^|]+\\| *Y *\\|' docs/…",
 "measured_at": "2026-08-18T11:50:00Z"}
```
Re-run on retrieval, or at session start, and warn on drift. The commands are already written into these
items as prose — they just are not executable.

**The cost.** Modest here because I re-measured by habit, but the stale pair also travelled into a
rotation note, which is the one artefact a fresh session trusts unconditionally.

### 13.4 There is no cost accounting for dispatches

**The gap.** Nothing aggregates subagent spend, and nothing tells the conductor before dispatching what a
comparable dispatch cost last time.

**The incident.** Twelve subagents. Individual reports carry `subagent_tokens`: 49,602 / 162,573 /
214,913 / 229,082 / 197,652 / 77,847 / 84,572 / 93,946 / 157,903 / 182,208 / 111,778 / 64,368 — roughly
**1.4 million tokens**. I learned that only by adding them up while writing this document. The 229k and
215k lanes were exploratory and I would have scoped them tighter had I seen the running total.

**The shape of the fix.** A line in the session-start H1 block and in each Stop hook:
`STERLING SPEND — 12 dispatches, 1.43M subagent tokens this session (largest: 229k, "diagnose
see-through parts")`. No new storage; the numbers already exist in the task notifications.

**The cost.** No specific defect — a governance gap rather than a damage event. Ranked here, below the
first three, deliberately.

### 13.5 There is no post-commit verification ledger

**The gap.** Nothing records that a committed change is *structurally* verified but *visually*
unverified, and nothing surfaces that debt later.

**The incident.** I committed a probe fix measured at **16 of 16 cells recovered**. Every gate is green.
But *appearance is untested* — whether those 16 cells produce readable plates needs a windowed re-run and
my own eyes. I wrote that into a board item and a rotation note **by hand**, and if I had not, the green
gates would read as done.

**The shape of the fix.** A `verification_owed` maintenance reason, writable at commit time:
`maintenance_enqueue(reason: "verification_owed", text: "…", released_by: "<what discharges it>")`, which
H1 surfaces at session start and the merge gate refuses to pass.

**The cost.** None yet — I caught it. **That is the point: it survived on my discipline, and the next
session inherits it only because I typed it twice.** Speculation flag: the risk is inferred, not observed.

### 13.6 Nothing watches artefacts that are not source files

**The gap.** H19 keys on file paths in the repo. Investigation in this project happens over rendered
images and probe stdout — neither of which any record can own.

**The incident.** I classified a `held_back` ruling as an export defect **twice, in two artefacts**,
while reading a probe log. Anti-pattern `fa874551` describes that exact confusion and did not fire,
because reading a `.txt` under a gitignored directory touches no governed path.

**The shape of the fix.** Let `anti_pattern` and `decision` declare `output_patterns[]` — literal strings
or regexes that appear in tool *output* rather than in file paths — and have a PostToolUse hook scan
Bash/Read output for them:
```json
"output_patterns": ["is not exported", "held_back", "glb_path.*null"]
```
Firing on the string `is not exported` would have delivered `fa874551` at the exact moment I misread it.

**The cost.** Two wrong claims written into a tracked ledger and a new board item, both corrected the same
session, roughly 40 minutes of rework including a census dispatch.

---

## 14. What would have helped — one ordered list, §12 and §13 merged

**Structural — there are genuinely three.**

1. **Pre-dispatch prior-answer check** (§13.1). Cost this session: ~158k tokens and 10 minutes.
2. **A `basis` marker on assertions, with an advisory on `inferred`** (§13.2). Cost: one false record
   that survived eight minutes only by luck.
3. **Output-pattern triggers, so records can fire on tool output and not only file paths** (§13.6). Cost:
   two wrong claims and ~40 minutes of rework.

**Cheap and mechanical — all five are small.**

4. **Ignore-file awareness in H19/H10** (§12.3). Removes ~20 noise firings per session in any project
   with a render directory, and one spurious Stop-hook demand.
5. **`board_edit(id, find, replace)`** (§12.1). Turns a dangerous 8 KB rewrite into a one-line change.
6. **Slugs not ids in delivery, and a `cite` field on write responses** (§12.2). Pure formatting; removes
   the workaround a consuming project has had to write into its own CLAUDE.md.
7. **Fix the agent tool lists** — `explorer` needs `maintenance_query`, `librarian` needs the board
   family (§9). Each mismatch costs a whole dispatch round.
8. **Dispatch spend line in H1 and Stop** (§13.4). The numbers already exist.

**One behavioural fix that costs nothing:** H21's hand-work counter should not count image reads. In a
visual-inspection project it is telling the conductor to delegate the only thing it cannot delegate.

---

## 15. Verdict

**The strongest part of Sterling is the `anti_pattern` record with its second-person `trigger`, delivered
at the moment of action.** Twice in one session a record described the mistake I was in the middle of
making, in words close enough to my own reasoning that I recognised myself and stopped. One of those
prevented a false FAIL verdict from entering a tracked ledger that every future session trusts; the other
handed a debugger the correct hypothesis before it began. Nothing else in my stack — not tests, not
linters, not review — can catch a wrong *judgement about a picture*. That capability is real and I have
not seen it anywhere else.

**The weakest part is that delivery is keyed almost entirely on file paths, and the work is not.** This
session's real activity was looking at images and reading probe output. The store held the answer to my
most expensive question and to my most embarrassing mistake, and in both cases it stayed silent — not
because the records were missing or bad, but because nobody touched a governed `.gd` file at the moment
it mattered. Meanwhile the same path-keyed mechanism fired twenty times on PNGs to tell me a gitignored
image has no owning article. **The precision problem and the recall problem are the same problem, and
they are the thing to fix.**

Would I rather work with it than without it? **Yes, clearly, and not marginally.** Without it I would
have shipped a false asset verdict, spent longer on the mirror diagnosis, and lost the session's findings
at the next `/clear`. The rotation note alone — restored and consumed automatically at session start —
carried the entire milestone across a context boundary. But I would say plainly: the store's *content* is
in better shape than the store's *retrieval*, and every hour spent on precision and recall in delivery is
worth more than another record type.
