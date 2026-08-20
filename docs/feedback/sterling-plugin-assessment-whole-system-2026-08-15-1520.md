# Sterling plugin — whole-system assessment, 2026-08-15 (afternoon)

Companion to `sterling-plugin-retrospective-2026-08-15-1520.md`, which carries the session evidence. This file assesses the **design**. Every point is grounded in something that happened, but the claim is about the plugin.

**Written by:** the conductor of a ~3.5-hour conductor-direct session in dome-farmer — 8 commits, ~25 dispatches, a 278-part render batch, three Blender library exports. Sterling is consumed here, never developed here.

---

## THE ONE THING TO FIX FIRST

**Knowledge is delivered by PATH, and the most expensive failures are about ACTS.**

H19 fires when you touch a file the store owns. That is a good mechanism and it worked repeatedly this session. But the session's worst error was sending a user 14 rendered plates for a ruling that the owning article explicitly forbade — and **nothing fired**, because:

- the plates are gitignored PNGs under `tools/blender/out/`, so no record can own them (this is a *user ruling* in the project, not an accident);
- `SendUserFile` is not a hooked tool;
- the governing record was one hop upstream, on the *script that produced* the artefact.

Meanwhile H19 fired **6 times** on those same PNGs to say "UNOWNED — no owning article exists," a warning that can never be actioned because a record must never own them.

**So the same design was simultaneously too loud and completely silent, in the same directory, in the same minute.** That is not a tuning problem. Path-scoped delivery cannot express "this artefact inherits its producer's known defects," and it cannot express "do not perform this ACT."

**Concrete asks:** (a) make the frontier check ignore-file aware — a path matched by `.gitignore` should never raise `article_missing`; (b) add a **provenance edge** so a record can declare "I govern the outputs of this script," and have the frontier check follow it; (c) let a record carry a `blocks:` assertion that is delivered on the *act*, not the path.

---

## 6. THE RECORD TYPE SYSTEM

**The carve is broadly right.** `decision` (why, and what was rejected), `anti_pattern` (what not to do, with the incident), `research_finding` (a measured answer with two clocks), `feature_article` (what an area does and what it owns) genuinely answer different questions. I used all four this session and never once wanted to collapse two.

**`alternatives_rejected` is the single best field in the system.** It is the only field anywhere that prevents re-litigation, and it did so three times today. When I put the socket-datum fix to the user, the record I wrote carried the refuted repair — *"subtract from the socket; already tried and rejected at `:1487-1501`"* — so the next reader cannot re-propose it. No other record type in any tool I have used has this.

**Dead weight I observed:**
- `live_test_refs` — every article I touched had `[]`.
- `dependencies.relied_by` — consistently empty; the inverse edge is never maintained.
- `state` / `state_reason` — the enum (`planned|built|wired_in|active|dormant|deprecated`) has no `partial`, and the project's own CLAUDE.md documents the workaround: *"a half-built concept is `built` with the split stated in the FIRST LINE of `state_reason` (that field is optional, so nothing enforces the caveat — it is on you)."* **A required-caveat pattern enforced by nothing is a field that will be wrong.**

**The type that is missing: a PROGRESS LEDGER.** This project invented one by hand — `docs/mech-asset-inspection-log.md`, a tracked 2,268-line markdown table of 392 parts with an `inspected` column. It exists because *the store cannot hold per-item progress across a `/clear`*. A `feature_article` is prose; a `todo` is one work item; a `research_finding` is one answer. None of them models "392 things, each with a state, each turning `Y` only on a human ruling." The project also had to write its own rule that a structural probe passing never counts. **That is a first-class concept the plugin does not have.**

---

## 7. IDENTITY, VERSIONING, SUPERSESSION

**This remains the most expensive area, and the failure mode has changed shape rather than gone away.**

Every `knowledge_update` mints a new id. The consequence, lived twice today:

**(a) A live gate read as dead through a two-hop chain.** `0d3ca823` → superseded → `5fc265a8` → superseded → `72d92a0e`. A reader stopping at hop one sees `status: "superseded"` and reasonably concludes the constraint is historical. It was live. **And the terminus reversed the cause** — the first says our exporter *invented* a rotation, the last says it *kept the source file's value because nobody read the vendor's*. Same slug, opposite fix, and only the last is true.

**(b) Prose citations rot by design.** The project's CLAUDE.md instructs resolving records **by TITLE** rather than id for exactly this reason, and names a decision whose id changed within a minute of being cited. **When a consuming project's house style is "do not use the primary key," the primary key is wrong.**

What works: `slug` is stable for `feature_article` and I used it successfully all session. `knowledge_get` accepted an 8-character prefix (`0d3ca823`) and resolved it — undocumented as far as I know, and useful.

**Concrete asks:** (a) `knowledge_get` should return the **terminus** of the supersession chain by default, or at minimum a `superseded_by_chain: [...]` and a `terminal_id`; (b) give every record a stable slug, not just articles; (c) when a record is superseded, surface **what changed** — a one-line `supersession_reason`, since a reversal of cause is invisible today.

---

## 8. THE TOOL / API SURFACE

**The best thing in the API is `knowledge_edit` with an array selector.** `field: "files[path=game/spike/track_uv_probe.gd].role"`, refusing on zero or multiple matches, returning `chars_before`/`chars_after`. Targeted, unambiguous, cheap, safe. It is the correct answer to "edit one field inside a large record."

**The read side has no equivalent, and that is the gap.** To read one `files[].role` I had to `knowledge_get` a 15-entry article. **There is no projection or field selector on reads.** `projection: "digest"` exists for queries but not for a targeted get. That single asymmetry — surgical writes, whole-record reads — is the clearest structural hole in the surface.

**Things learned only by rejection.** The project's CLAUDE.md carries a long, bruised list, and **that list is the plugin's documentation debt showing up as a consuming project's burden**:

- `research_finding` has **no** `title` and **no** `file_keys` — "put the paths inside `answer`, or the finding is unreachable by a path query." The record notes the plugin's own template still says otherwise, and that three writes were rejected before this was learned.
- `volatility_hint` is a closed enum `fast|medium|stable`; `"low"` is refused.
- `current_ac` is an array of objects, not strings. `dependencies` is an object, not an array. `concept_family` is a string (the family's slug), not a boolean.
- `file_baselines` is server-owned and must not be passed.

`knowledge_schema(<type>)` exists and is the right answer — but the fact that a mature consuming project maintains ~40 lines of field-shape errata says the schema tool is not discoverable at the moment of need.

**An operation the design obviously wants and does not have:** a way to ask **"what governs this ACT?"** rather than "what governs this path." Also missing: a cheap **"has this record been superseded since I read it"** check, which is what a long session actually needs.

**One good surprise:** `maintenance_remove` on an already-drained item returned a precise, actionable error — *"was ALREADY REMOVED at … most likely auto-drained by a knowledge_update re-baseline."* That is exemplary error text.

---

## 9. THE AGENT ROSTER

**The tool lists are mostly right, and the constraints improved outcomes.** The librarian's inability to author content is why it *reported* a live gate instead of quietly editing around it (retrospective §1.1). The test-writer's blindness to implementation is the same idea. **These are the design working.**

**But I dispatched work agents structurally could not do three times in one session:**

| Dispatch | Missing tool | Cost |
|---|---|---|
| Build a key list + write a file → `explorer` | no `Write`, no shell | full round |
| Audit the board → `explorer` | no `board_query` | full round; agent delivered a partial answer and correctly signalled `blocked` |
| Update a board item → `coder` | no `board_update` | full round; agent reported `tool_grant_missing` |

**`anti_pattern 55577e13` in this very store describes exactly this mistake.** I had read it. I repeated it three times. **A rule that lives only in prose fails on a long session** — and this one is *mechanically checkable*: the dispatch names an agent type, and the plugin knows that type's tool list.

**Concrete ask:** a PreToolUse check on `Agent` that greps the brief for tool-shaped verbs ("write a file to", "`board_update`", "run `git`") and warns when the named `subagent_type` lacks them. This is the single cheapest high-value hook the plugin does not have.

**One roster gap:** agents that must *measure* need Bash, but `explorer` (the read-and-conclude agent) has none, so measurement work goes to `coder` or `debugger` — agents whose briefs then have to say "do not edit anything," which I wrote five times today. A read-only agent **with** shell is the missing seat.

---

## 10. THE BOARD AND THE MAINTENANCE QUEUE

**The board is past the point of usability and the tooling does not say so loudly enough.**

`board_query source:"user"` returned `matched_filter: 201, returned: 60, cap: 60, capped: true`. The board carries **201 open items**. A dedicated board-prune item on the board says *"A board too large to read is a board nobody will audit."*

**The queue's signal was better than expected.** A librarian drain verified 17 drainable items against HEAD and closed **9** as already-paid, leaving 8 with real work — a ~53% already-done rate, and it closed them with `maintenance_remove` and no knowledge write, per the rule that a version bump claiming a reconcile that added nothing is itself drift.

**The direction of staleness that hurt most was "claims work is OUTSTANDING."** The objective tracker `c0c379ea` told a fresh session the asset pack was not yet chosen and work must not start, while the swap was most of the way done. It had already been rewritten once for that; **I then made it stale twice more in a single session.**

**Concrete ask:** a board item should carry a `last_verified_against` commit sha, and `board_query` should mark items whose sha is behind HEAD. The project already does this by hand — items open with "re-verified 2026-08-15 at HEAD `c1da9d7`" — which is exactly the shape of a field the system should own.

---

## 11. THE CONDUCTOR CONTRACT — ENFORCED VS PROSE

| Rule | Enforcement |
|---|---|
| Store writes go through MCP | **Mechanism** (H15) |
| test-writer cannot read implementation | **Mechanism** (H4) |
| Subagent command allowlist | **Mechanism** (H14) |
| Capture before session end | **Mechanism** (H10 + `no_capture`/`capture_pending`) |
| Reconcile owning articles | **Mechanism** (H7 → queue) |
| Hand-written article writes should be librarian-shaped | **Mechanism** (H21) — fired twice, correct both times |
| **Open every render before repeating a claim about it** | **PROSE ONLY** |
| **A subagent result is evidence, not a verdict** | **PROSE ONLY** |
| **Check the agent's tool list before dispatching** | **PROSE ONLY** — failed 3× today |
| **Do not conflate a socket with the geometry it holds** (i.e. state the right noun) | **PROSE ONLY** — failed once, into a record the user ruled from |

**The highest-value unenforced rule is "open the picture."** This project has shipped a flat-rake creature, a 0-of-50-hits weapon, an empty render reported as fine, and 28 plates with the gun barrel at the floor behind a fully green probe. **Today it produced four more classes of plate that render, pass every structural assertion, and are useless to rule from** — buried inside the host, stuck at the world origin, displaced by a datum, rotated by a discarded delta. Every one was found by a human opening an image.

Nothing in Sterling can enforce that. But it could **record** it: there is no way to mark "this artefact has been visually inspected by a human, at this commit." The project again invented one by hand — a tracked ledger with a `Y`/`N` column and a written rule that a structural probe passing never counts.

---

## 12. WHAT IS STRUCTURALLY MISSING

1. **Act-scoped delivery.** The gate that mattered governed *showing something to a user*, not touching a file. §1.
2. **Provenance edges.** "This record governs the outputs of this script." Would have closed the same gap from the other side.
3. **Ignore-file awareness in the frontier check.** 6 unactionable warnings in one session, in a directory a user ruling requires to be gitignored.
4. **A progress-ledger record type.** 392 items with per-item human-verified state, surviving `/clear`. Hand-built here.
5. **A visual-inspection attestation.** "A human opened this image at commit X." The one gate this domain actually needs.
6. **Field-selective reads.** The write side has surgical `knowledge_edit`; the read side has none.
7. **Supersession-chain resolution.** Return the terminus, and say what changed.
8. **A dispatch pre-flight check** against the target agent's tool list.
9. **Staleness marking on board items** relative to HEAD.
10. **An "in-flight file" notion** so H10 stops counting an agent's uncommitted edit as the conductor's uncaptured work.

**Honestly counted: 1, 2, 4, 5 and 7 are structural. The rest (3, 6, 8, 9, 10) are mechanical and small.**

---

## 13. WHAT WOULD HAVE HELPED, BY VALUE

1. **Dispatch pre-flight against the agent's tool list.** Cheap, mechanical, would have saved three full rounds today, and the store already contains the anti-pattern describing the mistake.
2. **`.gitignore` awareness in H19/H10 frontier logic.** Cheap. Removes a channel that currently trains you to ignore it.
3. **`knowledge_get` returning the supersession terminus,** or a `terminal_id`. Cheap-ish, and it prevents live constraints reading as dead.
4. **Field-selective reads.** Mechanical. Would have cut my single largest wasted delivery by ~85%.
5. **`last_verified_against` sha on board items,** surfaced by `board_query`. Mechanical, and the project already fakes it in prose.
6. **A provenance edge + act-scoped delivery.** Structural, the largest, and the one that would have prevented the session's worst error.
7. **A progress-ledger type and a visual-attestation record.** Structural. Both currently hand-rolled in a markdown file this project treats as more authoritative than the store.

---

## 14. VERDICT

**Strongest part: `alternatives_rejected`, and the discipline it enforces.** Three times today it stopped a settled question being re-opened, including once when I was about to re-propose a repair the code itself already recorded as tried and failed. Nothing else in my toolchain does this, and it is the reason I would keep Sterling.

**Second strongest, and more surprising: the agent roster's constraints.** The librarian's inability to author content is precisely why it surfaced a live gate rather than quietly editing past it. Constraint produced a better result than capability would have.

**Weakest part: path-scoped delivery as the universal mechanism.** It is loud where it cannot help (6 unactionable warnings on gitignored renders) and silent where it was needed (a standing prohibition on an act I then performed). Both in the same directory, in the same minute. That is a design limit, not a threshold to tune.

**A pattern worth naming for the plugin's authors:** almost everything Sterling could not do, this project has hand-built in markdown — the progress ledger, the visual-inspection column, the "re-verified at HEAD" convention, and ~40 lines of field-shape errata in CLAUDE.md. **Those hand-built things are a specification.** They are what a mature consumer needed badly enough to build itself.

**Would I rather work with it than without it? Yes, and not narrowly.** This session made 8 commits, and at least four of them are correct *because* a record or a constrained agent contradicted me. The plugin's core bet — that the expensive thing is not the code but the reasoning behind it, and that reasoning must be captured where the next reader will hit it — is right. The delivery layer is where it is currently losing.
