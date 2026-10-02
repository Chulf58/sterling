# Sterling — assessment of the whole system

**Companion to** `sterling-plugin-retrospective-2026-08-14-2030.md`, which is session-scoped. This one is
about the plugin as a **design**: what the idea gets right, what is structurally wrong, and what is
missing. Written from sustained use in one project (dome-farmer, a Godot + Blender game) across many
sessions, most recently a 4-hour, 20-agent, 4-commit session.

**What I cannot assess, stated up front:** I have not used the gated pipeline/run mode, `/sterling:cleanup`,
`/sterling:init` from scratch, `/sterling:merge`, the council, or the TUI dashboard in enough depth to
judge them. Everything below is about the **knowledge store, the hooks, the agent roster, the board, and
the conductor contract** — the parts I use constantly.

---

## PART 1 — WHAT IS GENUINELY GOOD

### 1.1 The core insight is right, and it is not obvious

Sterling's central bet is: **an agent will not remember, so deliver the knowledge at the moment of use.**
Not a wiki you are supposed to consult. Not a CLAUDE.md you are supposed to have read. A hook that fires
when you touch the file and puts the governing record in front of you.

This is correct, and it is the thing most "AI memory" designs get wrong by building a searchable archive
and hoping. Retrieval you must *remember to perform* is retrieval that does not happen. Delivery-at-use
does.

### 1.2 The record type system is the best-designed part

Five types, each answering a different question:

| Type | The question it answers | Why it must be separate |
|---|---|---|
| `feature_article` | What does this area do, and what does it own? | Describes the present |
| `decision` | Why is it this way, and what was rejected? | Code can never tell you this |
| `anti_pattern` | What goes wrong here, and how do I recognise it? | Indexed by *symptom*, not by location |
| `research_finding` | What did we measure or look up, and when? | Carries staleness |
| `reference_material` | Where is the external thing? | A pointer, not a copy |

Collapsing any two would lose something real. `decision` and `feature_article` in particular are
constantly confused in other systems, and separating "what it does" from "why it is that way and what we
refused" is what makes the store worth reading.

### 1.3 `anti_pattern` is the standout, and its schema is why

`trigger` / `guidance` / `wrong_way` / `right_way` / `source_evidence` is a **teaching format**, and the
critical field is `trigger` — because it indexes by *what you are about to do*, not by where the bug was.
That is what lets a hook fire on a mechanism you have never touched before.

The strongest records in this project's store are ones whose trigger begins *"THE TELL IS…"* and then
names a checkable observable. Those fire correctly on files they were never written about. That is real
transfer, not retrieval.

### 1.4 `alternatives_rejected` is the single best field in the schema

A decision's *statement* tells you what was chosen. `alternatives_rejected` tells you **what you are about
to re-propose, and why it lost.** In this session it stopped me twice and caught a shipped error once.

Most decision-logging systems record only the outcome. Recording the refused options — with reasons, and
crucially with *"this was the safer engineering choice and it was declined"* — is what makes a decision
record able to argue back.

### 1.5 Supersede-forward instead of delete

Never hard-deleting knowledge is right. A wrong record that was acted on is itself history, and the
reasoning that produced it is usually sound even when the fact was wrong. (See §2.1 for the part of this
that is badly broken.)

### 1.6 The two clocks on `research_finding`

`source_date` + `capture_date` + `volatility_hint` is the correct model for external facts: *when the world
said it* and *when we wrote it down* are different, and staleness is a property of the question, not the
answer. Few systems bother.

### 1.7 Board vs maintenance queue split by `source`

`todo` + `source: "user"` = work someone must do. `todo` + `source: "system"` + `system_reason` = store
hygiene. Same type, different surface. This keeps engineering work from drowning in reconcile noise, and
it is a clean design — one record type, two views.

### 1.8 The conductor contract, as a document

"You are the hands; the brain decides." Pinned models per agent. The decision never delegated. The
prohibition on an agent running git. Requiring the conductor to run the test suite itself rather than
trust an agent's report. **These are correct and hard-won**, and the fact that they read as obvious is
because they are well-stated.

### 1.9 Agents as context firewalls

The framing that a subagent exists primarily to **protect the conductor's context window** — not to be
fast, not to parallelise — is the right primary justification, and it changes how you brief. A dispatch
that returns a conclusion instead of material is a fundamentally different thing from one that returns a
file dump.

---

## PART 2 — WHAT IS STRUCTURALLY WRONG

### 2.1 ⚠ IDS ARE THE PRIMARY KEY AND THEY ARE NOT STABLE. This is the deepest flaw.

**Every `knowledge_update` mints a new id.** The old id still resolves, still reads authoritatively, and
gives no sign it is dead.

The consequences compound:

- **You cannot durably cite a record.** Anywhere. Not in a code comment, not in a commit message, not in
  a board item, not in another record. This project's commit messages from this session cite record ids
  that may already be stale.
- **The system's own advice is to resolve by slug or title** — but *every API returns ids*, every hook
  delivers ids, and `knowledge_get` takes an id. The primary interface uses the unstable key while the
  documentation says not to.
- **Chained writes fail.** Twice this session a librarian got a 409 because a second write used the id
  returned before the first. That is a papercut every single time anyone edits two fields.
- **And the fatal case:** a superseded record is indistinguishable from a live one in query results and
  hook deliveries, because the projections omit the supersession chain. I cited a dead decision in an
  agent brief this session, re-imposed a filter the user had explicitly rejected, and shipped a manifest
  missing 39 rows of vendor data. Every gate passed.

**This is one design decision and it is the wrong one.** The fix is not exotic: `slug` (or a stable
`record_uuid`) should be the identity, with `version` as a separate field. If mint-on-write is
load-bearing for provenance, then at minimum:

1. Every projection returns `status: active | superseded` and `superseded_by`.
2. Hooks refuse to deliver a superseded record as a live pointer.
3. `knowledge_get` on a superseded id returns the successor with a loud banner.

### 2.2 Articles grow monotonically and there is no archival story

`history` appends forever. `files[]` accumulates. Prose gets fixed forward by *addition*, because
correcting in place risks losing the record of the error. So articles only ever get bigger.

This session an article crossed the size threshold and the system's response was a maintenance item
saying, effectively, *"split it — and splitting is a judgement, so a human must do it."* That is not a
solution; it is a notification that the design has no answer.

Missing: a `history` archival policy, a `superseded_prose` section, or article sharding by version epoch.
Something must be able to say *"this article's first 40 versions are cold storage."*

### 2.3 The store models KNOWLEDGE but not DATAFLOW — and this session's worst production bug lived exactly there

A pipeline component in this project resolved **349 of 349** vendor placements into a JSON file, perfectly,
for weeks. **Nothing read that file.** The consumer wrote the same field from a heuristic instead. Both
components had their own `feature_article`. Both were individually correct and green. The integration was
the thing with no owner.

The store has `dependencies: {relies_on, relied_by}` — declared by hand, verified by nobody. There is no
mechanism that notices *"article A says it produces X; no article claims to consume X."*

**This is a real, checkable, automatable class of defect**, and it is exactly the sort of cross-component
truth a knowledge store should own, because no single file's tests can see it.

### 2.4 The maintenance queue is mtime-driven, so it cannot distinguish "changed" from "invalidated"

Regenerating 358 asset files produced 19 `reconcile_needed` items. **Twelve were noise** — the owning
articles' prose was entirely current; only file hashes had moved.

A queue that is 60%+ false positives trains its reader to bulk-close, which is precisely when the real one
gets closed unread. The system half-knows this: it warns that a deep queue is *"mostly ALREADY-DONE work
that was never closed."* That is a design smell being documented rather than fixed.

**The check should be semantic, not temporal**: did the change touch a symbol, path, or claim the article
actually asserts? Even a crude heuristic — did the diff touch a line the article quotes? — would cut this
enormously.

### 2.5 Provenance of a number is prose, not structure

The store cannot distinguish, structurally, between:

- a figure someone **measured this turn**,
- a figure **quoted from another record**,
- a figure **derived by arithmetic**,
- a figure someone **remembered**.

This project has had to invent that discipline in prose, and its CLAUDE.md now contains extensive rules
about it, plus anti-patterns recording what each confusion cost (a count propagated through a record whose
own list held a different number; a confident absence claim stated aloud three times before anyone
checked). **The store should carry `basis` on a claim, not just on a record.**

At minimum: a convention-enforced `measured_at` / `measured_by` on numeric claims, or a `claims[]` array
with per-claim provenance. Prose discipline does not survive a tired session.

### 2.6 The conductor contract is enforced by prose, and prose is not a mechanism

Most of the contract is *"you must remember to…"*. Some rules have hooks. The most important ones do not:

- *"Run the suite yourself before committing"* — no gate.
- *"Open every render before repeating a claim about it"* — no gate. (This project's single most valuable
  rule, entirely unenforced.)
- *"Check the store both ways before asking the user"* — no gate.
- *"Re-verify a board item against HEAD before dispatching at it"* — no gate.

The hooks that exist are mostly *reactive* (you touched a file; you did not capture). The rules that
matter most are *prospective* (before you claim, before you ask, before you commit). **A pre-commit hook
that refuses when the suite has not been run this session would be worth more than several of the
existing deliveries.**

### 2.7 The schema is discoverable mainly by rejection

This project's CLAUDE.md contains a long, hard-won list of field shapes that *"are NOT what prose suggests,
and each cost a rejected write"* — `current_ac` is objects not strings; `dependencies` is an object not an
array; `concept_family` is a slug not a boolean; `file_baselines` is server-owned; one type has no path
field at all while the plugin's own template says it does.

`knowledge_schema(<type>)` exists and is the right answer. But the fact that a consuming project had to
accumulate that list by trial and error — and that one entry documents the plugin's **own template being
wrong** — is a documentation failure upstream, not a project failure.

### 2.8 Domain stores exist but appear not to earn their keep

Cross-project promotion is built. In this project it is **switched off by standing user ruling** — *"Dont
promote any knowledge"* — and a review of twelve promotion candidates this session declined all twelve,
because every question named this project's own pack, scene or artefact.

That is a real signal. Either the promotion test is too strict, or **most engineering knowledge genuinely
is project-shaped** and the domain-store concept is solving a problem that does not exist at this scale.
Worth deciding deliberately rather than leaving a lane that only ever generates declines.

### 2.9 Hook output has no volume or severity control

Deliveries of 10–17 KB were routine this session; three were large enough to be spilled to disk. A single
delivery commonly carried 3–4 full anti-pattern bodies plus 5 decision pointers, of which typically one
mattered.

There is no `verbosity` config, no per-hook cap, no "you have seen this record 6 times this session,
here is the id only". In a system whose stated primary value is **protecting the context window**, the
delivery mechanism is one of the larger consumers of it.

---

## PART 3 — WHAT IS MISSING

1. **A "what governs this file?" query.** There is no single call that returns the full governing set —
   owning article, decisions, anti-patterns, open board items, open queue items — for a path. Every
   session reconstructs it from two or three queries on different axes, and this project's CLAUDE.md has
   to *teach* the two-axis technique because the API does not offer it as one operation.

2. **Contradiction detection.** Nothing notices when a new measurement contradicts a stored claim. This
   session produced at least four such contradictions (a socket count, a placement count, an owed-work
   count, an article's acceptance criterion). Every one was caught by a human or an agent reading
   carefully. A store that holds `24` while a fresh run reports `27` could say so.

3. **Staleness on decisions.** Only `research_finding` has clocks. A `decision` resting on a measured
   premise has no way to say *"this premise was measured on date D and would be invalidated by X."*
   Several decisions in this project's store carry that caveat **in prose**, which means nothing can act
   on it.

4. **Bulk operations.** Closing twelve queue items is twelve calls. Correcting the same stale claim in
   three articles is nine. This is why mechanical store work has to be delegated — not because it is
   hard, but because it is chatty.

5. **A dry-run / preview mode for writes.** `knowledge_edit` refuses on zero or multiple matches, which is
   good. But there is no way to see what a write *would* do before doing it, which matters because
   `knowledge_update` silently keeps every field you do not pass.

6. **Agent capability introspection at dispatch.** A brief that needs shell access sent to an agent
   without it wastes a full round. The dispatching hook already reads the prompt; it could check.

---

## PART 4 — VERDICT

**The idea is right and the type system is excellent.** Delivery-at-use beats retrieval-on-request, and
the split between what-it-does / why-it-is / what-goes-wrong / what-we-measured is a genuinely good
ontology. `anti_pattern`'s trigger-indexed format and `decision`'s `alternatives_rejected` are the two
features I would port into any other system tomorrow. The conductor contract is a serious piece of
thinking about how to run agents safely, and most of its rules are rules I would have had to learn
expensively otherwise.

**The deepest flaw is that identity is unstable.** Mint-on-write means nothing can be durably cited, the
documentation has to tell you not to use the primary key, chained writes fail routinely, and — worst — a
superseded record is invisible until fetched individually. That last one cost real, shipped, silently-wrong
data this session and there is evidence of the same shape weeks earlier. **If one thing changes, it should
be that.**

**The second-deepest is that the system models knowledge but not dataflow or provenance.** It knows what
each component is; it does not know what reads what, and it cannot tell a measured number from a
remembered one. Both gaps produced defects this session that every individual green check missed.

**The friction is mostly cheap to fix** — ignore-file awareness, queue dedup, delivery caps, giving one
agent type three tools it obviously should have. The structural items are not cheap, but there are only
about three of them, and they are clearly identifiable.

Net: I would rather work with this than without it, by a wide margin, and the errors it caught this
session were the expensive kind — a shipped-broken asset set, a UI string lying to the player, a stale
board claim that a second agent then "confirmed". That is a system earning its cost. The gaps above are
what would make it earn considerably more.
