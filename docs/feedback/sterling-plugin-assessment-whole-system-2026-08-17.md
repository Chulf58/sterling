# Sterling plugin — whole-system assessment, 2026-08-17

Companion to `sterling-plugin-retrospective-2026-08-17.md`, which holds the session evidence. This file
assesses the **design**. Every claim is grounded in something that happened, but the claim is about the
plugin.

**Context for a reader who did not live the session:** dome-farmer is a solo Godot 4.6 game project with a
Blender asset pipeline. Its Sterling store is mature — a `feature_article`/`decision`/`anti_pattern` query
matched **693 records**. That maturity is what makes this session useful evidence: most of what follows is
about how the design behaves at scale, not on day one.

---

## 6. THE RECORD TYPE SYSTEM

**The carve is broadly right, and one seam is wrong.**

### What works

**`decision` earns its place, and `alternatives_rejected` is the single best field in the system.**
It is what made the session's most valuable catch possible: the conductor needed to know not that the Flak
was ruled, but that *"both fire all barrels together"* had been **offered and refused**, and why. A record
that stored only the outcome would have looked compatible with the new answer. **`alternatives_rejected`
is the field that makes a decision auditable rather than merely recorded** — no other type has an
equivalent and several should.

**`anti_pattern`'s four-part shape (`trigger` / `guidance` / `wrong_way` / `right_way`) is the right
shape**, and `trigger` specifically is what makes delivery work. A hook can match a trigger against a
prompt; it cannot match an essay. The strongest triggers in this store are written as *tells* —
*"THE TELL IS THAT YOU FEEL WELL-INFORMED, NOT UNCERTAIN"* — and those are the ones that fired usefully.

### What does not work

⚠ **`todo` serving BOTH the work board and the maintenance queue, discriminated by a `source` field, is
the clearest design smell in the type system.** They are different things with different lifecycles,
different authors (human vs hooks), different tools (`board_*` vs `maintenance_*`), and different closure
rules. The consuming project's CLAUDE.md has to carry a warning about it:

> *"The slash command is `/sterling:task`; the RECORD TYPE IS STILL `todo` … Label and schema differ on
> purpose; do not 'fix' the type name to match the label."*

And a second warning about the failure it causes:

> *"Never bend metadata to satisfy a validator. `source` rejecting `"conductor"` is not a licence to pick
> `"system"` and then choose the nearest-looking `system_reason`. That is precisely how three engineering
> spikes ended up filed as store maintenance here."*

**A type union that requires a written warning against mis-filing is one type too few.** Split it.

### Dead weight and documentation debt

**`research_finding` has no path field at all**, and the upstream template says it does. The consuming
project carries this correction locally, at length, having paid for it with three rejected writes. That is
**plugin documentation debt showing up as a burden on the consumer**, and it is the sharpest example of a
broader pattern: dome-farmer's CLAUDE.md contains roughly 60 lines of Sterling field shapes, call shapes
and enum values **learned by rejection**. `current_ac` is an array of objects; `dependencies` is an object
whose entries are slugs not paths; `concept_family` is a string not a boolean; `file_baselines` is
server-owned. Every one of those cost a failed write somewhere.

`knowledge_schema(<type>)` exists and is the right answer. **It is not discoverable at the moment of
need** — nothing in a rejection message says "call `knowledge_schema` for the valid set", though the
rejections do name valid fields, which is a real improvement.

---

## 7. IDENTITY, VERSIONING AND SUPERSESSION

**This remains the most expensive design decision in the plugin.**

**Every `knowledge_update` mints a new id.** This session minted at least eight. The consequences observed
directly:

- The consuming project's CLAUDE.md instructs, in bold: *"RESOLVE EVERY RECORD BY SLUG — every update
  mints a new id, and this session minted many."* A convention exists **because the API makes the obvious
  thing wrong**.
- A stored anti-pattern (`5bf1cb1d`) exists solely to warn that audits flagging "dangling" record ids
  **mostly manufacture false alarms**, because a correct citation goes stale the moment its target is
  edited.
- A second (`decae4de`) exists because records cite each other by **8-character prefix** while
  `knowledge_get` needs the full uuid — so constructing the remainder produces a confident lookup for a
  record that does not exist.

**Three stored anti-patterns about identity is not a knowledge base with quirks; it is a knowledge base
whose citation model does not work.** `knowledge_get` accepting an 8-char prefix (it did, this session —
`knowledge_get c0ca81b3` resolved) is a partial mitigation nobody has written down.

**What the design wants and does not have: slug-as-primary-key.** Slugs are stable, human-readable,
already used for resolution, and already how the store's own prose cites records. Ids should be an
implementation detail the surface rarely shows.

**Can a reader tell a live record from a dead one in the surface they actually use?** Partly. Query
results carry `status` and a `supersedes_count`, but **omit the supersedes chain** — you must
`knowledge_get` for full fidelity. In practice this session cited by slug throughout and never hit a dead
record, so the mitigation works. It works by convention, not by construction.

**One new instance this session, and it is a design gap:** `knowledge_edit` rewrote a decision's
`statement` to record four new rulings. **The `title` still said the implications were "NOT yet ruled and
the conflict check is still running".** The record contradicted itself. `knowledge_update` reportedly
warns on this shape; `knowledge_edit` did not. The conductor caught it by re-reading. **A partial-field
edit needs the same self-consistency warning as a whole-record update.**

---

## 8. THE TOOL / API SURFACE

### What is well designed

- **`{matched_filter, returned, cap, capped}` on every query.** Honest about its own incompleteness, with
  a note explaining that `rank_terms` order rather than narrow. **Most retrieval APIs lie about this.**
- **`knowledge_edit` with exactly-once matching**, refusing on both zero and multiple matches with the
  count. Its `chars_before` / `chars_after` receipt proves the edit landed. This is the tool that made
  fix-forward practical on records too large to retransmit.
- **`knowledge_append` for arrays.** Correct by construction, and it removes the class of failure where a
  short draft destroys history.
- **`maintenance_remove` returning `artifact_evidence`.** A closure that shows the durable records
  touching the item's paths since its creation is self-justifying.
- **`projection: "digest"`.** The right primitive for surveying a large store cheaply.

### What costs calls it should not

1. **There is no "does this slug exist" call.** `knowledge_create` explicitly does not dedupe — every
   response carries `"check_skipped": [{"check": "dedup-merge", "reason": "not_built"}]`. **The API
   announces a missing feature on every single create.** The documented workaround is to query with a
   generous cap and eyeball the slug list. A `knowledge_exists(slug)` returning one boolean would replace
   a capped query and a scan.

2. **There is no inbound-link query.** Nothing answers *"which records cite this slug?"*. The session
   needed exactly this twice — once to find what a superseded record orphaned, once to find what the
   `minigun 13` error had propagated into. Both were done by hand. A stored anti-pattern (`1cc211b5`)
   exists about superseding a multi-part decision silently orphaning the parts it never mentioned;
   **that anti-pattern is a missing query wearing a warning label.**

3. **Deep-store retrieval is always a window.** Four for four capped this session, against 693 and 697
   record filters. Raising the cap costs tokens linearly; there is no relevance score to tell you where
   the tail stops mattering.

### The operation the design obviously wants and does not have

**A citation-integrity check.** The store's own prose is dense with record ids, slugs, `file:line` cites
and counts. Nothing verifies any of them. This session found a decision citing a part count that matched
no real population, an article citing an export result two runs stale, and a rotation note describing an
exporter mechanism that had not existed for weeks. **Every one was found by a human reading carefully.**

---

## 9. THE AGENT ROSTER

**The constraint model is sound and produced better work than an unconstrained agent would have.**

The clearest case: a `test-writer`, blocked from the implementation, wrote assertions that pinned
**behaviour** rather than mirroring code. Its AC2 asserts on **node identity** rather than name — reasoning
that both candidate nodes share a name, so a name assertion would pass while measuring nothing. **An agent
that could see the implementation would very likely have asserted the easy thing.** The blindness produced
the better test.

**But the roster has a structural hole around exactly that agent.** H4 guarantees it must guess the entry
point; the consuming project's CLAUDE.md carries a stored anti-pattern (`16f6b58c`) whose whole subject is
that a blind author's assumed signature does not produce a red test — **it produces a scan error that
blocks every suite in the project.** That happened again this session, for the second recorded time.

**The fix is not to relax H4.** It is to give the conductor a supported channel for supplying the exact
entry point. Today that is prose in a brief, which is exactly the weakest source in the room. **A
structured `signatures` field on a test-writer dispatch — verbatim, conductor-supplied, hook-verified
against the source — would close it.**

**Tool-list mismatches observed:** none dispatched wrongly this session, because the watchdog prompt
explicitly warns to check tool lists first (citing `55577e13`). Two were avoided consciously: a librarian
cannot touch board items, so the goal tracker was updated by the conductor; a test-writer has no Bash, so
its file failed `gdformat --check` and the conductor fixed the wrapping. **The second is a real gap — an
agent that owns a file but cannot run the gates on it will produce gate failures every time.**

---

## 10. THE BOARD AND THE MAINTENANCE QUEUE

**Signal was better than in prior sessions, and the queue's failures were in both directions.**

**Items closed this session: 3.** Of those:

- **2 were already paid** (`asset-swap-mech-census`, `demo-scene-mount-reader` — both flagged
  `reconcile_needed` because a file changed under them, both verified accurate and closed **with no
  write**). The drain rule that an already-paid item closes with removal and **no** version bump is
  correct and was followed. A version bump claiming a reconcile that added nothing is itself drift.
- **1 was genuinely outstanding and two days old** — a `capture_owed` demanding a human open rendered
  plates. **It could not be closed by any agent, because the duty is "a conductor looks at a picture".**

⚠ **The queue misled in the OUTSTANDING direction, which is the less-discussed failure mode.** That
`capture_owed` item said the open question was *"checking a -90° rotation isn't a vendor-unauthored
artifact"* and gated it on *"before the socket-widening commit lands"*. **The commit it gated had already
landed, weeks earlier.** An item can rot by describing work as pending when its gate has passed, and it
reads exactly as urgent as a live one.

**The board's real problem is scale, and it is unaddressed:** the goal-tracker item records that **233
board items have never been triaged**, and that a prior re-audit found **5 of 8** open defects wrong.
**There is no mechanism for board staleness at all** — no age signal, no re-verification prompt, no
`last_verified` field. The consuming project has had to write its own discipline section about it
("A stale board is worse than an empty one"). **That is a plugin capability appearing as project prose.**

---

## 11. THE CONDUCTOR CONTRACT — ENFORCED VS PROSE

| Rule | Enforced by | Reality |
|---|---|---|
| Read before edit | **H3** | ✅ Mechanically enforced. Refused twice, correctly. |
| Tests frozen | **H5** | ✅ Enforced, arguably over-enforced. |
| Test author blind to implementation | **H4** | ✅ Enforced. |
| Capture what was decided | **H10** | ✅ Demanded, with honest escape hatches. |
| Every affected article reconciled | **H7 / H10** | ⚠ Partial — the demand fires; correctness of the reconcile is unchecked. |
| Retrieval before work | H19 / H20 | ⚠ **Delivery is not retrieval.** Both react to what you already touched; neither can cover territory you are about to design in. |
| **The conductor runs the gates itself** | **Nothing** | ❌ Prose only. |
| **A subagent result is evidence, not a verdict** | **Nothing** | ❌ Prose only. |
| **A design question is always an ask** | **Nothing** | ❌ Prose only. H20 audits *after* the answer. |
| **Every path in a brief is grepped that turn** | **Nothing** | ❌ Prose only. Failed this session — a vendor prefab path in a brief was one directory short. |
| **Look at every render yourself** | **Nothing** | ❌ Prose only. |

**The highest-value unenforced rule is "a subagent result is evidence, not a verdict".**

It is unenforced, it is the one most likely to fail on a tired session, and this session produced two clean
instances: an agent's *"I confirmed both files exist"* was true and useless (wrong file, crashed run,
exit 0), and a reviewer's confident *"the ruling is vacuous for six weapons"* did not survive one `awk`.
**Both were caught only because the conductor happened to check.** A mechanism as simple as requiring any
agent claim of the form *"all N"* to carry the command that produced N would cover most of it.

---

## 12. WHAT IS STRUCTURALLY MISSING

Concrete, named, in value order.

1. **H20 must be able to fire BEFORE the question reaches the user.** Its own text concedes it is
   post-answer *"(probed 2026-08-11)"*. This session it recovered a settled ruling that had, for one tool
   call, been reversed. **The single highest-value change in this document.** A `PreToolUse` matcher on
   `AskUserQuestion` that surfaces subject-matched decisions **before** the form renders would convert
   the plugin's best catch from a recovery into a prevention.

2. **Ignore-file awareness in the frontier check.** H19 demands owning articles for gitignored render
   output. ~2,900 such files here. One `.gitignore` consult.

3. **A success predicate on toolchain entries.** `.sterling/config.json` carries command prefixes with no
   notion of what success looks like. A `success_pattern` field (`EXPORT_PART_LIBRARY_OK`) would have
   caught a Blender run that crashed on its first line and **exited 0**.

4. **A `signatures` channel for blind test authors.** Conductor-supplied, verbatim, hook-verified against
   the source. Closes the H4/H5 composition that made a project-wide scan error a conductor-only repair,
   twice now.

5. **An inbound-link query.** *"What cites this slug?"* Would make supersession auditable and would have
   found where a wrong part count had propagated.

6. **`knowledge_exists(slug)`.** The API announces `dedup-merge: not_built` on every create.

7. **Self-consistency warning on `knowledge_edit`**, matching the one `knowledge_update` already has. A
   partial edit left a record's title contradicting its own body this session.

8. **Board staleness signalling.** A `last_verified` timestamp and an age-based prompt. 233 untriaged
   items with a measured 5-in-8 error rate is a real liability with no mechanism pointed at it.

**Honest count: two of these are structural (1 and 4). The rest are cheap** — a config field, an ignore
consult, two new queries, one warning, one timestamp.

---

## 13. WHAT WOULD HAVE HELPED, BY VALUE

**Structural (2):**
- Pre-ask subject delivery on `AskUserQuestion` (§12.1).
- A supported signature channel for `test-writer` (§12.4).

**Cheap and mechanical (6):** ignore-file awareness; toolchain success predicate; `knowledge_exists`;
inbound-link query; `knowledge_edit` self-consistency warning; board `last_verified`.

**Documentation, not code:** publish the field shapes. Roughly 60 lines of dome-farmer's CLAUDE.md are
Sterling field shapes and enum values learned by rejection, including a correction to an upstream template
that is still wrong. **Every consuming project is paying that cost separately.**

---

## 14. VERDICT

**The strongest part is the subject-axis delivery (H20) paired with `alternatives_rejected`.** Together
they caught a settled user ruling being silently reversed by a question that should never have been asked —
a failure with no test, no error and no symptom, which nothing else in the stack could have detected. That
one catch justifies the plugin's existence in this project. The rotation-note mechanism (H1) is a close
second: a fresh session resumed exact, in-flight work in a single turn.

**The weakest part is identity.** Every update mints a new id, three separate stored anti-patterns exist
about the consequences, and the consuming project has had to adopt "resolve everything by slug" as a
written convention **because the API's obvious path is the wrong one**. Nothing else in the design forces a
project to write rules against its own tool surface.

**The most damaging single decision is that `todo` serves two surfaces.** It has already mis-filed
engineering spikes as store maintenance here, and it requires a written warning not to "fix" the mismatch.

**Would I rather work with it than without it?** Yes, and not marginally. This session made four
user-facing design rulings, shipped a two-sided defect fix across an exporter and seven consumers, and
caught a wrong two-week-old claim in its own store. **Three of those four outcomes trace directly to
something the plugin delivered unprompted.** Without it, the Flak reversal ships, the damage-type question
gets asked again for no reason, and the plate-probe brief goes out with a hole in it.

The design is sound. Its retrieval is excellent and its identity model is not, and the gap between those
two is where all the remaining cost lives.
