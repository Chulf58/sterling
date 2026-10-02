# Sterling — whole-system assessment, 2026-08-19 11:45

Companion to `sterling-plugin-retrospective-2026-08-19-1145.md`, which carries the session evidence. This
file reviews the **design**. Every claim is grounded in that session, but the claims are about the plugin.

⚠ Earlier assessments exist for 2026-08-14/15/17/18 and one earlier on 2026-08-19. This is a new account
and does not revise them.

---

## THE HEADLINE, STATED FIRST BECAUSE IT CAUSES MOST OF THE DAMAGE

**Sterling validates the *shape* of a record and nothing about the *claims inside it*.**

The schema layer is genuinely good — it refuses unknown fields by name, refuses wrong types per element,
refuses a `history` entry without a full ISO instant, and refuses a colliding slug. All of that worked this
session.

But every expensive failure was a **free-prose claim inside a well-formed record**:

| the claim | where it lived | how it failed |
|---|---|---|
| three record ids | a live board item's text | none of the three resolve |
| `fit.py:356-362` | a board item's text | true location is `372-378` |
| `:1119-1146`, `:1232-1237`, `:1681-1682` | an article's `files[].role` | all three rotted by ~22 lines |
| *"the docstring **still** says 35"* | two articles | falsified 3 minutes after being written |
| `353 Y / 39 N`, "FX total 12", "roughly 27 rows" | the campaign tracker | wrong by 5 rows, by 1, and by arithmetic |
| `decision 8ecd435f` | an agent's report, twice across sessions | does not exist, and the record warning about it is the vector |

**Every one of these is machine-checkable.** An id either resolves or it does not. A `file:line` either
points at what it claims or it does not. A count either matches the command that derives it or it does not.
Sterling checks none of them, and the result is that its most authoritative surfaces are its least
trustworthy ones — because authority is exactly what stops a reader re-deriving.

---

## 6. THE RECORD TYPE SYSTEM

**The carve is right and I would not collapse any two.** This session used four types and each did work the
others could not:

- **`anti_pattern`** carried the session's best save (a contaminated-plate rule) and its best method (a
  sibling-control comparison). Its `trigger` / `wrong_way` / `right_way` split is the single strongest
  design decision in the schema — `trigger` is what makes a record *findable at the moment of danger*
  rather than merely true.
- **`decision`** carried `alternatives_rejected`, which is **the best field in the system.** Writing five
  rejected options for a consolidation shape call forced me to discover that both "obvious" alternatives
  inverted a dependency that does not exist today. **The field changed the decision, not just the record of
  it.** No other type has anything like it.
- **`todo` (board)** and **`todo` + `system_reason` (queue)** are correctly separated. A spike is not
  maintenance and the split held all session.
- **`reference_material`** is the weak one — see §8.

**Dead weight I hit:** `reference_material` has no array field at all, so a record whose entire purpose is
to track a moving count has nowhere to put a running log. It carries that log inside `summary` as prose,
which is exactly the un-validated free text this document's headline is about.

**The `concept_family` / concept-article idea I did not exercise**, so I cannot judge it.

---

## 7. IDENTITY, VERSIONING AND SUPERSESSION

**This remains the most expensive design property in the system, and it did bite this session.**

Every `knowledge_update` / `knowledge_edit` mints a **new id**. I hit this three times in twenty minutes:

```
anti_pattern created   → b523b471
after edit #1 (guidance)      → bf3b7152
after edit #2 (source_evidence) → 33fa9d66
```

Three ids for one record inside twenty minutes. I had already told the user "`b523b471`" in chat. The
id was dead before the sentence was.

**The mitigation is real:** slugs are stable, and `knowledge_get` resolves them. I switched to citing
`recording-an-instrument-s-refusal-as-a-property-of-the-subje`. **But nothing enforces slug-citation**, and
the entire corpus is written in ids: the board item I read cited three of them, and all three were dead.

⚠ **The sharpest form of the problem: a reader cannot tell a live id from a dead one in the surface they
actually use.** Board item text, article prose and agent reports are all free text. There is no
syntactic difference between `804c4efb` (closed months ago), `bfc53113` (live and load-bearing) and
`8ecd435f` (never existed). All three appear in this project's records, in the same font, with the same
authority.

**Verdict: unchanged from prior sessions. Still the highest-leverage structural fix available.**

---

## 8. THE TOOL / API SURFACE

### What is genuinely good

- **Refusal messages are excellent.** The `reference_material` rejection named the complete valid field
  set. The dedup refusal named the score, the threshold, *which branch of its own heuristic is
  unreliable*, and both remedies. The `maintenance_remove` "already removed" disclosed the timestamp and
  the mechanism. **These are better than most commercial APIs.**
- **`knowledge_edit`'s exactly-once contract** is right. Refusing on both zero and multiple matches, with
  the count, makes a blind replace inside an unreadable 92 KB field safe. The librarian relied on this.
- **Auto-drain on write** works: appending to an article silently closed its `reconcile_needed` items, and
  `maintenance_remove` then reported them already gone rather than erroring confusingly.
- **`{matched_filter, returned, cap, capped}` on every query.** `capped: true` is the difference between a
  window and an inventory, and I used it: `board_query` returned `matched_filter: 251, cap: 80, capped:
  true`, which told me immediately I was holding a third of the board.

### What took N calls that should take one

**Learned by rejection, not documentation:**
- `reference_material` has no `history`. My brief was built on the assumption it did. One wasted round.
- There is **no string-append operation.** `knowledge_append` handles arrays; for a long string field you
  must use `knowledge_edit` with a `find` anchor — which requires knowing text you may not have read. I
  appended to a 3 KB `source_evidence` by anchoring on a heading I happened to remember from an H20
  delivery. **That was luck.** A `knowledge_append(id, field, text)` for strings is an obvious missing
  sibling of the array version.
- **`board_query` cannot fetch by id.** To read one known board item I used `contains` with a distinctive
  substring and hoped it was unique. `knowledge_get` works on board ids, which is a coincidence of the
  shared store, not an advertised path.

**This project's `CLAUDE.md` carries roughly 40 lines of call-shape gotchas** — which fields are arrays of
objects vs strings, that `dependencies` is an object not an array, that `concept_family` is a string not a
boolean, that `file_baselines` is server-owned, that `research_finding` has no path field despite the
upstream template saying it does. **That is the plugin's documentation debt showing up as a consuming
project's maintenance burden**, and it is the clearest evidence that `knowledge_schema` should be the
advertised first step rather than a recovery tool.

---

## 9. THE AGENT ROSTER

### The one structural gap: no agent can touch the board

**No agent type in the roster has `board_query`, `board_add`, `board_update` or `board_remove`.** The
`librarian` has `maintenance_query` / `maintenance_remove` but not the board.

Consequences this session, all measured:
- I hand-fed board item text into three separate briefs.
- A read-only lane I dispatched to run four board close tests **could not read the board items it was
  testing** — I had to paste the close tests into its brief.
- A 251-item board can only ever be read or audited by the most expensive model in the session, which is
  precisely the resource the delegation design exists to protect.

The security instinct behind it is sound — the board is the human's surface. But **read access is not
write access**, and a `board_query`-only agent would have removed a third of my hand-work this session.

### Where the roster's constraints produced better results

- The `librarian`'s "never author content" rule made it **stop and report** rather than guess a substitute
  field when my brief was wrong. An unconstrained agent would have hidden my error. This is the roster
  working exactly as designed.
- `Explore`'s read-only construction let me dispatch it at a live tree with zero risk while other lanes
  held files.

### Where I nearly misdispatched

The project's `CLAUDE.md` records that `explorer` has no Bash and no board tools, and that a brief asking
for either wastes a whole round. **I had to consult a project document to learn a plugin agent's
capabilities.** The roster's tool lists should be discoverable from the plugin.

---

## 10. THE BOARD AND THE MAINTENANCE QUEUE

**Queue signal-to-noise, measured:** 33 items at session start, `capped: false`.

| lane | count | assessment |
|---|---|---|
| `file_parked` | 22 (67%) | Informational; owed at a merge gate. **Two-thirds of the queue is a permanent standing population.** |
| `article_oversize` | 2 | Correct, but V2-gated by user ruling — will never close, and re-fires on every append |
| `reconcile_needed` | ~6 | ✅ All genuine. Two were subtly stale-by-3-minutes and needed real work |
| `capture_owed` | 1 | ✅ Excellent — carried a complete draft **and its own release condition** ("lands after a green suite") |

**The `capture_owed` item is the best single artefact I saw all session.** It held a full draft, named
the decision it should land on, and stated the gate that must pass first. It survived a `/clear`. That is
the queue at its best and it is a genuinely good design.

**But 67% standing noise means the queue's depth signal is meaningless.** "33 items" cannot distinguish a
healthy session from a neglected one, because 22 of them will be there forever.

**The queue misled in the OUTSTANDING direction too**, which is the failure mode the skill brief warns
about: an `article_oversize` item fires on every append to an article the user has ruled V2-deferred. It is
permanently correct and permanently unactionable.

**The board is worse: `matched_filter: 251`.** A board that cannot be read in one query cannot be audited,
and this session found three dead ids and a set of stale line numbers in the two items I did read closely.
**A prior audit in this project measured 19 of 31 high-priority items wrong or stale in some load-bearing
way.** I have no reason to think the other 220 are better.

---

## 11. THE CONDUCTOR CONTRACT — ENFORCED VS PROSE

| rule | enforcement |
|---|---|
| Read before edit | ✅ **H3, mechanical.** Caught me. |
| Capture when the decision is made | ✅ **H10, mechanical.** 4/4 this session. |
| Reconcile affected articles | ✅ **H7 → queue items.** Fired correctly. |
| Store writes go through MCP | ✅ **H15, mechanical** (over-broad, but enforced). |
| Test-writer stays implementation-blind | ✅ H4 (not exercised). |
| **Run the suite yourself before committing** | ❌ **Prose only.** |
| **Open every render with your own eyes** | ❌ **Prose only.** |
| **Never repeat a count without re-deriving it** | ❌ **Prose only — and I broke it.** |
| **Every path in a brief grepped that turn** | ❌ **Prose only.** |
| **A design question is always an ask** | ❌ Prose; H20's audit arrives post-answer. |

**The highest-value unenforced rule is "never repeat a count or claim without checking it against the record
that owns it."** I broke it in a durable record, four hours after correcting the same record for the same
class of error, with a warning I had personally written sitting at the top of it.

That is the proof that prose enforcement fails **specifically on a long session** — the exact condition
under which Sterling's other machinery is most needed. A rule everyone agrees with and nothing checks is a
rule that fails when the operator is tired, which is when it matters.

---

## 12. STRUCTURALLY MISSING — the design reaches for these and stops short

1. **`knowledge_append` for string fields.** The array version exists; the string case forces
   `knowledge_edit` with a find-anchor you may not be able to obtain. Signature:
   `knowledge_append(id, field, text, position: "end"|"start")`.
2. **`board_query {id}`.** Every other surface fetches by id; the board makes you substring-search.
3. **A read-only board agent capability.** The tool exists; no agent type carries it (§9).
4. **`knowledge_schema` as an advertised first-call**, not a recovery tool. The evidence it is not is 40
   lines of gotchas in a consuming project's CLAUDE.md.
5. **A "what would this write close?" preview** on the queue. `maintenance_query` can list items; it
   cannot answer whether a planned write drains them, so you discover it after the fact via "ALREADY
   REMOVED".

---

## 13. WHAT STERLING DOES NOT DO AT ALL — AND SHOULD

Ranked by **damage caused in this session**, worst first. Every entry maps to a real incident.

---

### 13.1 There is no validation that a record id mentioned in text actually resolves

**The gap.** No mechanism checks that hex-id-shaped tokens inside `text`, `summary`, `role`, `statement` or
an agent report refer to records that exist.

**The incident.** Three receipts, all this session:
- A live board item cited `804c4efb`, `6cb0dcb7`, `fedbbe22` as "probably closeable". All three return
  *"no record … in the project store or any mounted domain, at any status — and no slug matches."*
- A librarian cited `decision 8ecd435f`. Does not exist.
- **That same phantom id was cited by a different agent in a different session on 2026-08-15**, and is
  quoted verbatim inside `anti_pattern 55c513ac` as its worked example — **so the record that warns about
  fabricated ids is delivered by H19/H20 into agent context and is now the id's transmission vector.**

**The shape of the fix.** On any `knowledge_create` / `knowledge_update` / `board_add` / `board_update`,
scan text fields for `\b[0-9a-f]{8}\b` and for full UUIDs, resolve each, and **warn (not refuse)** naming
the unresolvable ones — the same advisory shape H21 already uses. Optionally a `knowledge_lint` sweep for
the existing corpus. And for the specific vector above: an authoring convention that example ids in
anti-patterns use an obviously synthetic placeholder.

**The cost here.** Three `knowledge_get` calls to discover the dead ids; a dispatched lane sent at four
close tests of which three were for items that no longer exist; and a phantom id that has now survived two
sessions and is being actively propagated by the warning system.

---

### 13.2 There is no way to tie a number in a record to the command that derives it

**The gap.** Counts live as prose. Nothing knows how a number was produced or when it was last true.

**The incident.** The campaign tracker has now been wrong **four times**: by 40 rows, by 60 rows, on its FX
total (said 12, true 11) and its derived headline ("roughly 27" — arithmetic on the wrong FX total), and
finally **by 5 rows and a disproved taxonomy group, four hours after I personally corrected it**, while
carrying my own header warning not to trust its numbers. `anti_pattern 4c7a977a` already documents that a
staleness warning inside the artefact it warns about is documentation, not a control — it predicted this
exact failure and could not prevent it.

**The shape of the fix.** A `derived_values` field on `todo` and `feature_article`:
`[{name, value, command, derived_at, head}]`. Any surface rendering the record shows the value with its
`head`; when `HEAD` has moved, it renders as *stale — re-run `<command>`*. The command here was a
one-line `awk` that takes under a second.

**The cost here.** One board item rewritten twice in one session, still stale within four hours. Downstream,
a lane was dispatched at a row (`Humanoids_Gadget_Weapon_Rockets`) that the tracker listed as open and that
had been ruled the previous day.

---

### 13.3 The frontier check has no ignore-file awareness

**The gap.** H19's unowned-territory signal treats any path with no owning article as a frontier, including
build output that is gitignored by design.

**The incident.** Roughly eight plate reads under `tools/blender/out/seated/…`, each producing *"territory
… is UNOWNED — no owning article exists … H10 will demand the owning article at session end if this work
lands here."* That tree is gitignored at `.gitignore:74` under an explicit project rule that all generated
plates live there **because they are disposable**. There are ~2,900 PNGs under it.

**The shape of the fix.** Before emitting a frontier signal, check the path against `.gitignore` (and the
configured store-ignore, if any) and skip. One `git check-ignore --quiet <path>` per candidate.

**The cost here.** Eight false signals carrying a false end-of-session threat, in a session whose central
activity was opening images in exactly that directory. It also devalues the true frontier signal: if the
mechanism cries wolf on every render, its one real firing gets skimmed.

---

### 13.4 There is no delivery memory — the same records are re-sent on every touch of a file

**The gap.** H19 re-delivers a file's full owning-knowledge payload on every Read and every Edit within one
session, with no notion of what this conductor has already been shown.

**The incident.** Six touches of one file (`docs/mech-asset-inspection-log.md`) produced six deliveries of
the same ~5 records, each large enough to spill to disk: **14.5, 15.6, 12.9, 12.1, 11.0 and 10.7 KB ≈ 76 KB
for one file**, with zero novel content after the first.

**The shape of the fix.** H19 keeps a per-session set of delivered record ids (the transient directory
already exists — H3's `conductor-reads.json` lives there). On a repeat, emit one line:
*"owning knowledge for `<path>` already delivered this session: `<ids>` — `knowledge_get` to re-read."*
Re-send in full only if the record's version changed.

**The cost here.** The largest single token drain of the session, spent on a conductor whose context is the
scarcest resource in the system — the exact resource the whole delegation design exists to protect.

---

### 13.5 There is no way to mark a claim as instrument-scoped, so "impossible" claims never expire

**The gap.** A record can say a thing cannot be done, and nothing ever re-tests it when the tooling
changes.

**The incident.** **Four ledger rows** were recorded as blocked — *"unphotographable BY RULING"*, *"no
fittable vendor host"* — and **all four needed nothing built.** One was seated on an already-exported part
carrying the vendor's own socket; two needed only a default eviction the seater already performs; one
needed no special handling whatsoever. I wrote this up as an anti-pattern, proposed a keyword sweep as its
control, **ran that sweep, and it found none of the four** — two were blocked in a board-level taxonomy
rather than in their own rows, and one used vocabulary my pattern missed. I had to correct my own record
within the hour.

**The shape of the fix.** A `blocked_by` field on a `todo`/row-like record taking
`{instrument, release_condition}` rather than free prose, plus a hook that fires on a **commit touching a
named instrument** and lists every open record blocked on it. The trigger must be the instrument changing,
not somebody re-reading the record — that is precisely why my prose-sweep control failed.

⚠ **Flagged as partly speculative:** the four instances are real and measured, but the fix's shape is my
proposal and has not been tested. The *gap* is not speculative.

---

### 13.6 There is no staleness signal for a `file:line` citation

**The gap.** Records cite `path:line` constantly; nothing invalidates the line number when the file moves.

**The incident.** A board item cites `fit.py:356-362` for a specific refusal; the true location is
`372-378`. An article carried three rotted ranges (`:1119-1146` → `~1141-1168`, `:1232-1237` → `:1254-1259`,
`:1681-1682` → `:1703-1704`), all shifted by the same ~22-line insertion. A dispatched lane spent part of
its round re-deriving them.

**The shape of the fix.** Cheapest useful version: a **write-time advisory** — *"this text contains
`file:line` citations; a symbol anchor survives edits, a line number does not."* One commit in this repo
(`82896c9`) already did that conversion by hand, so the practice exists and only the prompt is missing. The
richer version reuses the H7 baseline machinery to mark citations stale when the owning file's hash moves.

**The cost here.** Part of one dispatched round, plus a board item that now sends readers 16 lines away
from the code it is about.

---

### 13.7 There is no cross-surface consistency check between a summary and the rows it summarises

**The gap.** A tracker item describes a ledger; nothing checks that its description still matches.

**The incident.** My taxonomy in the campaign tracker filed rows under "no fittable vendor host" that the
ledger later showed were fine. The two surfaces disagreed for hours and nothing noticed. This is also why
§13.5's sweep failed — I searched the ledger, and the claim lived in the tracker.

**The shape of the fix.** Honestly, unclear, and I am flagging this as the weakest entry. It may not be
Sterling's job: the relationship between a project's tracked document and a board item summarising it is
project-shaped. **The generalisable half is §13.2** — if the tracker's counts and group sizes were
`derived_values` with commands attached, the disagreement would have surfaced as a stale number.

**The cost here.** Folded into §13.2 and §13.5; no separate cost claimed.

---

### Not manufactured

I considered and **rejected** several plausible-sounding entries because I could not tie them to a session
incident: a richer permissions model, a diff view over record versions, and a query language. None cost me
anything today and I am not going to spend an author's attention on them.

---

## 14. WHAT WOULD HAVE HELPED — one ordered list

Folding §12 and §13 together and ranking against each other.

**Cheap and mechanical (a few hours each, high return):**

1. **Ignore-file awareness in the frontier check** (§13.3) — one `git check-ignore` call. Removes 8
   false signals per session in this project and restores the true signal's meaning.
2. **Delivery memory in H19** (§13.4) — a per-session id set in the transient dir that already exists.
   Recovers ~70 KB of conductor context per session.
3. **Id-resolution warning on write** (§13.1) — a regex, a lookup, and an advisory line in H21's existing
   shape. Would have caught four bad citations this session and one that has survived two sessions.
4. **`knowledge_append` for strings** (§12.1) and **`board_query {id}`** (§12.2) — small API additions,
   each removing a whole class of workaround.
5. **A `file:line` advisory on write** (§13.6) — one warning string.
6. **Narrow H15's match** so a store path in a compound command does not kill an unrelated `git` call.

**Structural — and there are genuinely only three:**

7. **Durable citation** (§7). Stable, human-visible identity where a reader can tell live from dead *in the
   surface they read*. Every session's worst failures trace here.
8. **`derived_values`** (§13.2). Numbers that know how they were made and when they were last true. This
   single field would have prevented the four-times-wrong tracker, which is the most persistent defect in
   this project's Sterling usage.
9. **Instrument-scoped claims with a change-triggered re-test** (§13.5). Four blocked rows this session that
   were not blocked.

**Roster:** give one agent type read-only board access (§9). It is not clear whether that is cheap or
structural from outside the plugin, so I have left it out of both rankings — but it removed real hand-work
from exactly the resource Sterling is designed to protect.

---

## 15. VERDICT

**I would rather work with Sterling than without it, and it is not close.** This session it stopped me
ruling a 392-row ledger entry from a plate that a stored rule knew was invalid; it handed me a
one-command test that settled an ambiguous render instantly; it blocked an edit backed only by grep
output; and it forced out four captures, one of which was a real design decision parked in a task list
that dies with the session. None of those were catchable by tests, lint, or review.

**The strongest part is the `decision` type — specifically `alternatives_rejected`.** It is the only field
in the system that reliably changes the decision rather than recording it. Writing out why both obvious
alternatives to a consolidation were wrong is what proved the third option correct. `anti_pattern`'s
`trigger`/`wrong_way`/`right_way` split is a close second, because `trigger` is what makes a record findable
at the moment of danger instead of merely true.

**The weakest part is that Sterling validates the shape of a record and nothing about the claims inside
it.** Ids, counts, line numbers and premises all live as free prose, and every one of them rotted this
session — including in records I wrote myself, hours after correcting the same records for the same class of
error, under warnings I had personally authored. The system is excellent at making me write things down and
has almost no opinion about whether what I wrote is still true.

**The sharpest illustration is not any of my mistakes. It is that a warning record about fabricated
citations quotes a fabricated id as its example, is delivered into agent context by the very hooks meant to
help, and is now the mechanism by which that phantom id spreads.** A knowledge base that cannot check its
own references will eventually teach its readers things that were never true. That is the one to fix first.
