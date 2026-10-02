# Sterling plugin — whole-system assessment, 2026-08-17 evening (18:20)

Companion to `sterling-plugin-retrospective-2026-08-17-1820.md` (Part A — the session evidence). This document
reviews the **design**: record types, identity, tool surface, agent roster, board/queue, contract, and what is
structurally missing. Session facts are cited as evidence; the claims are about the plugin.

**Evidence base:** one long conductor-direct session on dome-farmer (Godot + Blender), ~14 subagent dispatches,
three full suite runs, one commit, 2 decisions / 2 anti-patterns / 1 feature article created, ~6 records edited
forward.

---

## THE HEADLINE, PUT FIRST

**The subject-axis delivery (H20) is the best thing in this plugin, and it is carrying the whole system.** Six of
this session's eight caught defects came from it, and every one was a defect in *my own brief* that no test, lint
or format gate could see. If I could keep exactly one mechanism, it is this one.

**The worst thing is not a hook — it is that the plugin's most valuable checks all fire at PostToolUse or
post-answer, so they diagnose rather than prevent.** The dedup gate on `knowledge_create` and H3's read-evidence
refusal are the only two mechanisms I hit all session that *blocked* an action. Everything else told me about a
mistake I had already made, or about a mistake I was about to make in a dispatch I had already written. That is a
design posture, not an accident, and it is the single change I would argue for.

---

## 6. The record type system

**The types carve the space correctly.** I used four in anger and each did work the others could not:

- `decision` — carried three user rulings plus their `alternatives_rejected`. **The rejected-alternatives field is
  the single best field in the system** and I want to say why precisely: three times this session an agent or I
  reached for an option, and reading `alternatives_rejected` showed it had already been declined *with the
  reason*. A decision record without it is just a changelog entry.
- `anti_pattern` — the `trigger` / `wrong_way` / `right_way` / `source_evidence` split is right. `trigger` is what
  makes H20 delivery useful: it lets me test "am I doing this?" in one read instead of parsing a narrative.
- `feature_article` — `current_ac` earned its keep. Recording AC9 (interpenetration) and AC10 (does it read) as
  explicitly **UNMET** is the only reason this session's incomplete work is honestly represented.
- `todo` (board) — fine, though see §10.

**Would collapsing any two lose something?** Yes, and specifically: `decision` and `anti_pattern` look mergeable
and are not. A decision answers *what did we choose and what did we reject*; an anti-pattern answers *what will
you be about to do wrongly, and how will you recognise it*. The second is written in the second person, keyed on a
trigger, and is useless as history. I wrote both this session about the same incident (the over-broad
substitution) and they say different things to different readers.

**Dead weight:** `derived_unconfirmed`, `wiring_todo_id`, `working_tree`, `known_gaps`, `steps_runbook` — I did not
touch any of them in a session that created and edited a dozen records. `state_reason` is optional and is the
field where a half-built article must disclose its caveat, which is backwards: **the caveat is load-bearing and
nothing enforces it.**

**One real modelling gap:** `state` is a closed enum with no `partial`. I had to record a new article as `built`
with the first line of `state_reason` saying *"IN FLIGHT AND UNVERIFIED … NOTHING HERE HAS BEEN RUN."* That works
only because I chose to write it. A `built` article whose author was less careful reads as done.

---

## 7. Identity, versioning and supersession

**Every `knowledge_update` mints a new id, and this remains the sharpest edge in the system.** In this session
alone the recoil decision passed through **five ids** (`c99ddaa0` → `dd4d31d2` → `372eae4c` → `df0764e6` →
`00d9997e`) as I corrected it forward across four user rulings. Any id I wrote into a brief, a board item or a
comment during that hour was dead within minutes.

**The mitigations are real but they are conventions, not mechanisms.** The project's CLAUDE.md instructs
"resolve by slug, never by id" in four separate places, and `anti_pattern 5bf1cb1d` exists solely to stop readers
misdiagnosing a rotated id as lost work. **When a consuming project needs four prose reminders and a dedicated
anti-pattern to survive an identity model, the identity model is the problem.**

Concretely, three things bit this session:

1. I wrote a forward pointer to a slug I predicted — `…-the-vendo` — and the real derived slug was
   `…-the-vendor`. One character. I only caught it because I re-read the create response. **Slugs are derived by
   truncation and are not predictable from the title**, so a forward reference written before the create is a
   guess.
2. The superseded record's **title** still asserted the dead ruling until I edited it. H19 delivers titles; a
   reader touching those paths would have received the false claim as a headline. I fixed it, but nothing required
   me to.
3. A board id in the rotation note (`776077e9`) resolves to nothing at all (Part A §3.4).

**Can a reader tell a live record from a dead one in the surface they actually use?** Partly. `knowledge_query`
exposes `status` and `supersedes_count`, but **H19/H20 deliveries — the surface I actually read — show title and
id, not status.** A superseded record whose title has not been hand-corrected is indistinguishable from a live one
at the delivery layer. That is the same finding as the 2026-08-14 session and it has not moved.

---

## 8. The tool / API surface

**What took N calls that should take one:**

- **`knowledge_create` for a `feature_article` took two calls and eight validation errors**, because
  `verifiable_at` is a closed enum whose values `knowledge_schema` does not return (Part A §4). The schema tool's
  own description promises `enum_values` for closed enums; it does not descend into array-element object fields.
  **Fix: return nested enums.** This is the exact failure the tool exists to prevent.
- **`knowledge_create` for an `anti_pattern` took two calls** because of the overlap gate. That one I defend — it
  produced a better taxonomy (Part A §1.7) — but the retry cost a full re-transmission of a 6 KB record. **A
  `dedup_override` on the *first* call is impossible because you cannot know you will collide.** An
  `overlap_check_only` dry-run mode would cost one cheap call instead of one expensive rejected write.
- **Resolving a board item by id is not possible.** `board_query` takes `contains` / `file_keys` / `source` but no
  `id`. To check whether `776077e9` existed I ran `knowledge_get` (failed), then two `contains` searches. **A
  `board_get(id)` is obviously wanted and absent.**

**Learned by rejection rather than documentation** — the consuming project's CLAUDE.md now carries a long
paragraph of field-shape gotchas that reads as a bug report against the API:
`current_ac` is objects not strings; `dependencies` is an object not an array and its entries are slugs not paths;
`concept_family` is a string not a boolean; `file_baselines` is server-owned; `research_finding` has no path field
*and the plugin's own template says it does*; `volatility_hint` refuses `"low"`. **That paragraph is plugin
documentation debt showing up as a consuming project's burden**, and it is legitimate evidence: every line of it
was paid for by a rejected write in some session.

**The operation the design obviously wants and does not have:** a **transactional multi-record write**. This
session I corrected one decision forward, created a superseding decision, then had to go back and fix the first
one's title *and* its body pointer — three writes to keep two records consistent, with a window in between where
the store contradicted itself. `knowledge_supersede(old_id, new_fields)` that writes both sides atomically and
patches the old title is a single obvious primitive.

**What is genuinely good here:** `knowledge_edit`'s array-element selector (`files[path=…].role`) and its
match-exactly-once contract. It let a librarian rewrite two role strings inside a 15 KB article without
retransmitting the array — which is the difference between a safe write and the silent-truncation defect
`anti_pattern d25f5a9e` describes. **`knowledge_append` + `knowledge_edit` together are the right answer to large
records and I used both heavily.**

---

## 9. The agent roster

**The tool lists are mostly right, and two constraints demonstrably produced better output than an unconstrained
agent would have.**

- **`test-writer` having no implementation access (H4) is the reason this session caught its worst defect.** The
  tests were written from a contract, disagreed with the implementation, and were *right*. An agent that could
  read the code would have written tests that agreed with it.
- **`test-writer` having no Bash forced an honest refusal** rather than a fabricated gate claim. It said so
  plainly and I ran the gates myself — and found three over-length lines and a format mismatch. Note what this
  means: **agent-authored code needs the conductor's gates run regardless of what the brief demanded**, because
  the agent that cannot run them will hand you a file that has never been checked.

**Two roster problems:**

1. **`test-writer` holds `Write` but not `Edit`.** So "update one helper" is necessarily a whole-file rewrite that
   re-types every frozen case by hand. `anti_pattern 6faa528e` documents this and the mitigation (stage the file
   first so the rewrite is diffable) — which worked perfectly for me. But **the mitigation is a git trick
   compensating for a missing tool.** Giving `test-writer` `Edit` on its own reserved path removes an entire
   failure class.
2. **`explorer` has no `maintenance_query`.** A read-only agent that cannot read one of the three main read
   surfaces is a surprising hole; I hit it and lost a round.

**Did I dispatch work an agent structurally could not do?** Twice, both my fault (Part A §2.4) — but the plugin
has the information to catch it. A dispatch-time check of "does this brief name commands/tools this agent type
lacks" is mechanical.

---

## 10. The board and the maintenance queue

**Signal-to-noise on the queue is poor in a specific, diagnosable way.**

Measured this session: queue at **94** items at session start, **82** after a drain closed 13, **83**, **85**, and
**100** by the end. **It grew while being drained**, and a librarian confirmed why — its own writes triggered an
H7 re-sweep that re-bumped untouched items and raised a new one.

**Of 13 items closed in the one real drain, all 13 were ALREADY PAID** — closed with `maintenance_remove` and no
write, per the project's rule. That is a 100% already-paid rate in the sampled set. The drain also identified
~24 real reconciles and ~19 judgement-lane items it correctly refused to touch.

**The queue misled in BOTH directions, which is the important finding:**

- It claimed work was outstanding that was already done (13 items).
- **And it was silent on three articles that were genuinely stale** (Part A §3.3) — a full uncapped query showed
  no item naming any of them.

**So the queue cannot be used as an inventory in either direction.** It is a log of what a hook noticed. That is
defensible, but the surface reads as a work list, and the plugin's own drain skill treats it as one.

**The board is worse.** `board_query source:"user"` returned `matched_filter: 249` against `cap: 60`,
`capped: true`. **249 open items is past the point where anyone audits it**, which is the precondition for items
being trusted while wrong — this project has previously measured 5 of 8 sampled items as stale. There is no
mechanism that ages, prunes or even *reports* board size pressure. H1 warns when the *maintenance queue* is deep;
nothing warns that the board has tripled.

---

## 11. The conductor contract — enforced vs prose

**Enforced by a mechanism:** read-before-edit (H3), test-path ownership (H5), test-writer's read wall (H4),
article ownership of touched files (H10), capture-or-declare (H10), the allowlist (H14/H15), record schema
validation, and record overlap (dedup gate).

**Prose only — and these are the load-bearing ones:**

- **"Run the gates yourself before committing."** Nothing checks that a suite actually ran, or that its exit code
  was read unmasked. **I violated this in the most literal way available** — reported a red suite as green because
  I appended `; echo $?` (Part A §3.2).
- **"A subagent result is evidence, not a verdict."** Nothing checks an "all N" claim.
- **"Every file path in a brief must be grepped that turn."** Nothing checks it.
- **"A design question is always an ask."** Nothing checks it — and its inverse (asking a question already ruled)
  is also unchecked until after the fact.
- **"Resolve by slug, never by id."** Nothing checks it.

**The highest-value unenforced rule is the gate one**, and I say that having broken it today. A commit gate that
refuses when the last suite invocation's exit status was masked by a pipe or a trailing command would have caught
a red suite being reported green — the exact failure this project already recorded once and I reproduced within
hours. It is a lint over the command string, not a semantic problem.

---

## 12. What is structurally missing — name the call or the hook

Ordered by value. **Three of the four are cheap.**

1. **A PRE-`AskUserQuestion` subject audit.** H20 already computes exactly the right thing and delivers it
   *after* the answer. Running the same matcher on the question text before the form renders would have stopped me
   spending a user decision on an already-settled ruling. **The machinery exists; only the timing is wrong.** This
   is the highest-value change in this document.
2. **A gate-invocation lint (PreToolUse on Bash).** Refuse or warn when a command matching the project's declared
   `run_commands` is followed by `|`, `;`, `&&` or a trailing `echo` that would mask its exit status. Prevents a
   red suite reported as green. Cheap and purely lexical.
3. **A dispatch-time agent-capability check (PreToolUse on Agent).** Cross-reference the brief text against the
   named `subagent_type`'s tool list: mentions of `gdlint`/`gdformat`/shell commands to an agent with no Bash,
   or `maintenance_query` to an agent without it. Two wasted rounds this session; trivially detectable.
4. **Ignore-file awareness in the frontier signal.** Skip `UNOWNED` warnings for gitignored paths. Two lines,
   complained about across at least three sessions.
5. **`knowledge_supersede(old_id, new_fields)`** — atomic two-sided supersession that also patches the old
   record's title. Structural, not cheap. Removes the window where the store contradicts itself.
6. **`board_get(id)`** and board-size pressure reporting. Cheap.
7. **Nested enum values from `knowledge_schema`.** Cheap, and it is the tool's stated purpose.

**Genuinely structural (not cheap): items 5 and the identity model behind it.** Everything else on this list is a
day's work.

---

## 13. Verdict

**Strongest part: the subject-axis delivery.** It repeatedly told me something true and load-bearing that I could
not have known from the code in front of me, and it did so *before* the damage — a scaled basis that would have
divided a motion by 100, an append that would have made a record uneditable, a supersession that would have
orphaned two live rulings. No test suite, linter or reviewer in this stack could have produced any of those.

**Weakest part: the timing posture.** The plugin's best checks overwhelmingly diagnose rather than prevent. The
post-answer audit is the pure case — the right computation, delivered one step too late, by design and with a
comment admitting it. Second weakest: the identity model, which forces every consuming project to encode "resolve
by slug" as folklore.

**A fair summary of the session:** I made four significant errors (a wrongly-scoped brief that nearly shipped legs
that cannot walk, a masked exit code that reported a red suite as green, two dispatches to agents lacking the
tools). **The plugin caught none of those four**, and caught eight *other* defects that would each have been
expensive. That is not a contradiction — it means the coverage is real but oddly shaped: excellent on "what do you
not know about this territory", absent on "did you just do the mechanical thing wrong".

**Would I rather work with it than without it?** Yes, without hesitation, and the margin is not close. Strip out
Sterling and this session ships a weapon recoil that divides its motion by a hundred, a substitution that removes
every skinned leg from the game, and a knowledge store that quietly contradicts itself in three articles. The
question worth putting to the plugin's authors is not whether the system earns its cost — it does — but whether
the same computations, moved one step earlier in the tool lifecycle, would double the return for very little work.
On the evidence of items 1–4 above, I think they would.
