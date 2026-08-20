# Sterling plugin — whole-system assessment, 2026-08-19

**Companion to** `sterling-plugin-retrospective-2026-08-19.md`, which carries the session evidence. This file is the design review. Claims here are grounded in that evidence but are about **the plugin**, not the session.

**Consuming project:** dome-farmer (Godot + Blender). Sterling is consumed here and never developed here.

**Scope limit, stated up front:** this reviews the parts I exercised — the record types, the knowledge/board/maintenance tool surface, the hook layer, the agent roster, the conductor contract. It does **not** review the gated pipeline and run lifecycle, cleanup, init, the merge gate, the council, or the TUI, because none of them ran. A review that silently covered them would be a review of documentation.

---

## 6. The record type system

**The types carve the space well, and one of them is doing most of the work.**

`decision` is the best type in the system and `alternatives_rejected` is the best field. It is the only field anywhere in the plugin that captures *what was considered and refused*, and that is precisely the information a later reader cannot reconstruct from code, git history, or prose. This session I wrote two decisions and both earned their keep through that field alone:

- The host-void adjudication listed *"rule it an exporter defect by analogy with the mirror bug"* as rejected, with the discriminator (the mirror defect tracked the **socket** across many hosts; this tracks a **single host** across many subjects). Without that, the next reader hits the same tempting wrong analogy.
- The non-observation ruling listed *"drop the illegible cell silently"* as rejected **and named it as the ruling's own hazard**. A decision that documents how it could be abused is worth more than one that only documents what it decided.

**`anti_pattern` is the type that actually changes behaviour**, because it is the one H20 delivers at the moment of dispatch. Its `trigger` field is doing something subtle and right: it is written as *"you are about to…"* rather than *"X is bad"*, which makes it matchable against an intent rather than a topic. `right_way` carrying **runnable commands** — not prose — is what made §1.1 of Part A possible; I did not have to translate advice into an action.

**Would collapsing any two lose something?** Yes, and specifically:
- `decision` vs `anti_pattern` look adjacent and are not. A decision says *"we chose X over Y"*; an anti-pattern says *"you are about to do Z and here is the receipt for why that fails."* Collapsing them would lose `alternatives_rejected` or lose `trigger`, and both are load-bearing.
- `research_finding` vs `decision` **is** the questionable pair. A finding carries two clocks and a volatility hint; a decision carries none. But my finding was falsified in two hours (Part A §3.3) — so the volatility hint is doing real work that decisions cannot express. Keep them apart.

**Dead weight I observed:** `live_test_refs` on `feature_article` — I passed `[]` and never had reason to populate it. `derived_unconfirmed` and `scope` on `research_finding` — never used, never missed. `feature_link` on `board_add` — never used.

**The one field that fought me:** `research_finding` has **no path field at all**, so a finding about `game/spike/sheet_plan_dryrun.gd` is unreachable by any `file_keys` query. I had to embed the path inside `answer` prose. The consuming project's CLAUDE.md carries a warning block about this — *"put the paths inside `answer`, or the finding is unreachable by a path query"* — which is documentation debt exported to the consumer. If a finding is a fact about the codebase, it has a location, and the schema should say so.

---

## 7. Identity, versioning and supersession

**This is the weakest structural area and it produced concrete failures in three separate lanes this session.**

The model: every `knowledge_update` / `knowledge_edit` **mints a new id** and marks the old one superseded. Board items are the opposite — `board_update` edits **in place**, id stable, no version minted. Both models are defensible. **Having both, with no signal in the surface about which you are holding, is not.**

### 7.1 A two-field edit is a three-step dance with a hard failure in the middle

Two independent agents hit the identical wall:

> *"First attempt against `b1e13769…` was rejected: `supersede: record 'b1e13769...' is already superseded` (edit 1 had already minted a new id). Retried against `ef8dc09c…`."*

Editing two fields of one record requires: edit field 1 → **read the returned new id** → edit field 2 against it. Miss that and you get a rejection, not a follow. Both agents recovered, but both burned a round, and both had to *notice* the returned id — the failure mode for a less careful agent is to retry the same id and conclude the record is locked.

**The design obviously wants** either (a) `knowledge_edit` accepting multiple field edits in one call, or (b) supersession chains resolving on read so an edit against a superseded id follows forward and warns.

### 7.2 A durable citation is not possible for knowledge, only for the board

I extended `anti_pattern 21e3270c` this session. It is now `4447cbee`. `133e81d5` is now `55c513ac`. `b1e13769` is now `9f0cb190`.

**Every id I cited in a commit message this morning is dead by this afternoon.** The project's CLAUDE.md has already absorbed this as a rule — *"resolve records by SLUG rather than by an id written down earlier"* — and the store contains an anti-pattern about audits that flag cited ids as dangling and mostly manufacture false alarms.

So: **slugs are the real identity and ids are not**, but ids are what every tool returns, every digest prints, and every agent report quotes. The surface advertises the unstable handle and hides the stable one.

**Concrete consequence this session:** I wrote five commit messages citing anti-pattern ids. Every one is now a dead id that resolves to nothing. A reader following them gets `no record`, which is indistinguishable from *"this record was deleted"* — the exact false alarm the store warns about.

### 7.3 A slug can encode a falsified claim, and renaming it orphans references

My finding's slug is `sheet-plan-dryrun-predicts-contact-sheet-cells-and-errs-only-optimistic-2026-08-19`. The clause `errs-only-optimistic` **is the claim that was falsified**. I corrected the body and left the slug, because slugs are the stable handle and renaming breaks every reference.

So the stable identity now asserts something the record's own first paragraph withdraws. There is no mechanism for this: no `slug_deprecated`, no alias, no way to say *"this handle is historical."* A reader who greps slugs — which is the documented way to resolve records — reads the falsified claim and may never open the body.

### 7.4 Can a reader tell a live record from a dead one in the surface they actually use?

Partially. `knowledge_get` on a superseded id **does** return it with `superseded_by` populated, which is good. But `knowledge_query` results **omit the supersedes chain** (they carry `supersedes_count` only), and agent reports quote whatever id they saw. In practice, the check *"is this id current"* costs a call and nobody makes it unless something already went wrong.

**Verdict on §7:** the versioning model is sound; the *ergonomics* of citing across it are not. This was flagged as the most expensive area on 2026-08-14 and it is still the most expensive area.

---

## 8. The tool / API surface

**What took N calls that should take one:**

1. **Short id → full uuid → act.** Every human-readable surface prints 8-char ids; every write tool refuses them. On a lane touching 13 board items that is 13 extra `contains:` queries. **Fix: accept an unambiguous prefix, or refuse with the candidates listed** — `no record '1c43b64c'` could have been `no record '1c43b64c'; did you mean 1c43b64c-81cf-49db-8ec5-fe365de0903a?` The server plainly has the data to say that.

2. **Full-text-replace on board items.** `board_update` replaces the whole `text` field, so correcting one wrong number in a 6 KB item requires fetching the full text, patching it in the agent's head, and writing it back. `knowledge_edit(id, field, find, replace)` exists for knowledge and **has no board equivalent**. That asymmetry has no obvious justification — board items are the *longer* documents in practice.

3. **No way to read the rotation note.** H15 correctly blocked my `cat .sterling/rotation-note.json`, and the MCP surface has no read for it. It is writable by a sanctioned script and readable only by H1 at session start. If a session wants to check what it wrote — or a conductor mid-session wants to see whether a note is pending — there is no call.

**What had to be learned by rejection rather than documentation:**

The consuming project's CLAUDE.md contains a ~400-word block of field-shape gotchas, all of them earned by rejected writes: `current_ac` is an array of *objects*; `dependencies` is an *object* whose entries are *slugs not paths*; `concept_family` is a *string not a boolean*; `file_baselines` is server-owned; `research_finding` has no path field despite the plugin's own template claiming it does. **That block is the plugin's documentation debt, itemised, in a consumer's config file.**

`knowledge_schema(<type>)` exists and is the right answer — but it is a *second* call that you only think to make after a rejection. The rejections themselves are good (they name the valid set), which is why the debt is survivable rather than fatal.

**The operation the design obviously wants and does not have:** a **dry-run / preflight for a write**. `knowledge_preflight` exists in the tool list; I did not exercise it and cannot say whether it fills this. But the shape needed is: *given this record and this field edit, tell me the match count and whether the id is current, without writing.* Two of the session's rejections (superseded id; `find` matching zero or many) would have been answered by it.

---

## 9. The agent roster

**The tool lists are mostly right, and the mismatches were mine to avoid.**

**Where the roster shaped the outcome for the better:**

- I dispatched a **librarian** at a task requiring a 68,135-char article edit. It **refused correctly**, stating precisely what it needed: *"the exact, complete `role` text for `files[path=".sterling/config.json"]` and `files[path="CLAUDE.md"]`… so the array can be safely reconstructed."* A less constrained agent would have rebuilt the array from grep windows and silently truncated two long fields — which is exactly the anti-pattern the store carries about retransmitting arrays from token-capped reads. **The constraint produced a better result than an unconstrained agent would have.**
- I re-dispatched that work to **general-purpose** (which has Bash), briefed with the parse-and-assert method. It caught its **own** corruption twice — its first two write-backs mangled escape sequences in a 4,468-char field — and only reported success on the third attempt with all 12 kept entries proven byte-identical. That is the assertion discipline working.
- **explorer** has no Bash, and the board-audit lane said so plainly: *"I have no Bash tool… Every claim of the form 'commit X is/is not an ancestor of HEAD' below is NOT verified; where an item names a commit I verified the code state instead and say so."* An honest, scoped report beats a confident wrong one. I ran the four decisive `git merge-base` checks myself.

**Where the roster fought the task:**

- **`librarian` has no `board_add` / `board_update` / `board_remove`.** It can read and write knowledge and drain the maintenance queue, but cannot touch the board. Since the board is where *project* work lives and the queue is where *store hygiene* lives, and a drain routinely produces board-worthy findings, this split forces either a second dispatch or conductor hand-work. I did the board writes myself all session — 13 items — precisely because the agent that had the context could not.
- **No agent type is "has Bash and has the knowledge write tools" except `general-purpose`.** `coder` and `debugger` have Bash but only `knowledge_query`/`knowledge_get`. So any task combining *"parse a large record with a script"* and *"write it back"* lands on `general-purpose` by elimination, not by fit.

**One roster fact worth stating positively:** `debugger` holding Bash and being the right agent for render lanes worked cleanly six times. The render brief pattern is now stable and the agents executed it without deviation, including the strict serialisation of windowed Godot runs.

---

## 10. The board and the maintenance queue

**Signal-to-noise on the queue: roughly 1 in 8.**

Measured: 61 items → 26 after drain. Of the original 61:
- **31 were exact duplicates** (55% of the 56 measured) — the same `(article, path)` pair re-raised up to six times across four days.
- **3 owed a real reconcile.** That is the true signal: **~5%.**
- 23 were correctly-parked informational items that will discharge at a merge gate.
- 1 was a deferred oversize item under a standing user ruling.
- 2 were `promotion_review`, out of scope.

**The duplication is a missing idempotency check, and the evidence is exact.** Three sibling files fired *at the same six timestamps to the second*, meaning one hook invocation re-raises a whole article's file set. `file_parked` is uniquely vulnerable because it is the one lane with **no drain path** — its items are informational and close only at merge, so nothing in normal workflow ever consumes them, and each session's H7 activity re-fires the same fact.

**A queue whose largest lane cannot be drained will grow monotonically until someone does what I did today.** That is a design consequence, not an accident.

**Direction of the queue's error — this matters and is easy to get backwards.** The queue did not claim defects were live. It claimed **work was outstanding that was not**, and — subtler — it claimed **the wrong thing would discharge it.** 47 items said *"this closes when branch X lands"* where X was a red herring that had merely forked before our own deletion. An agent that read the item's conclusion rather than its evidence left all 57 open; that is the failure mode the item text invites.

**The board.** 246 open user items, `capped: true` at 60. An audit of 31 high-priority items found **19 wrong or stale (61%)**. The board has no mechanism that ties an item's stated evidence to the artefact it describes, so a count written into an item drifts silently while the item keeps its confident tone. **Specificity is what makes a stale board item dangerous:** *"Ledger 253 Y / 139 N, re-measured 2026-08-19"* reads as a measurement and was off by 40.

---

## 11. The conductor contract — enforced vs prose

| Rule | Enforced by | Reality |
|---|---|---|
| Read before edit | **H3 hash check** | Fired correctly; caught a real stale-read |
| Store writes via MCP only | **H15** | Fired correctly |
| Subagent command allowlist | **H14** | Enforced, opaquely |
| Reconcile after edit | **H7** raises the item | Raising is enforced; *closing correctly* is not |
| Capture when decided | **H10** demands *something* | See below |
| Green suite before commit | **Prose only** | I ran it; nothing checked |
| Conductor opens every plate | **Prose only** | Nothing can check this — and H21 actively argues against it |
| Every path in a brief grepped that turn | **Prose only** | Nothing checks |
| Never repeat an "all N" claim unverified | **Prose only** | Nothing checks |
| Windowed Godot runs serialised | **Prose only** | Agents complied because the brief said so |

**The highest-value unenforced rule is: *the conductor opens every plate and every render with its own eyes*.**

It is unenforceable in principle — no hook can verify a human-equivalent judgement occurred — and it is the rule the whole visual-inspection campaign rests on. The consuming project has built the only available substitute: a **tracked ledger** (`docs/mech-asset-inspection-log.md`) where a row is marked ruled only after the conductor opened that image in that session. The project's own note on it is the sharpest sentence in its CLAUDE.md: *"A row ruled on any other basis — an agent's report, a probe count, a colour statistic — is invisible drift, because the ledger looks identical either way."*

**That is a consuming project inventing a durable-state mechanism because the plugin has none for it.** See §13.1.

**On H10's capture demand specifically:** it fires when files were touched and no record was written. That is the right *trigger* and the wrong *question*. It asks "did you capture?" — it cannot ask "did you capture the thing that was learned?" Twice this session I had something genuinely durable and wrote it. A tired session writes a thin record to clear the demand, and nothing distinguishes the two.

---

## 12. What is structurally missing (the design reaches for it and stops short)

1. **`knowledge_edit` with multiple field edits in one call**, or supersession-following on write. The three-step dance in §7.1 hit two agents in one session.
2. **`board_edit(id, find, replace)`** — the board has no partial-edit operation while knowledge does, and board items are longer.
3. **Prefix-tolerant id resolution, or rejections that name the candidate.** The server has the data; the error message does not use it.
4. **A path field on `research_finding`.** A fact about the codebase has a location; the schema denies it one.
5. **A read for the rotation note** on the MCP surface, since H15 correctly denies the shell route.
6. **Ignore-file and decision awareness in H19's frontier check.** A gitignored path should not be "unowned territory", and a `decision` that explicitly scopes a directory out should suppress the demand for that directory.

---

## 13. What Sterling does not do at all — and should

*Ranked by damage caused this session, most damaging first. Every entry maps to something that actually went wrong or nearly did.*

### 13.1 There is no way to record that a HUMAN JUDGEMENT was made about a specific artefact

**The gap.** Sterling has no record type or call that says *"a person looked at this thing, on this date, at this commit, and ruled it."* Every record type describes code, decisions, or facts — none describes an act of inspection.

**The incident.** This project's entire mech-asset campaign is 392 rows requiring an eye. It survives only because the project hand-built a **tracked markdown ledger** and a convention that a row is marked ruled only after the conductor opened that image in that session. Its own warning: *"A row ruled on any other basis is invisible drift, because the ledger looks identical either way."* This session I opened 54 images and moved 8 rows; a further 43 rows had to be **re-opened and re-confirmed** because a commit (`239e313`) changed the render lighting and silently invalidated the evidence under every prior verdict.

**The shape of the fix.** An `inspection` record, or a field family on any record: `inspected_artefact` (a path or key), `inspected_at_commit`, `inspected_by` (`conductor` | `agent` | `user`), `basis` (what was looked at), `verdict`. Then one query — *"which inspections were made against a commit older than the last change to the thing that produces the artefact?"* — replaces the entire hand-built superseding machinery.

**The cost of not having it.** Two full commits this session (`02f0d68`, `537e977`) did nothing but re-establish 43 already-`Y` rows on current pictures. The invalidation was discovered by a human noticing a commit message, not by any mechanism. A ledger banner had to be hand-written asking a future session to re-rule 22 rows, and that banner is prose that nothing enforces.

### 13.2 There is no contradiction check between a new measurement and an existing record

**The gap.** Nothing compares what you are writing now against what the store already asserts. Records can contradict each other indefinitely and only a human reading both notices.

**The incident.** I wrote a `research_finding` at 05:24 claiming the cell predictor *"is exact or OVER-OPTIMISTIC, never pessimistic."* At roughly 07:00 a render lane measured `sweep15` at **14 planned against 12 predicted** — an under-count, the direction I had declared impossible. **The errors cancelled in net yield** (12−2 = 10; 14−4 = 10), so anyone checking only the rendered-cell count logs a clean hit. It was caught solely because I had briefed the lane to check both columns independently and flag a surplus loudly. That is luck dressed as diligence.

Separately: board `3074cd0d` said `253 Y / 139 N` while the artefact it summarised said `293 / 99`, and board `5728b586` said `130 / 262` about the **same** artefact. Three numbers, one file, no mechanism noticed.

**The shape of the fix.** Two things, in increasing ambition:
- **Numeric assertion binding.** Let a record declare `asserts: [{value: 293, source: "docs/mech-asset-inspection-log.md", derivation: "grep -cE '<pattern>'"}]`. A hook re-runs the derivation on session start or on touch of the source, and raises a `contradiction` maintenance item when it drifts. This is mechanically cheap and would have caught all three count errors.
- **Same-subject conflict detection on write.** On `knowledge_create`, surface existing records with high `stack_tags`/`file_keys`/slug overlap and their headline claims. Not a block — a delivery, the way H20 works.

**The cost of not having it.** A wrong finding sat in the store for ~2 hours and would have shipped indefinitely. Two board trackers misdirected work for at least a day — and the tracker that was 40 rows wrong carried the words *"re-measured 2026-08-19"* beside the wrong number, which is the specific thing that makes a stale record dangerous rather than merely useless.

### 13.3 There is no idempotency on maintenance-item creation

**The gap.** `maintenance_enqueue` and the hooks that call it have no "does an identical open item already exist" check.

**The incident.** 57 `file_parked` items covering ~25 distinct `(article, path)` pairs; 31 exact duplicates. One pair had six items, timestamped 08-16 12:03, 08-16 22:46, 08-17 15:55, 08-17 18:59, 08-17 21:30, 08-18 06:13. Two sibling files fired at **the same six timestamps to the second**, so a single hook invocation re-raises an entire article's file set.

**The shape of the fix.** A dedup key on enqueue — `(system_reason, article_slug, path)` — that refuses or refreshes rather than inserting. And for `file_parked` specifically, which has no drain path at all, either give it one or stop enqueueing it repeatedly: its items are *informational* and a single item per pair conveys everything.

**The cost of not having it.** One full agent dispatch to measure the duplication, a second to remove it, and a first lane that read five items, believed their self-description, and left all 57 open. Three lanes for what should be zero.

### 13.4 There is no applicability signal on delivered knowledge

**The gap.** H19 and H20 deliver records matched on paths and subject keywords. Neither can say *"and here is why this might not apply to you."* Every delivery arrives with identical authority.

**The incident.** H20 delivered `6d399cd3` — *"a subagent's Bash cwd is not the repo root, so `--path game` cannot resolve"* — on my render dispatch. It is a real, well-evidenced record. **It did not apply**: this project's subagent shells *do* start at the repo root. I believed it, sent a mid-flight correction telling the agent to use an absolute path, and the agent replied that the correction was refused by H14 and that all 16 of its Godot calls had already worked. **A round lost to a correct record applied to the wrong case.**

Contrast §1.1–1.3 of Part A, where the same channel saved me three times. The channel is excellent; the *reader* has to supply applicability judgement every time, and I supplied it wrong once in twelve.

**The shape of the fix.** Delivery-time falsifiers. Let an `anti_pattern` carry `applies_when: [{check: "<shell command>", expect: "<pattern>"}]`. For `6d399cd3` that is literally `pwd` — one command, and the delivery could have arrived annotated *"this record's precondition does not hold here."* Where a check cannot be automated, a `does_not_apply_when` prose field delivered alongside `trigger` would still have helped: the record's own author knew the failure was cwd-dependent.

**The cost of not having it.** One agent round, one wrong `SendMessage`, and — worse — a small erosion of the reflex to trust H20, which is the mechanism carrying the highest value in the whole plugin.

### 13.5 There is no notion of "this instrument's output is stale" for generated artefacts

**The gap.** Sterling tracks whether an *article* is stale against *code* (H7, file hashes). It has nothing for: an artefact was generated by tool T at commit C, T has since changed, therefore every judgement resting on that artefact is now unfounded.

**The incident.** Commit `239e313` changed the contact-sheet stage lighting. That invalidated the shading of **154 logged cells across 14 batches**. Nothing detected it. A human wrote a prose banner into a markdown file asking a future session to re-rule 22 rows, and a separate hand-maintained list tracked which batches were current. This session I re-rendered and re-confirmed 43 rows and the backlog is still not clear.

**The shape of the fix.** `generated_by: {tool_path, tool_commit}` on any record or ledger row citing a generated artefact, and a maintenance lane that raises `evidence_superseded` when `tool_path` changes after `tool_commit`. This is the same mechanism as H7's file-hash baseline, pointed at the *producer* rather than the *description*.

**The cost of not having it.** Two commits of pure re-verification, and a hand-written banner that a future session must remember to honour — with no mechanism if it does not.

⚠ **Flagged as partially speculative:** I observed this once, on one instrument, in one project. That a render pipeline invalidates downstream visual judgements is near-certain to generalise; that the *specific* `generated_by` shape is the right fix is my guess, not a measurement.

### 13.6 There is no "this rule was cited — does it exist?" check on agent reports

**The gap.** When a subagent justifies an action by citing a record id, nothing verifies it. The conductor must think to run `knowledge_get`.

**The incident.** A drain lane wrote *"This auto-drained the queue item (decision `8ecd435f`)."* That id resolves to nothing, at any status, with no matching slug. **This is the second occurrence of the same fabricated id in two days** — anti_pattern `133e81d5` records the first, from a different lane on 2026-08-18. The recurrence of the *same* id suggests reconstruction from context rather than fresh invention, which makes it more plausible-looking each time.

**The shape of the fix.** A PostToolUse hook on `Agent` completion that extracts anything matching the project's id shape from the report text and resolves each, prefixing the report with `⚠ CITED ID DOES NOT RESOLVE: 8ecd435f`. Cheap, mechanical, and it turns a judgement call into a banner.

**The cost of not having it.** Low this session — I checked, because the store already contained the anti-pattern telling me to. But that anti-pattern exists *because it cost something the first time*, and it recurred anyway within 24 hours. A rule that has to be remembered has already failed once.

---

## 14. What would have helped, ranked

Folding §12 and §13 into one ordered list. **There are four genuinely structural items (1, 2, 3, 5); the rest are mechanical.**

| # | Change | Kind | Prevents |
|---|---|---|---|
| 1 | **Inspection records** — a first-class way to say a human judged an artefact at a commit (§13.1) | Structural | The entire hand-built ledger; 43 rows of re-verification |
| 2 | **Contradiction / assertion binding** — bind a number to its derivation and re-check it (§13.2) | Structural | Three wrong counts, one falsified finding |
| 3 | **Instrument-staleness tracking** — `generated_by` + `evidence_superseded` (§13.5) | Structural | 154 cells silently invalidated |
| 4 | **Idempotency key on maintenance enqueue** (§13.3) | Mechanical | 31 duplicate items, 3 dispatches |
| 5 | **Applicability falsifiers on delivered records** (§13.4) | Structural | One wrong correction, one agent round |
| 6 | **H19 frontier check honours `.gitignore` and scoping decisions** (§12.6) | Mechanical | ~20 false positives per session in this project |
| 7 | **Multi-field `knowledge_edit`, or supersession-following** (§7.1, §12.1) | Mechanical | Two agent rounds |
| 8 | **Prefix-tolerant ids, or rejections naming the candidate** (§8) | Mechanical | ~13 extra queries |
| 9 | **`board_edit(id, find, replace)`** (§12.2) | Mechanical | Full-text rewrites of 6 KB items |
| 10 | **Cited-id resolution check on agent reports** (§13.6) | Mechanical | A fabricated citation, twice in two days |
| 11 | **Path field on `research_finding`** (§12.4) | Mechanical | Findings unreachable by path query |
| 12 | **H21 excluding image reads from the hand-work count** (Part A §2.2) | Mechanical | Two misfires in a visual session |

---

## 15. Verdict

**The strongest part of Sterling is H20 — subject-axis delivery at the moment of dispatch — and it is not close.** It cost roughly 3 KB per firing, fired twelve times, and three of those firings caught errors that nothing else in the stack could have caught: a wrong verdict I had already dispatched, a one-sided test I had briefed, and a defect inside a fix I had just committed. The mechanism works because it matches on *what you are about to do* rather than *what file you touched*, and because `anti_pattern.right_way` carries runnable commands instead of advice. One of the twelve misled me, and that was my judgement failing, not the delivery.

**The weakest part is identity and versioning.** Every knowledge write mints a new id while board writes do not; slugs are the real handle but ids are what every surface prints; a two-field edit is a three-step dance that hard-fails in the middle and did so to two agents in one session; and a slug can permanently encode a claim the record has since withdrawn. This was named as the most expensive area in the 2026-08-14 assessment and it is still the most expensive area. Everything else in this document is a smaller problem than that one.

**The thing I would build first is none of those.** It is §13.1 — a way to record that a human looked at something. This project runs a 392-row visual-inspection campaign entirely on a hand-built markdown ledger and a prose convention, because the plugin's model has no room for the act of inspecting. That gap forced a whole parallel bookkeeping system into existence, and it is the reason two of this session's five commits contain no new work at all.

**Would I rather work with it than without it?** Yes, clearly, and the case is a single sentence: this session it caught three of my four significant errors, and the one it missed — a finding of mine that a later measurement falsified — is precisely the class §13.2 describes and Sterling does not yet cover. A system that catches most of my mistakes and whose gaps I can name specifically is a system worth keeping. I would not want to run this campaign without it.
