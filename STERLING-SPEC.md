# STERLING — Build Specification

> **Audience:** Claude Code, building this plugin from scratch in one dependency-ordered pass.
> **Status:** v1 draft for human review. Every section is binding unless marked *(deferred)* or *(verify-at-build)*.

## 0. How to consume this document

1. **Build in the order of Section 16.** Each layer is built and verified before the next begins. Do not build ahead of an unverified layer.
2. **Implement exactly.** Schemas, hook semantics, signal tables, and contracts in this spec are authoritative. If something appears missing, contradictory, or impossible, **flag and ask — never silently improvise.** A deviation that isn't flagged is a defect.
3. **Verify platform mechanics at build time.** Items tagged *(verify-at-build)* depend on Claude Code platform behavior that moves between versions. Verify each against the current official docs before implementing:
   - Claude Code docs map: `https://docs.anthropic.com/en/docs/claude-code/claude_code_docs_map.md`
   - Claude API docs map: `https://docs.claude.com/en/docs_site_map.md`
   This spec is authoritative on **intent and mechanism choice**; the current platform docs are authoritative on **exact syntax and event semantics**.
4. **Naming is canonical.** The product is **Sterling** (Quater + main — Allan Sterling). Never "Quartermain"/"Quartermaine". The implementation stage is **phase execution** (never "wave"). The intake stage is **intake** (never "brainstormer"). The planner's internal sequence uses **steps** (never "phases" — that word is reserved for phase execution). Kill any synonym on sight.

---

## 1. Charter and principles

Sterling is a Claude Code plugin providing a ready-to-go, knowledge-compounding development pipeline suite from the moment a project is initialized. It is the successor to Forge, redesigned around Forge's documented failures.

**Founding distinction from Forge:** Forge isolated execution (headless worktree sessions) and collected results; Sterling keeps changes **filesystem-isolated** (run branch, for safe rejection) but runs them under **live observation** — signals, escalations, and knowledge flow continuously; the human and the knowledge layer are participants in the run, not recipients of its output.

### 1.1 Core principles (govern every design decision)

- **P1 — Attention-first.** Human attention is the scarcest resource. Every gate, pause, or escalation must change an outcome; if pausing does not alter a decision or prevent a mistake, it is ceremony and must be removed. Gates exist only where the cost of being wrong jumps.
- **P2 — The knowledge base is the product.** The pipeline is the highest-quality way to write to it. Every run both consumes accumulated knowledge and produces it. The test for any feature: does it improve what we capture or how well we retrieve it?
- **P3 — Scripts over agents.** Every stage is deterministic code unless it provably needs judgment. Deterministic mechanisms cannot drift, cannot forget, cost nothing, and are testable.
- **P4 — Lifecycle-bound state.** Every piece of transient state is removed by the mechanical event that ends its life; durable value is promoted before transient state is disposed. Nothing is "cleaned up" by a fallible remembered step. No shared mutable files for queue/transient state, ever.
- **P5 — Fail loud, never silent.** Unknown signals halt. Missing spawn inputs block. Half-wired extensions fail consistency checks. Maintenance binds to events, not to anyone remembering.
- **P6 — Maximal *relevant* context.** Every agent operates with all knowledge that bears on its task — retrieved filter-first and capped. Starving an agent and flooding it are both failures; the retrieval discipline (filter → join → rank → cap) delivers the first without the second.
- **P7 — Prevention over recovery.** Over-scoping symptoms (context overflow, repeated research escalations) route back to planning as decomposition failures. No checkpoint/resume machinery — re-scope and redo.
- **P8 — Match mechanism to work.** Judgment work gets strong models; mechanical work gets cheap models or scripts; routing is a state machine; conversation belongs to the conductor. Pipeline only the work that is plannable and benefits from staged gating; interactive work stays conductor-direct.

### 1.2 Conduct rules (inherited from Forge's battle-tested CLAUDE.md, adapted)

These go verbatim-in-spirit into the project CLAUDE.md that `/sterling:init` writes (Section 12) and the conductor contract (Section 7.5):

- **Change philosophy:** smallest safe implementation; no speculative abstractions; no unrelated cleanup; prefer existing patterns; read before edit; grep callers before modifying a function.
- **Anti-speculation:** before claiming anything about the codebase's state or history, cite evidence from a tool call made this turn, or say "I don't know, checking" and check. No "appears to / likely / probably / seems".
- **No false action claims** (the action-twin of anti-speculation): never imply an action was taken — saved, remembered, persisted, changed, recorded — unless it was actually performed this turn with tool-call evidence. Acknowledging understanding is fine; implying unperformed persistence is not. If you cannot act now, say so and offer a concrete persistence path.
- **Source attribution:** in any artifact capturing user intent, user-stated content and conductor proposals are structurally distinct (see brief schema, Section 4). Never fold a conductor recommendation into an artifact as if the user stated it. An unanswered recommendation is not an accepted one.
- **Verbatim intent capture:** intent-capture surfaces (grill skills, debug Step 0) receive only the user's verbatim words — no paraphrase, no pre-stuffing, no thoroughness directives ("this can be light"). The post-plan grill runs in full regardless of how familiar the plan seems.
- **One question at a time:** when the user must decide something, ask the single most important question (with options and a recommendation), wait, then the next. Never batch Q1/Q2/Q3.

---

## 2. Stack and packaging

### 2.1 Stack

| Surface | Technology | Rationale |
|---|---|---|
| MCP knowledge-store server | **TypeScript** (Node.js, official MCP SDK) | Build step is natural; type system enforces the schemas and the signal union at compile time |
| TUI | **TypeScript** + **Ink** (React for terminal) | Evaluate `ink-terminal` (Claude Code's extracted renderer: mouse events, virtual scrolling) vs base Ink + addon as first TUI build decision *(verify-at-build)* |
| Hooks, checks, scripts | **Plain `.mjs`** (Node.js, ESM, no build step) | Edit-and-run ergonomics; minimal startup latency (the watcher fires on every tool call) |
| Agents, commands, skills | **Markdown** | Claude Code native formats |
| Runtime validation | **zod** (or equivalent) in the MCP server | The store rejects malformed writes from any caller regardless of caller language |

### 2.2 Plugin packaging (the deliverable)

A proper Claude Code plugin. Installing it touches **no project files**; project state is created only by `/sterling:init`.

```
sterling/
  .claude-plugin/plugin.json      # plugin manifest
  agent-templates/*.md             # agent TEMPLATES (Section 7) — NOT served from the plugin: plugin-shipped
                                   # agents ignore hooks/mcpServers/permissionMode frontmatter (verified platform
                                   # limitation), which would kill per-agent enforcement on arrival. /sterling:init
                                   # installs concrete agents into the project's .claude/agents/ with a generated
                                   # header (plugin version + template hash). The plugin is the distributor;
                                   # THE PROJECT IS THE ENFORCEMENT SURFACE.
  commands/*.md                    # slash commands (Section 13) — FLAT: plugin namespacing already prefixes
                                   # /sterling:*; a sterling/ subdir would double it (/sterling:sterling:*)
  skills/*/SKILL.md                # workflow SOP skills (Section 7.6) — ship WITH the plugin
  hooks/hooks.json                 # project-level hook declarations (Section 6)
  hooks/*.mjs                      # hook scripts
  scripts/*.mjs                    # checks, dispatch selection, branch manager, watchers
  mcp/                             # TypeScript MCP server (store + brain)
  tui/                             # TypeScript Ink TUI
  scaffolds/                       # files /sterling:init writes into a project
```

**Workflow SOP skills ship with the plugin** (grill-intent, grill-plan, planning, debug, cleanup). Their *descriptions* load every session start (the conductor always knows they exist); full SOP bodies load on invocation — Claude Code's native progressive disclosure. **Domain skills ship at zero** and are lazy-seeded per the domain-capability policy (Section 3.3).

### 2.3 Store locations

- **Project store:** `<project>/.sterling/` — gitignored by default; human-readable projections (e.g. `board.md`, generated architecture view) may be committed. Created by init.
- **Shared domain stores:** `~/.sterling/domains/<domain>/` by default; **path configurable** per domain. Created lazily on first need. **The live database must never sit inside a synced folder** (OneDrive/Dropbox fighting over the `-wal` file is a known corruption recipe) — sync the snapshots, never the store.

**Backup (P2 made survivable, P4 event-bound — never remembered):** the knowledge base is the product, and the product must not live in exactly one gitignored file. Every store (project + each domain) snapshots via SQLite `VACUUM INTO` to a configured backup path (this is where a synced folder is *correct*). Triggers: `dispose-run` success snapshots the stores the run touched; SessionStart checks snapshot age and warns loudly past a threshold (config); `/sterling:backup` for manual. **Init refuses to complete without a backup path configured or an explicit recorded opt-out.** Restore is documented, manual: stop session, copy snapshot over store.
- **Run-scoped transient state:** `<project>/.sterling/runs/<run-id>/` — disposed as a whole after durable outputs are promoted (P4).

---

## 3. Knowledge layer (the substrate — build first)

### 3.1 Storage substrate *(Claude Code selects, against these criteria)*

The backing store must satisfy, efficiently, at single-user scale (thousands of records, not millions):

1. **Filter-first retrieval:** filter by stack tags and record type, then file-key join, then relevance rank, then cap (P6).
2. **File-key joins:** "all records owning/touching file X" is a primary query (blast radius, bundling, reconciliation).
3. **Supersession/version chains:** every record type supports `status: active | superseded` with a nullable `superseded_by` id; feature-article bodies are fully versioned (current + retained prior versions).
4. **Inter-record links:** typed references (`cites`, `informed_by`, `fulfills`, `supersedes`) traversable in both directions.
5. **Freshness-at-read:** research findings compute staleness from two clocks + volatility tag at retrieval time.
6. **Concurrent access:** the TUI reads (and may write todos/notes to) the same store directly while the MCP server is live. If SQLite: **WAL mode mandatory.**

**SQLite is the expected choice.** If you select otherwise, justify against every criterion above and flag for review. Whatever the choice, the MCP server is the sole write path for everything except the TUI's todo/note writes, and zod validation guards every write — **including the TUI's**: the schemas are a shared workspace package imported by both writers, never defined twice.

### 3.2 Record schemas (FULL PRECISION — implement exactly)

Common envelope on every record: `id` (uuid), `type`, `created_at`, `updated_at`, `author` (`user | conductor | agent:<role> | system`), `status` (enum `active | superseded`) + `superseded_by` (id, nullable — set iff status is `superseded`; an enum conflated with a foreign key queries badly, so they are separate columns), `links[]` (`{rel: cites|informed_by|fulfills|supersedes, target_id}`), `scope` (`project | domain:<name>`), `stack_tags[]`, `derived_unconfirmed` (optional bool — placed on the envelope because 3.2.6's retrieval semantics apply across record types).

**Path invariant (global):** every path anywhere in the system — `file_keys`, blast radius, hook input, glob match, helper scripts — is stored and compared as a **repo-relative POSIX path** (forward slashes, no drive prefix), normalized in the shared zod schema package at every boundary so no caller can write a backslash path. Windows tool surfaces emit mixed separators; without one normalization point, file-key joins silently return nothing — the exact silent decay P5 forbids.

**3.2.1 `decision`**
| field | type | req | notes |
|---|---|---|---|
| title | string | ✔ | |
| statement | string | ✔ | what was chosen |
| alternatives_rejected | `{option, reason}[]` | ✔ | the valuable half — prevents re-litigation |
| rationale | string | ✔ | |
| file_keys | string[] | – | paths this decision governs |
Decisions are immutable; revisiting one creates a new decision that `supersedes` the old.

**3.2.2 `anti_pattern`**
| field | type | req | notes |
|---|---|---|---|
| title | string | ✔ | |
| trigger | string | ✔ | "when X" condition — **top-level, not buried in prose** |
| guidance | string | ✔ | "do Y, not Z" |
| wrong_way / right_way | string | ✔ | |
| source_evidence | string | ✔ | provenance ("run r-XXXX", "file:line") — **top-level** |
| file_keys | string[] | – | |
| severity | enum `info|warn|block` | – | |
| basis | enum `codebase|platform|external` | – | default `codebase`; platform/external records rot when the outside world moves — see stale-at-read (3.4) |
Writes pass the **noise gate** (Haiku classifier: generalizable vs one-off; one-offs are rejected) and **dedup-merge**: keyword/tag overlap against existing records merges evidence into the existing record instead of duplicating.

**3.2.3 `feature_article`** (versioned body + append-only history)
Body (replaced wholesale on reconciliation; prior version retained via supersession):
| field | type | req | notes |
|---|---|---|---|
| slug, title | string | ✔ | |
| what_it_does | string | ✔ | current behavior, plain language |
| intended_behavior | string | ✔ | the "how it was meant to work" oracle for breakage |
| files | `{path, role}[]` | ✔ | **the blast-radius key** — role is what the file does *for this feature now* |
| current_ac | `{ac_id, text, verifiable_at: phase:<n>|final}[]` | ✔ | canonical syntax matches the brief (§4) — article ACs originate there |
| dependencies | `{relies_on[], relied_by[]}` | ✔ | |
| steps_runbook | string | – | click-path/runbook (non-code features) |
| state | enum `planned|built|wired_in|active|dormant|deprecated` | ✔ | `dormant` requires `state_reason` + `wiring_todo_id` |
| known_gaps | `{site, kind: mutation_survivor|other, evidence, recorded_run}[]` | – | **compounding wire**: mutation survivors persist here at capture; the file-key join stages them automatically into the next run touching these files — this run's blind spot is the next run's warning, with nobody remembering anything |
| version | int | ✔ | |
Article-level (append-only): `history[]` — entries `{date, event, target_id?}`: dated links to originating brief, change briefs, plans, red/green verification events; `live_test_refs[]` — `{ac_id, test_paths[]}` (current, updated on change).
**Invariant:** a run cannot complete with a feature in `built` that is unreachable and undeclared — see wiring checks (Sections 6, 8.1). Accidental un-wired is unrepresentable; deliberate dormancy is declared + tracked.

**3.2.4 `research_finding`** (the decaying type)
| field | type | req | notes |
|---|---|---|---|
| question | string | ✔ | the retrieval key |
| answer | string | ✔ | |
| source_urls | string[] | ✔ | |
| source_date | date | ✔ | age of the information itself (clock 1) |
| capture_date | date | ✔ | when we looked (clock 2) |
| volatility_hint | enum `fast|medium|stable` | – | informs staleness-relative-to-topic |
Status adds `flagged_stale`. **Freshness is computed at read** (lazy): retrieval returns both ages + a staleness flag; past threshold the finding is served only as "stale — re-verify", and re-verification supersedes. A finding born from an old source on a fast topic is born-stale and flagged at first read.

**3.2.5 `reference_material`** — `title, kind (pdf|url|doc), location, summary, source_date, capture_date, basis (codebase|platform|external, default codebase)`. Large, stable, loaded on demand; never bulk-injected.

**3.2.6 `note`** — `raw_text` (immutable), `captured_at`, `capture_source (tui|command|conductor)`, `derived[]` (links to extractions). On capture, a Haiku structuring pass extracts candidate decisions/anti-patterns/article-annotations as records flagged `derived_unconfirmed` (marked lower-trust), each citing the note. Raw text is never modified; extraction is re-runnable. **Retrieval default: `derived_unconfirmed` records are EXCLUDED from `knowledge_query` unless the caller passes `include_unconfirmed: true`** — pipeline agents never receive unconfirmed material silently (an unconfirmed wrong "decision" in staged context steers work and competes for cap slots; the damage is silent — P5). The conductor opts in at intake/planning; **any unconfirmed record actually relied on for a brief or design is confirmed-or-killed on the spot** (confirming strips the flag, making it default-visible thereafter; use is the confirmation event — the unconfirmed pool drains exactly when the knowledge matters, with a human present).

**3.2.7 `todo`** (the board — and the maintenance queue)
| field | type | req | notes |
|---|---|---|---|
| text | string | ✔ | |
| source | enum `user|system` | ✔ | the board view filters `user`; the maintenance queue is the same records filtered `system` |
| file_keys | string[] | – | enables bundling + blast-radius surfacing |
| feature_link | id | – | |
| priority | enum `low\|normal\|high` | – | three members on purpose — an `urgent` tier invites everything becoming urgent |
| system_reason | enum `reconcile_needed|stale_research|deletion_candidate|capture_owed|promotion_review|wire_in_dormant` | req if source=system | |
**There is no `done` status.** Done = the record is **removed**, atomically, by the same hook that writes the durable artifact representing its completion (P4). History lives in the artifact (which `fulfills`-links the todo's text), not on the board. The board only ever contains open work.

**3.2.8 `disconfirmed_hypothesis`** — `question`, `rejected_answer`, `evidence` (✔ — same evidence bar as anti-pattern capture: provenance, file:line or run id), `file_keys[]`, plus common envelope + links (`informed_by` → the debug run or research finding that disproved it). **Purpose: future debug runs must not re-litigate false trails already disproved** — the debug fan-out produces refutations *by design* (independent derivation refutes); this is where they live instead of dying. Consumers: debug step 2, reviewer-skeptic, planning when file-key joined.

**3.2.9 Transient records (run-scoped, NOT in the knowledge store)** — live under `runs/<run-id>/`, disposed with the run after promotion:
- `handoff`: `{phase_id, agent_role, what_changed: {path, change_role}[], wired[], deferred[], decisions_made[], tests_produced[], exit_signal, unresolved[]}`
- `run record`: `{id, brief_ref, branch, machine_state: enum running|completing|awaiting_merge_gate|merged|rejected|halted, phases: {id, status, signals[], commits[]}[], dispatch_counts (per agent type), escalations[], started_at}` — created **at gate approval** (the run begins there; everything before is conversation + the brief artifact). `completing` = capture/disposal pending (H9 blocks Stop); `awaiting_merge_gate` = disposal done, human decision pending (stopping legitimate). The TUI live-run tab is a view over this record. The conductor's source of truth for run state is this record via `run_state`, **never its own memory** (safe across compaction).

### 3.3 Store scoping and the domain-capability policy

- **Write routing:** a learning goes to a **shared domain store** if it would be true for a different consumer of the same domain (API behavior, platform gotchas); otherwise the **project store**. Record-type defaults: reference/research → domain-candidate; feature articles → always project. When uncertain: project-store-then-promote (promotion candidates surface via the maintenance queue as `promotion_review`).
- **Mounting:** the project's `stack_tags` (declared/confirmed at init) are the mount manifest — the MCP server mounts the project store plus the named domain stores. Retrieval filters within the mounted set.
- **Domain-capability policy (locked):** domain stores are created **lazily** when a project's stack first needs them; **seeded thin** with known-true stable material only (reference docs with source dates, hard-won gotchas, existing decisions — hours, not a project); **grown automatically via capture**; ordered by frequency-and-cross-cutting (Genesys first for this user). Never authored comprehensively up front. Freshness rules apply to seeds from day one.

### 3.4 Retrieval discipline (one interface, every caller)

`knowledge_query` executes, in order: (1) stack-tag + type filter (deterministic), (2) file-key join where the query names files (deterministic), (3) relevance rank within the filtered set, (4) **cap** (per-caller budget, top-N). Research findings return with both clocks + staleness flag. **The same lazy stale-at-read applies to `basis: platform|external` records** (anti-patterns, reference material): older than a configured threshold → returned flagged `verify_before_use` — wrong old knowledge is worse than no knowledge; the flag costs nothing until read (P4: no sweeps). The same interface serves pipeline agents, the conductor (direct work and planning), and hooks. There is no privileged second path.

**Rank mechanism (locked):** **FTS5/BM25** over each record's indexed text fields (title + body-equivalents per type), evaluated within the already-filtered set; ties broken by `updated_at` desc. Deterministic given the same store state; zero LLM, zero tokens. Embeddings are rejected at this scale — the filters and file-key join have done the heavy lifting; rank only orders survivors. Query terms come from the optional `rank_terms: string[]` parameter: plain keywords, zod-enforced (array of single terms, per-term length cap — a keyword array cannot smuggle in a freeform question). Absent `rank_terms`, fallback ranking is mechanical: file-key overlap count, then `updated_at` desc.

### 3.5 Maintenance (event-bound, never scheduled — P4/P5)

- **Reconcile-as-process (NOT a tool):** any change to files a feature article owns triggers reconciliation — a script/cheap-agent diffs the article's claims against what actually changed (file list, behavior), rewrites the body to current reality via `knowledge_update` (new version, prior superseded-and-retained), appends the change brief/plan/test-event to history, and updates `live_test_refs` and AC-traced tests. **Pipeline path:** gated — the final completeness check blocks run completion until every owning article is reconciled. **Article size valve:** reconciliation checks mechanical thresholds (body size, owned-file count — config); breach → maintenance-queue item proposing an article split or dependency extraction (never auto-split; human decides). A giant article hurts P6 — relevant to everything, specific to nothing. **Conductor-direct path:** reconciliation happens inline or the article is registered to the maintenance queue (`reconcile_needed`) by the file-touch hook. Optional manual trigger: *(deferred)*.
- **Lazy staleness at read** for research (3.2.4). No sweep jobs exist anywhere in Sterling.
- **Write-time reactions:** article → `deprecated` walks its links and flags dependents; supersession flags citers to re-check; a new article touching files another article owns flags the overlap. Automatic systems **flag and surface; they never delete or rewrite** beyond the defined reconcile process. Deletion is exclusively the gated cleanup run (Section 8.4).

---

### 3.6 Knowledge flow map (the compound loop, auditable at a glance)

Compound knowledge is the product (P2); this table is the loop's wiring diagram. **Spawn-contract validation (Section 6) checks every agent's declared knowledge slice against the consumer column** — a judgment role missing its slice fails the build, not the run.

| producer event | record produced | consumers (staged automatically) |
|---|---|---|
| planning / grill (decision capture) | `decision` | planning (all features), prep → coder, reviewers (diff-keyed), test-writer (conventions slice), debug step 2 |
| run capture gate (article write/reconcile) | `feature_article` | planning, prep → coder, reviewers (feature context), debug step 2 (intended_behavior = breakage oracle), TUI |
| run capture gate (objection triage — see 7.1) | `anti_pattern` | prep → coder, reviewers (diff-keyed; `severity: block` on a touched file = mandatory check item), debug step 2 |
| run capture gate (mutation survivors) | `feature_article.known_gaps[]` | next run touching those files (file-key join), reviewers |
| debug play step 6 | `anti_pattern` + article reconciliation + regression test | same as above |
| debug play step 6 (fan-out refutations) | `disconfirmed_hypothesis` | debug step 2, reviewer-skeptic, planning (file-key joined) |
| researcher dispatch | `research_finding` (both clocks + staleness) | planning, prep → coder, debug step 3 |
| note capture (TUI/command) → H11 extraction | `note` + `derived_unconfirmed` candidates | planning only (opt-in, confirm-or-kill — 3.2.6) |
| run lifecycle | run record (escalations, `check_skipped`, dispatch counts) | config-tuning revisits (§17), merge-gate summary, TUI |

Every consumer reads through `knowledge_query` (3.4) — no privileged path (P6). Every producer writes at a bound event (P4) — nothing depends on remembering to capture.

### 3.7 Knowledge accountability (the loop's audit: capture → retrieve → stage → mandatory disposition → audit)

Knowledge is not compounded merely because it was written — it must be retrievable, staged, and either used or explicitly dispositioned. **Not**: cite everything, score usage, let ranking drift.

- **`knowledge_pack` (run-scoped manifest, NOT durable knowledge):** every prep staging writes one under `runs/<run-id>/` — consumer role, run/phase id, query inputs, returned record ids, **mandatory record ids with the reason each is mandatory** (`severity_block` | `known_gap` | `required_by_contract`), cap omissions. Disposed with the run; only summary facts go to the run record / merge-gate summary. Prep is a script, so the pack is a free byproduct.
- **No universal citation tracking.** Forcing every agent to cite every record produces phantom-violation noise and erodes trust in the gate (P1).
- **Disposition rule:** required **only for mandatory items, only from judgment roles.** The reviewer verdict schema gains one structured field per mandatory item: `addressed` | `not_applicable_because: <reason>`. The merge-gate summary shows undispositioned mandatory items. Non-mandatory knowledge can be ignored without ceremony.

## 4. The brief-as-contract (first-class artifact)

The brief is the executable contract the whole run is checked against: tests derive from its acceptance criteria, the pre-edit hook enforces its scope, the completeness checks trace the diff back to it, and the post-plan grill checks plan-fidelity against it. Produced by the conductor-run intake→planning stage (Section 8.1); stored durably as a **structured object in the project store — the single authoritative copy; every hook, check, and agent reads this and only this**. `docs/briefs/<slug>.md` is a generated read-only projection for human reading (same rule as the architecture view, Section 12) — regenerated on brief change, never hand-edited, never consulted by enforcement. Linked into the feature article's history.

**Structure (full precision):**

```yaml
brief:
  slug, title
  problem: string                      # why this exists
  feature: string                      # what is wanted
  user_stated:                         # ATTRIBUTION DISCIPLINE — two sections, never merged
    criteria: string[]                 # traceable to verbatim user statements
    constraints: string[]
  conductor_proposals:                 # inferred/recommended; each marked
    - {text, status: confirmed|unconfirmed}   # unconfirmed items are open questions downstream, never requirements
  acceptance_criteria:
    - {ac_id, text, verifiable_at: phase:<n>|final}   # phrased as observable END-TO-END behavior
                                       # ("user clicks Export and gets a file"), never as artifacts existing
                                       # ("an export function exists") — reachability is intrinsic to the AC
  technical_design:                    # output of the planning design step (or impl-architect)
    approach: string
    interfaces: {name, contract}[]     # cross-cutting structures phase coders must respect
    shared_structures: string[]
  blast_radius:                        # partly mechanical (file-key join result included verbatim)
    files: {path, owning_articles: id[]}[]
    reconcile_list: id[]               # articles that MUST be reconciled at completion (mechanical output)
  incidental_scope: string[]
  out_of_scope: string[]               # enforced by the pre-edit contract gate
  phases:
    - {phase_id, goal, subtasks: string[], ac_ids: string[],
       difficulty: {level: normal|hard, reasons: string[]},   # reasons cite the rubric:
       # algorithmic/logical complexity | blast radius > N (mechanical) | thin knowledge support
       # (mechanical: prep retrieval volume) | ambiguity residue | poorly-covered external integration
       model_hint: derived from difficulty}
  decisions_made: id[]                 # design decisions captured as decision records, cited
```

Difficulty drives model+effort routing (Section 7.2) and is human-overridable at the gate. The phase `subtasks` list is the per-phase completeness checker's contract. The brief's AC + scope sections are locked at the gate because hooks will enforce them for hours.

---

## 5. Signal protocol and orchestrator

### 5.1 The signal enum (CLOSED — totality-checked)

Every phase-internal agent ends in exactly one of: normal success, or a typed abnormal exit. The enum is closed; emitting anything else is a validation error; an unknown signal reaching the brain **halts the run loudly** (P5). An agent that produces *no* parseable exit — crash, empty output, free-text garbage — is reported by the conductor as `agent-died` with the appropriate `observed` discriminator; the brain's halt-loud rule remains as defense-in-depth for unknown members reaching `run_signal` itself. Each signal carries a typed payload and a `resolution` flag (`mechanical` = the table's action executes as the default; `judgment` = the conductor must decide to proceed).

| signal | payload | resolution | brain's reaction |
|---|---|---|---|
| `complete` | `{handoff_ref}` | mechanical | spawn next phase; if final phase → run-completion sequence (final completeness → capture → merge gate) |
| `research-needed` | `{question, context, blocking}` | mechanical dispatch, judgment resolve | dispatch researcher (bounded brief, capped budget); classifier on the finding: resolves → **reset run branch to last phase commit (uncommitted partial work discarded — P7, same as `agent-died`)**, re-run prep, respawn the phase with finding staged; contradicts a plan assumption → escalate `judgment: plan-broken` |
| `review-unresolved` | `{objections[], reviewer_agreement: agreed_broken\|disagreed}` | judgment | post-cap (M) only; surface to human with the disagreement type — retry is futile by definition |
| `blocked` | `{reason}` | judgment | escalate with payload |
| `tests-invalid` | `{evidence}` | judgment | the fix loop believes the tests are wrong — never silently patched; route to test revision (re-dispatch test-writer with evidence) under human eye |
| `contract-violated` | `{path, rule}` | judgment | gate-tripped (can fire on first attempt); usually means the plan mis-scoped the phase → re-plan signal |
| `bug-found` | `{description, location, depends_on_current_work: bool, workaround_built: bool}` | judgment | discriminator: depends-on-it (or workaround built) → halt-fix-resume (fix gets its own scoped treatment; on resume, remove the workaround); incidental → board it file-keyed, continue |
| `phase-overflow` | `{agent, fill_pct}` | judgment | the 95% block fired — work is rejected (not salvaged), route to re-decomposition; per-agent overflow responses in Section 14 |
| `agent-died` | `{agent, phase_id?, observed: crash\|empty_output\|malformed_exit, raw_excerpt}` | mechanical (first crash/empty); judgment (repeat, or malformed) | **conductor-reported, never agent-emitted** — the conductor maps abnormal Task returns to this signal and never retries or improvises on its own. **crash/empty:** handoff treated as absent; discard uncommitted work (reset run branch to last phase commit — P7, rejected not salvaged); re-run prep; respawn once (per-phase death cap, default 1, tunable; respawns count under H8); second death in the same phase → escalate. **malformed_exit:** the agent ran but its exit is not an enum member — a broken agent contract, not transient noise; never blind-retried → escalate with `raw_excerpt` (P5's halt-loud, scoped to the phase) |

**Caps that convert loops into signals:** inner loop (coder↔tests) cap **N** (default 3) → exits `blocked{tests-unsatisfiable}` or `research-needed`; outer loop (review↔fix) cap **M** (default 2) → exits `review-unresolved`; per-phase research-resume cap (default 2) → `blocked{phase-underspecified}`; **run-level same-agent dispatch cap** (default 25 per agent type per run, enforced by hook) → halt + escalate; cross-run research-escalation threshold → "plan was built on too many unknowns, re-plan remainder". All caps are tunable config.

**Extension path (locked):** adding a signal = add to the enum (one definition, single source of truth) → the **totality check fails** until a reaction + resolution flag is added to the table → document when emitters use it. A signal cannot be half-wired by construction.

### 5.2 Orchestrator embodiment: brain in the MCP server, conductor as hands

Platform constraint: only the session can dispatch subagents (Task tool). Therefore:

- **The brain** is a deterministic state machine inside the MCP server (next to the run state it transitions). `run_signal(exit)` computes the reaction from the table and returns the next action: `{action: spawn, phase, briefs}` | `{action: dispatch_support, type, brief}` | `{action: judgment_needed, payload}` | `{action: complete_run}` | `{action: halt, reason}`. Pure function, unit-tested over the full enum (totality test), zero LLM, zero tokens. **Transitions are atomic compare-and-swap on `machine_state`** (`UPDATE … WHERE machine_state = <observed>`; zero rows updated → the call carried stale state and is rejected loudly, never re-applied) — idempotent against conductor replays after compaction, and safe against a forgotten second session; the TUI already makes multiple-processes-on-one-store the normal case, not the exception.
- **The hands** are the conductor: the dying agent's last acts are `handoff_write` + **`agent_exit(signal)` — an MCP call, never prose**: zod validates the signal at the server (an invalid signal is rejected in-band, so the agent sees the error and corrects itself), and the exit lands on the run record. **On Task return the conductor calls `run_signal`; the brain reads the stored exit.** Every dispatch passes through the conductor's hands. Task returned with no exit recorded → `agent-died{empty_output}`; a crash maps to `agent-died{crash}` — the conductor never silently retries, never invents a signal, never routes around the brain. *(With the exit in-band, `malformed_exit` survives only as the defense-in-depth case: garbage reaching `run_signal` itself.)*
- **Interject:** mechanical actions are *defaults the conductor can hold or override* ("the machine says spawn phase 5; I noticed phase 4's diff looks wrong — holding"). Judgment actions *wait* for the conductor/human. The conductor observes the full live signal stream (Role 2 — observer/companion — is always on, for every transition).
- **Degraded fallback:** if the brain is unavailable, the conductor may route manually using the reaction table as reference — visible, deliberate, temporary. Prose-routing is never the design.
- The run record + machine state begin **at gate approval**; pre-gate work is conversation + the brief.

---

## 6. Hook manifest (FULL PRECISION — implement exactly; verify mechanics against current docs first)

**Global mechanics** *(verify-at-build)*: PreToolUse blocks via the documented decision field (`hookSpecificOutput.permissionDecision`) and/or **exit 2** — exit 1 is non-blocking; getting this wrong silently voids a gate. PostToolUse is observability-only. Handler types: `command` (shell/.mjs), `prompt` (single-turn LLM), `agent`. HTTP handlers are never used for enforcement (non-2xx is non-blocking).

**Declaration placement (locked — the load-bearing finding):** project-level hooks do **not** reliably fire for subagent tool calls (open platform issue). Therefore: every hook guarding a subagent's behavior is declared **in that agent's own definition frontmatter** (agent-scoped by construction); project-level hooks cover conductor/session events; **universal gates are declared in both** (idempotent — harmless if inheritance ships later). *(verify-at-build: frontmatter-hook blocking semantics, i.e. exit-2 inside subagents.)*

| # | hook | event / matcher (`if` on args where noted) | handler | blocking | declared in | action |
|---|---|---|---|---|---|---|
| H1 | conventions + banner | SessionStart | command | no | project | inject conventions (anti-speculation, no-false-action, canonical names); print banner (swappable art slot, width-aware, suppressible via `--no-banner`/env/piped) + **board/maintenance counts** ("7 todos · 3 maintenance items pending") — the queue is event-drained and otherwise invisible; this is its visibility pressure |
| H2 | selection inject | UserPromptSubmit | command | no | project | one-shot consume the **selection row in the store** (transactional read+delete) → inject `{type, record_id}`; conductor resolves via `knowledge_get`. No signal file — P4 bans shared mutable transient files, including this one |
| H3 | **contract gate (dual-mode)** | PreToolUse `Edit\|Write\|MultiEdit` | command | **YES exit-2** | coder, fixer-mode, every code-touching agent **+ project** | **run mode** (run record exists): path outside brief `blast_radius`+`incidental_scope` or inside `out_of_scope` → deny; also require read-evidence for the file via the **H13 reads ledger** (the editor must have `Read` the exact file within its window). **direct mode** (no run): enforce read-before-edit via the same ledger + register file-touch for reconciliation. **debug-scope mode** (registered explorer map): deny outside the map → "confirm or expand the map" |
| H4 | test-writer read wall | PreToolUse `Read` `if: source paths (non-test, non-doc — per the adapter's test-path globs, 9.1)` | command | YES | test-writer | deny — the test-writer never reads implementation |
| H5 | frozen-test gate | PreToolUse `Edit\|Write` `if: test paths (per the adapter's test-path globs, 9.1)` | command | YES | coder, fixer-mode | tests are frozen during the fix loop; a believed-wrong test exits `tests-invalid`, never silent edit |
| H6 | **context watcher (usage-read, never token-count)** | PostToolUse `*` (compute) + PreToolUse `*` (enforce) | command | 95% YES | **every spawned agent** | tail-read the agent's transcript (last ~64KB), take the most recent assistant entry's `message.usage`; fill = (`input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens`) / model window size (per-model config) — the API's own accounting, includes system prompt + tool defs; no tokenizer, no calibration, no cumulative state. ≥60% (tunable): flag warn to run record (acted on at next boundary). ≥95% (tunable): deny further tool use → `phase-overflow`. **Config `mode: observe | enforce`** — `observe` records fills and skips the deny (MVP-spine default; flip to `enforce` once calibrated against real runs). Known one-call lag (usage is as-of the last completed API call); the 95% margin absorbs it, and an oversized `tool_response` in the same invocation triggers an immediate warn. **Startup self-check** at SessionStart: confirm a usage object is parseable from the conductor's transcript tail; failure → H6 degraded **loudly** — `check_skipped {check: context-watch, reason: format_unparseable}` recorded on any run + shown at the merge gate; runs proceed. Conductor's own fill: native statusline `context_window.used_percentage` (same formula). Swap to native `sub_agents[].context_usage` if the platform ships it *(deferred watch)*. **Resolved by Layer 0 probe:** in-subagent `transcript_path` is the *parent's*; the agent's own transcript is derived as `<session>/subagents/agent-<agent_id>.jsonl` (agent_id from hook input), with parseable `message.usage`. |
| H7 | file-touch reconcile register | PostToolUse `Edit\|Write\|MultiEdit` | command | no | project + agents | look up owning articles (file-key join); mark `reconcile_needed` on the run (pipeline) or maintenance queue (direct) |
| H8 | dispatch cap | PreToolUse `Task` | command | YES | project | increment per-agent-type run counter; over cap → deny + escalate |
| H9 | run capture **backstop** | Stop | command | YES (blocks stop only while `machine_state = completing`) | project | **The gate itself lives in the disposal script** (`scripts/dispose-run.mjs`) — the only path to deleting `runs/<id>/`: it re-verifies every promotion condition against the store (feature article written + reconciled per `reconcile_list`, decisions captured, **objection triage done + mutation survivors written to `known_gaps`**, AC-traced tests promoted, fulfilled todos removed artifact-write-bound) and refuses otherwise (exit non-zero naming the unmet condition). Bad disposal is impossible, not detected — holds even if every hook is broken. H9 catches the failure the script can't see (a script only runs when invoked; Stop fires no matter what): on Stop with `machine_state = completing`, exit 2 with the outstanding items — the conductor resumes the sequence instead of abandoning it. Disposal success advances state to `awaiting_merge_gate`, where stopping is legitimate (the human decides the merge at leisure); run rejection clears the state (record → `rejected`) so a rejected run never traps the conductor in a block loop. Hook-semantics drift can weaken the backstop (worst case: a visible stalled run), never the gate |
| H10 | direct-path capture check + review | Stop | command → prompt | soft | project | artifact-produced-but-no-capture → prompt conductor to capture inline; still missing → maintenance queue (`capture_owed`). Code-touching diff → run reviewer-selection script and dispatch exactly what it returns; test-touching → test-integrity vs **git HEAD** |
| H11 | note structuring | PostToolUse `mcp knowledge_create` `if: type=note` | prompt (Haiku) | no | project | extract `derived_unconfirmed` records citing the note |
| H12 | wiring + zero-consumer check | run-completion script (part of final completeness, not a per-edit hook) | command | gates | project | static: new exports referenced only by tests = built-but-not-wired → block unless brief declared dormancy (then write `wire_in_dormant` todo). Dynamic wiring is covered by the end-to-end AC tests |
| H13 | reads ledger (H3's evidence collector) | PostToolUse `Read` | command | no | every code-touching agent + project | append `{agent_id, path}` to the transient reads ledger H3 consults. Lifecycle (P4): pipeline → `runs/<id>/reads/agent-{id}.json`, dies with the run dir; direct mode → conductor ledger cleared on every UserPromptSubmit. Windows: subagent = since spawn; conductor = since last user prompt. Only `Read` of the exact file counts — Grep/Glob hits are not read-evidence (read before edit; grep callers) |
| H14 | Bash allowlist | PreToolUse `Bash` | command | **YES exit-2** | coder, fixer-mode | deny-by-default command patterns: allow only the toolchain adapter's declared run commands + `fs-remove`/`fs-move` invocations; **shell control operators (`&&`, `;`, `|`, redirection) are denied outright — an allowlist holds only if commands cannot be chained** (an allowed command followed by `&&` is a smuggling hole, build-proven). Everything else exits 2 with the allowlist named. Frontmatter grants the tool; this hook is the restriction (Section 7.1) |

**Blocking gates are `command` handlers only — never `mcp` or `prompt` handlers:** an mcp-type hook whose server disconnects degrades to a *non-blocking* error (the action proceeds — a silently voided gate), and agent/prompt handlers are non-deterministic. Hard policy is a command hook with **exit 2** (exit 1 is non-blocking by platform semantics).

**Hook command emission rule (probe-verified, Windows-critical):** on Windows, hook commands run under git bash — backslash paths in hook command strings are **silently mangled and the hook fails as a non-blocking error**: enforcement vanishes with no signal. Every hook command string Sterling emits (hooks.json, agent frontmatter, generated at init or sync) uses **quoted forward-slash paths**, and hook emission runs a backslash consistency check (also in the commit-time checks). This extends the global path invariant (3.2) from stored paths to emitted command strings.

**Consistency/extension checks** (commit-time scripts, not Claude Code hooks — wired as git pre-commit + build steps): totality check (every enum member has reaction+flag), spawn-contract validation (every agent's required inputs are producible upstream), prompt linter (Section 7.3), **skill linter** (stale file/API references in SKILL.md files), schema-registry validation (every written type is registered), **adapter-registry validation** (every declared toolchain resolves to a registered adapter; Section 9.1), **hook-emission backslash check** (no backslash paths in any emitted hook command string — see emission rule above). One registry per extensible set (signals, record types, agents, hooks, tools, toolchain adapters); all dependents derive from the registry; desync fails the check (P5).

---

## 7. Agents and the conductor

### 7.1 Roster

**Conductor-run (skills/SOPs, NOT spawned agents — only the session can converse and dispatch):** intake, grill-intent (pre-plan), planning (plan-mode-shaped), grill-plan (post-plan), debug SOP, cleanup SOP, orchestration-hands, conductor-direct execution.

**Spawned agents** (each an `agents/*.md` with frontmatter: model, effort, tools, per-agent hooks, required-inputs manifest):

| agent | job | notes |
|---|---|---|
| **test-writer** | per-phase, adversarial, spec-only test authoring | reads brief + full AC + phase AC slice + prior tests + prior handoffs; **never code** (H4) |
| **coder** | implement a phase's subtasks | also invoked in **fixer-mode**: same definition, corrective brief, minimal-change instruction; inner-loop invocation sees only test output, outer-loop only review objections — never both |
| **reviewer-correctness** | logic/state/async correctness (= Forge's "logic") | full context, narrow brief |
| **reviewer-security** | injection/secrets/validation | diff-selected |
| **reviewer-skeptic** | over-engineering + missing-feature-context as defects; "smallest change that satisfies the brief?" | diff-selected |
| **reviewer-performance** | hot-path/IO/loop/query changes | diff-selected only when implicated |
| **implementation-architect** | cross-cutting technical design for architecturally-complex features | dispatched by the conductor at planning (pre-dispatch when complexity is visible at intake — the common case) |
| **researcher** | bounded online research answering one specific question | capped budget; output captured as `research_finding` |
| **explorer** | codebase exploration / blast-radius mapping | consults articles first, code second; its map can register as debug-scope (H3) |
| **prep [S — a script, not an agent]** | stage file refs + knowledge for a phase (or planning) | pure mechanics (P3): reads the phase spec's declared `rank_terms` + file list (judgment happened once, at planning, human-supervised), `handoff_read` for intersecting prior phases, `knowledge_query` with the declared keys, stages references over-inclusive-but-capped. Zero LLM, zero tokens, deterministic and unit-testable |
| classifiers | noise-gate ("generalizable?"), note-structurer | Haiku-tier prompt-hook steps, not full agents |

**Reviewer dispatch is deterministic (never hand-picked):** a selection script returns exactly the reviewers to dispatch, from two mechanical signal sources: **brief risk flags** (`security_relevant`, `perf_sensitive` — proposed by the conductor at planning, human-confirmed at the gate, frozen into data before the run) and **greppable diff signals** (path patterns like `auth/`/`token`/`secret`, content patterns like SQL string concat/`exec`/route handlers/env access, dependency-manifest changes; size/new-export thresholds for the skeptic — all config, per toolchain). Correctness always runs on code-touching diffs — the floor that catches what conditional reviewers miss. The script **logs why each reviewer was and wasn't dispatched** (shown at the merge gate — a wrong skip is auditable, never silent). Signal sets start over-inclusive and are tuned down on run data, never the reverse. **Test-touching diffs always trigger the test-integrity script** (frozen-baseline diff — phase baseline in runs, git HEAD in direct mode), evaluated before any skip path. Reviewers that run, run with **full** handoff + feature context — specialization lives in the brief, never in input-slicing (no context-starved triage). Surviving mutants from the phase's mutation round are included in every dispatched reviewer's brief as **priority inspection sites** (a mechanically proven map of where no test can detect a fault), and reviewer rubrics name them as such. **Objections compound:** at the capture gate the conductor runs one triage pass over objections that revealed real defects — same noise-gated, evidence-required bar as debug capture, recurrence as the trigger (second occurrence of the same failure shape = capture as `anti_pattern`, citing both runs). Reviewer findings never die with the run. **Verdict schema:** every mandatory knowledge item in the reviewer's pack (3.7) carries a structured disposition in the verdict — `addressed` | `not_applicable_because: <reason>`; undispositioned items surface at the merge gate.

**Tool surfaces (deny-by-default for spawned agents):** every gate (H3/H5/H7/H13) is a hook on `Edit|Write|MultiEdit|Read` — an unhooked write path makes the contract layer advisory, and the threat is drift under loop pressure (a coder denied an edit routes around the gate), not malice. Therefore: **coder/fixer-mode get no general Bash.** Mechanism: frontmatter *grants* the Bash tool, and a **per-agent PreToolUse Bash allowlist hook (H14)** enforces command patterns — frontmatter cannot express command-level restriction; hooks can, and this keeps enforcement on the surface that's robust to frontmatter-syntax drift. The allowlist: (1) the toolchain adapter's declared run commands (test/build, per Section 9.1, baked in at init) and (2) the **contract-checked fs helpers** `fs-remove` / `fs-move` — both share H3's contract logic as a common module and register file-touches (H7); `fs-move` additionally **updates `file_keys` on every owning record as part of the move** (renames inside the machinery never orphan knowledge). All other file access flows through Edit/Write/Read/Grep/Glob. Inner-loop mechanics fall out directly: **the coder invokes the allowlisted adapter command itself; classified results return as ordinary command output in its own context** — no relay, no injection machinery; red check, mutation check, and the completeness checks are conductor-invoked [S] steps, never coder-invoked. Test-writer: no Bash. Reviewers/explorer: read-only (Read/Grep/Glob). Researcher: web tools. Honest limit, stated so no one overclaims: the allowlisted test command executes arbitrary code, so a written test *could* perform an out-of-scope write as a side effect — this design is drift prevention, not a sandbox; review and the completeness diff remain the net for the deliberate route. **The conductor keeps unrestricted Bash (documented residual):** it is the human-attended surface, observed live, and conductor-direct mode requires a shell. *(verify-at-build: frontmatter syntax for per-agent tool restriction and Bash command-pattern allowlists.)*

**Cross-model (deferred):** the OpenAI slot, if ever activated, goes to a reviewer and/or the test-writer (independence pays at the oracle and the check, never as a supervisor); if OpenAI ever codes, the reviewer must remain a different family. Decide against real output when the time comes. Until then: single vendor, tier decorrelation (Opus oracle vs Sonnet coder).

### 7.2 Model + effort defaults (TUNABLE CONFIG, not architecture — revisit against incident data)

| role | model | effort | rationale |
|---|---|---|---|
| conductor session | user's choice — **recommend Opus for feature planning** | high | planning now runs in-session |
| test-writer | Opus *(watch — may step to Sonnet on evidence)* | high | the oracle-maker; foundational |
| reviewers (all) | Opus | **low — flat across all phases** | single-shot, input-dominated judgment: effort can't meaningfully cut the cost (input dominates), so buy the model tier, not thinking depth; preserves Opus-reviews-Sonnet decorrelation; step *up* to medium only on eval evidence that low misses real defects *(verify-at-build: effective input-token ratio on a representative diff via the free `count_tokens` endpoint — if the Opus-tokenizer code penalty pushes the effective input premium ≳2×, revisit Sonnet)* |
| implementation-architect | Opus | high | the heavy design step, dispatched |
| coder / fixer-mode | Sonnet; **Opus on `difficulty: hard` phases** | high; xhigh only on small-scoped hard phases | high-volume loops stay cheap |
| researcher | Sonnet | medium–high | bounded synthesis |
| explorer | Haiku (Sonnet for judgment-heavy exploration) | low–medium | bounded reads; prep is a script (Section 7.1), not a model consumer |
| classifiers | Haiku | low | cheap judgment calls |

**Hard rules:** subagents cannot compact → **max effort is never used for subagents**; escalation on hard phases is **model-first, then effort** (a strong model at moderate effort beats a weak model straining, under a non-compactable budget). Effort thresholds and the difficulty rubric live in config.

### 7.3 Agent-prompt contract (the quality floor) + prompt linter

Every agent definition contains, in order — the linter enforces presence; missing = build failure:
1. **Role & owned judgment** — the specific thing this agent owns, sharply.
2. **Inputs it will receive** — mirrors its spawn contract's required-inputs manifest.
3. **Rubric / priorities** — what to weight, in order.
4. **Worked example(s)** — input→good-output pair(s). **Mandatory for judgment-tier** (test-writer, reviewers, impl-architect); encouraged for all. The single biggest quality lever.
5. **Output contract** — the exact handoff schema for this role, with one example of a *well-filled* handoff.
6. **Scope boundaries (negatives)** — what it does NOT do (coder doesn't touch tests; fixer-mode minimal-change-only, no refactors of working code; test-writer never reads code).
7. **Exit signals it may emit** — only members of the closed enum, with when-to-use.

Claude Code drafts the prompt **text** to satisfy this contract (it is not pre-written in this spec); the text is not "built" until the linter passes. Prompt text is then tuned against real output (ship-and-tune); the contract is fixed.

### 7.4 Handoffs and spawn contracts (the anti-Forge-bug machinery)

Agents communicate **through the durable run records, never by relay**: writer writes (`handoff_write`), reader reads — no agent depends on another remembering to pass anything. Handoff schema: shared core (`what_changed{path,role}[]`, `wired[]`, `deferred[]`, `exit_signal`, `unresolved[]`) + role-specific fields (coder: `tests_passed`, `decisions_made`; reviewer: `verdict`, `objections[]`).

Every agent role has a **required-inputs manifest**; for judgment roles it includes a **knowledge slice** (prep-staged via `knowledge_query`, capped per role): reviewers receive anti-patterns + decisions keyed to the diff's files — a `severity: block` anti-pattern on a touched file is a **mandatory check item** in the reviewer brief; the test-writer receives the decisions/conventions slice for the phase (records, never code — H4 untouched). **No judgment agent works knowledge-blind (P6, operationalized).** A spawn-time check verifies presence **before the agent runs** — a coder spawning into a phase with no tests in its record is a loud error (test-writer didn't run, or dormancy was declared), never a silent proceed-and-invent. Per-phase **prep runs at phase spawn against current state** (including prior phases' commits and handoffs intersecting this phase's files — intra-run blast radius), never once-per-plan; it is a script invoked by the conductor, and any relevance judgment it would need (rank_terms, file list) is declared in the phase spec at planning time — never improvised at staging time.

### 7.5 Conductor contract (written into CLAUDE.md by init — same quality floor as agents)

Contains: the conduct rules (1.2) verbatim-in-spirit; **mode selection** (conversation is the default entry; conductor decides conductor-direct vs proposing a pipeline run vs invoking the debug play; `/sterling:feature` exists only as a force-pipeline override); **run-state-from-store** (after compaction, re-read `run_state`; never trust recall); the conductor-direct envelope (8.2); when to pre-dispatch the impl-architect; planning-time inline-lookup license (small bounded questions only — web + knowledge tools — capture findings; big unknowns → dispatch the researcher); interject rights and judgment-branch participation; the maximal-relevant-context principle applied to its own reads; tool efficiency (dedicated tools over Bash; no subagents for plain file reads).

### 7.6 Workflow SOP skills (ship with the plugin)

- **grill-intent** — pre-plan interview: extract what exists only in the user's head; one question at a time; drive every brief section to resolved-or-waived; verbatim-input only; research trigger ("can we do X?" the user can't answer → conductor dispatches researcher mid-grill); user-stated vs conductor-proposal attribution with explicit accept/reject per proposal.
- **planning** — plan-mode-shaped conductor phase, read-only discipline *(verify-at-build: ride native plan mode literally if MCP writes + plan-file-as-brief work inside it; else replicate read-only via our hooks)*. **Iterable steps:** (1) technical design [pre-dispatch impl-architect when complexity is visible; explorer/researcher dispatched for heavy reads], (2) decomposition into phases informed by the design (blast-radius re-read if design widened scope; each phase spec declares its file list + `rank_terms` — prep's staging inputs are planning outputs), (3) AC formalization + difficulty flags + risk flags (`security_relevant`, `perf_sensitive` — reviewer-selection inputs, confirmed at the gate) (mechanical inputs: blast-radius count, prep retrieval volume), (4) brief assembly + decision capture (planning retrieval runs with `include_unconfirmed: true`; any `derived_unconfirmed` record relied on is confirmed-or-killed per 3.2.6 before the brief locks). Each step's output is a required, checked brief section. Feature-sizing check at intake: a feature too big to plan in one conversation is split into features (P7).
- **grill-plan** — post-plan fidelity walkthrough: a script pre-computes intent↔plan divergence flags (plan's file/scope claims vs the brief's user-stated + out-of-scope); the human adjudicates flagged divergences; runs **in full regardless of familiarity** — the urge to skim is highest exactly when an edge will slip.
- **debug** — the root-cause SOP (Section 8.3).
- **cleanup** — the gated deletion run (Section 8.4).

---

## 8. Execution modes (all three first-class)

### 8.1 Pipeline (plannable, staged, gated work)

```
conversation (conductor):
  intake → grill-intent → planning (steps, dispatching explorer/researcher/impl-architect)
        → grill-plan (divergence flags) → ★ THE GATE ★ (intake→implementation; AC confirmed,
          contract locked, difficulty flags overridable; rides plan-approval primitive)
run (record created at gate approval; brain governs from here):
  branch created (run branch)
  per phase: prep [S] (current state incl. prior commits/handoffs; declared rank_terms + files from the phase spec)
           → test-writer (phase AC slice + the brief's interface slice for the phase — REQUIRED input:
               a phase whose interfaces aren't declared gives the test-writer nothing to write against;
               spawn fails loud as a planning error, never improvised around; spec-only)
           → red check [S]: tests fail ON THEIR ASSERTIONS (not crashes)
           → coder ⇄ test-runner [S] / fixer-mode (cap N; H3/H5/H6 live) → green
           → mutation check [S], scoped to the phase's diff (one round per phase, config):
               no survivors → proceed
               survivors → test-writer strengthening dispatch (H5 binds the coder, never the test-writer;
                 brief permits marking a survivor `equivalent — unkillable` with justification, excluded
                 from the blind-spot list) → run strengthened tests against current implementation:
                 all pass → targeted re-mutation of prior survivors only (confirm kills) → proceed
                 any fail → real bug the original tests missed → coder re-enters the fix loop (same N counter)
               survivors remaining after the round: recorded in handoff `unresolved[]` + fed to every
                 dispatched reviewer as priority inspection sites — never silently dropped
           → per-phase completeness [S]: every subtask evidenced
           → diff-selected reviewer fan-out ⇄ fixer-mode (cap M; outer brief = objections only)
           → phase commit to run branch → handoff_write → agent_exit (MCP) → conductor → run_signal → next
  final completeness [S]: phases collectively satisfy the brief; every AC has passing traced tests
    (verifiable_at honored — `final` ACs run here, incl. end-to-end wired-path tests);
    whole-run diff within contract; wiring/zero-consumer check (H12); reconcile_list fully reconciled
  capture gate (dispose-run.mjs verifies + disposes; H9 backstops abandonment): article (state machine
    set: active/wired_in, or declared dormant + wire todo), decisions, test promotion, todo removal
    → dispose runs/<id>/ → machine_state: awaiting_merge_gate
  ★ MERGE GATE ★ — the single human-confirmed merge-to-main (the only other gate; replaces
    Forge's commit+push token ladder). Run rejection at any point = branch deleted, main untouched.
```

Two gates total (P1): intake→implementation (where cost-of-wrong jumps from paper to machine-hours) and merge-to-main (the irreversible action). Everything else is live-observed flow with typed escalations.

**Branch model (locked):** the run executes on the run branch **checked out in-place** in the project's single working tree — the observed tree *is* the run; no worktrees (worktree geometry was Forge's drift enabler, and path identity keeps H3 matching, `file_keys`, and the TUI trivially correct — no path normalization anywhere). By construction: **one active run at a time** — the brain refuses a run start while a run record is active; **no conductor-direct edits during a run** — H3's mode switch enforces this (with a run record present, every edit is judged against the run's contract; intended, not incidental); urgent unrelated work mid-run = finish the run or reject it (rejection is cheap by design: branch deleted, main untouched — P7). Dirty-tree discipline: phase commits clean the tree at phase boundaries; `agent-died` resets to the last phase commit.

### 8.2 Conductor-direct (small, low-blast-radius, not worth gating — e.g. a Power Automate flow)

The envelope — **same discipline, no ceremony**: **READ** (knowledge_query: domain store + project store, stack-filtered; load domain capability on demand) → **DO** (on the working branch; H3 direct mode live) → **CAPTURE** (feature article if it's a feature — wired-in state applies to flows too; domain learnings → shared store per write-routing; decisions) → **RECONCILE** (touched articles inline or queue) → **REVIEW** (H10: diff-selected reviewers on code-touching diffs; test-integrity vs git HEAD on test-touching; non-code skips). Enforced by the capture-check hook — the fast path cannot silently leak learnings or ship unreviewed code.

### 8.3 Debug play (interactive by nature — never a pipeline; conductor-run inline)

1. **Trace to the floor before proposing any fix:** from evidence, descend one governing mechanism at a time, citing file:line at each step, until a cited floor. **Gate:** no fix proposal until the chain bottoms out.
2. **Read context first:** explorer pulls owning articles (intended_behavior = the breakage oracle), decisions (the "bug" may be a deliberate choice), anti-patterns, research — *this is what makes the true fix size visible before committing to a patch.*
3. **Verification fan-out (mandatory for code-touching bugs):** dispatch researcher + independent codebase tracer + skeptic in parallel — **each receives the symptom + raw evidence only, never the conductor's floor or fix** (independent derivation refutes; a handed conclusion only confirms). Synthesize after all report; a refutation revises the diagnosis. The skeptic owns root-vs-symptom: "floor = the one root fix; mid-chain = workaround; symptom = patch — never a co-equal menu."
4. **Promotion threshold:** explorer's blast radius spans multiple features/downstream paths → this is a feature-sized change triggered by a bug → **promote to a fix pipeline** (human confirms; blast-radius map becomes the brief's scope; each downstream path a phase; final completeness = all paths fixed + all articles reconciled). Localized → stay inline.
5. **Test before AND after, deterministic, at the real seam:** force intermittent failures deterministically; layer 1 logic unit (RED→GREEN); layer 2 real-dispatch smoke at the actual seam (must reproduce pre-fix — a test green on the broken state tests nothing); layer 3 don't-re-break the legitimate path; layer 4 end-to-end the way the bug was found. Mutation-check the regression test.
6. **Capture:** anti-pattern (what broke / wrong fix / right fix — noise-gated, evidence-required), **disconfirmed hypotheses from the fan-out's refutations (3.2.8 — false trails disproved must not be re-litigated)**, article reconciliation, regression test promoted, workaround removal if one was built, todo removal if boarded. H3 debug-scope mode live throughout (explorer map as lightweight contract).

### 8.4 Cleanup run (deletion is a first-class gated change — the anti-accretion mechanism)

Trigger: `/sterling:cleanup` (or maintenance-queue review). Input: `deprecated`/`dormant` articles + `deletion_candidate` queue entries. The articles' file/dependency data is the evidence that makes deletion safe. Flow: deletion plan → grill ("these N dormant features own these files with no active dependents — confirm") → gated pipeline execution (deletion is *more* dangerous than addition; it earns the full plan→grill→execute→review rigor) → articles' traced tests retire with them → articles remain as superseded history. **Cleanup is never a side-job inside a feature phase** — a coder told to "tidy while you're at it" blows the contract by design.

---

## 9. TDD correctness and the test suite

### 9.1 Toolchain adapters (the per-stack capability layer)

Every mechanical check that touches tests or code analysis — red check, mutation check, inner-loop test classification, test-integrity diff, H12 static wiring — executes through a **toolchain adapter**: a registered module (`scripts/adapters/<toolchain>.mjs`) implementing a fixed interface. No check ever invokes a test framework or analysis tool directly, and no agent ever infers test outcomes from raw runner output.

- **Core (required):** run tests over a scope and classify every result as `pass | assertion_fail | crash`. The red check's "fails on its assertions, not crashes" distinction is the adapter's job, per framework. **Adapters sanitize the child environment before invoking the runner** — inherited runner context variables (e.g. `NODE_TEST_CONTEXT` when invoked from under a test runner) silently switch output protocols and misclassify every result (build-proven).
- **Optional capabilities (declared by the adapter, queryable):** `mutation` (mutate a diff scope, report survivors), `static_wiring` (unreferenced-export analysis for H12's static half).
- **Degrade rule (P5-shaped):** a check whose required capability is absent never silently passes — it records `check_skipped {check, toolchain, reason}` on the run record at the point it would have run, and the **merge-gate summary lists every skip**. Init warns once at declaration time ("apex: no mutation capability — mutation checks will skip loudly").
- **No-test-core toolchains** (e.g. Power Automate): pipeline TDD cannot run. Intake flags any feature whose phases map to such files; the conductor proposes conductor-direct or runbook-verified ACs (`steps_runbook`). Human decides at the gate.
- **Declaration:** toolchains are declared at init **separately from stack_tags** — stack_tags mount knowledge; toolchains map **path globs → adapter**, so per-phase checks resolve which adapter applies from the files in scope. Each adapter also **declares its run commands** (test/build invocations; init bakes these into code-touching agents' Bash allowlists, Section 7.1) and its **test-path globs** (e.g. `tests/**`, `**/*.test.ts` — the single definition of "what is a test file," consumed by H4's read wall and H5's test freeze; neither hook is buildable without it). A declared toolchain with no registered adapter fails the consistency check (registry per Section 15).

### 9.2 TDD correctness rules

- **Adversarial, spec-only test-writer** (7.1/H4): success metric is *specifying behavior completely* — boundaries, error paths, the cases that break naive implementations — never "easy to pass". ACs are phrased as end-to-end observable behavior, so **at least one test per feature traverses the real entry point** (fails on un-wired code — the dynamic half of wiring verification).
- **Red check:** tests must fail *on their assertions* before implementation exists (a crash-red test proves nothing).
- **Mutation check** (after coder-green, scoped to the phase's diff — it cannot run earlier; there is nothing to mutate): mutate the new code; surviving mutants = the tests don't discriminate at that site. A strengthened test must **pass on the real implementation and fail on the mutant** — so strengthening has two outcomes: new tests all pass → implementation was fine, tests are now sharper (targeted re-mutation of prior survivors confirms the kills); any new test fails → a real bug the original suite certified green, coder re-enters the fix loop. **One round per phase** (config, default 1) — mutation rounds are the phase's most expensive loop and returns collapse after round one. The test-writer may mark a survivor `equivalent — unkillable` with justification (excluded from the blind-spot list — equivalent mutants otherwise pollute it). Survivors remaining after the round are never silently dropped: recorded in the handoff's `unresolved[]` and handed to every dispatched reviewer as priority inspection sites. **Post-fix code from the real-bug branch is deliberately not re-mutated** (the round is spent; the fix is covered by the discriminating test that drove it) — do not "fix" this into a second round. The bar is proven-hard before the loop is trusted (the loop optimizes toward whatever the tests permit).
- **Frozen tests during the loop** (H5): the fix loop can never weaken its own oracle; believed-wrong tests exit `tests-invalid`.
- **Suite membership = traceability:** promoted to the permanent suite only: AC-traced behavioral tests + bug-reproduction regression tests. Scaffolding/implementation-detail tests die with the run. A test that traces to nothing is a removal candidate.
- **Suite maintenance is event-bound:** AC changes during reconciliation update/retire exactly the traced tests; feature retirement (cleanup) retires its tests. Mutation score, not test count, is the quality metric — few discriminating tests beat many trivial ones.

---

## 10. MCP tool surface (coarse-but-typed, ~15 tools)

Lean by design: typed tools validated against the registered schemas (a malformed `knowledge_create` is rejected by zod against the type's schema — coarse tools are safe *because* schemas are exact). Hooks target operations inside coarse tools via tool-name + argument matching (`if` field where permission-rule syntax fits; in-hook `tool_input` inspection otherwise).

| tool | purpose |
|---|---|
| `knowledge_create(type, fields)` | create any record; schema-validated; runs noise-gate (anti_pattern) and **dedup-merge** (overlap → merge evidence into existing, never duplicate); fires H11 for notes |
| `knowledge_query(type?, filters, file_keys?, rank_terms?, include_unconfirmed?, cap)` | **the carefully-parameterized one**: structured named filters (no freeform query string; `rank_terms` is a zod-capped keyword array per 3.4, never prose); `derived_unconfirmed` records excluded unless `include_unconfirmed: true` (3.2.6); executes filter→join→rank→cap regardless of caller sloppiness; research returns with both clocks + staleness flag |
| `knowledge_get(id)` | fetch by id (selection resolution, link-following) |
| `knowledge_update(id, body)` | versioned types: new version + supersede prior. Reconciliation is a **process** (H7/H9 scripts) that *uses* this tool — not a tool itself |
| `knowledge_link(from, rel, to)` | typed graph edge |
| `board_add(text, source, file_keys?, ...)` | todo (user or system) |
| `board_query(filters)` | open items; `source` filter separates board from maintenance queue |
| `board_remove(id)` | bound to artifact-write (H9/H10) — the only way items leave |
| `run_signal(exit)` | **the brain**: computes the reaction; returns the next action (conductor-called) |
| `run_state(run_id?)` | current run record (conductor after compaction; TUI live tab reads the store directly) |
| `run_escalate(payload)` | surface a judgment branch / typed escalation |
| `maintenance_enqueue(reason, refs)` / `maintenance_query(filters)` | system queue ops |
| `handoff_write(record)` / `handoff_read(phase|files)` | **transient pair, separate from knowledge tools** — run-scoped state never enters the durable store |
| `agent_exit(signal)` | **the exit wire (never prose)**: zod-validated against the signal registry at the server, recorded on the run record; the brain reads it at the next `run_signal`. Invalid signal → rejected in-band (the agent self-corrects). Task return with no recorded exit → conductor reports `agent-died{empty_output}` |

## 11. TUI (Ink, separate process)

- **Three tabs, one pattern — every tab is a live view over a durable store:** TODOs (board store, `source: user`), Notes (notes), **Live-run** (the run record: phase N of M, last signal, active agent, warn flags, pending judgment) — the state dashboard complementing the terminal's live narrative; both reflect the same orchestrator-written run record, neither scrapes the other.
- **Cards:** arrow-key navigation + enter/space expand; mouse click *(ink-terminal evaluation)*; fields from record schemas.
- **Selected-id injection, generalized:** selecting *any* card (todo, note, run/phase) writes `{type, record_id}` as a **one-shot selection row in the store** (the TUI already writes the store; P4 bans a signal file); H2 consumes it transactionally and injects it into the next conductor message; the conductor resolves it via `knowledge_get`/`run_state` — so "what's the selected todo about" or "why did phase 4 escalate" just works. (Forge's `observer-selected.json` idea, minus the shared mutable file, pointing at record ids instead of denormalized blobs.)
- **Store access:** direct SQLite reads (WAL); TUI todo/note writes direct under WAL — **validated through the same zod schemas as the MCP server**, imported from a shared workspace package (one schema definition, two consumers; the registry stays single-source per P5). The session-bound stdio MCP server is not reachable from the TUI — do not attempt it.
- **Banner:** placeholder art in a swappable data slot, width-aware fallback, suppressible. Real art *(deferred)*.
- Sessions tab and all headless-worker liveness machinery (heartbeats, LOST detection, `--resume worker-*` relaunch): **do not build** — the observer finally observes the live run.
- **One TUI, one launcher** (Forge accreted two dashboards; Sterling ships exactly one). The TUI is **esbuild-bundled** — single file, zero runtime `node_modules` resolution: the standalone launch path has no SessionStart hook to heal the environment, so dependency self-repair machinery (Forge's preflight) must have nothing to repair. **Exits politely on non-TTY stdout.**
- **Launcher (init-generated):** init writes `sterling.bat` in the project root — Windows Terminal split: left pane Claude Code (the conductor session), right pane the TUI (`-V`, split ratio from config, default 0.35), `STERLING_SPLIT=1` set for layout awareness. Generated from `templates/launcher-win.bat` with **machine-detected paths** (node, claude, wt — PATH first, then known fallbacks incl. the WindowsApps Store alias for `wt.exe`). **Gitignored** (machine-specific paths), regenerable via `/sterling:launcher`. Non-Windows launchers: deferred register.

## 12. `/sterling:init` manifest (FULL PRECISION except store internals)

Creates, exactly: `.sterling/` (store per the storage choice — internals follow Claude Code's substrate selection — plus `runs/`), `docs/briefs/`, project **CLAUDE.md** generated from the shipped template `templates/target-claude-md.md` — **specified content, never improvised by init** (conductor contract + conduct rules + canonical-naming convention + pointers; durable conventions ONLY — transient state never enters it), stack-tag declaration (**ask, don't guess** — a mini-grill confirming `techStackLabels`, driving domain-store mounting), **toolchain declaration** (separate from stack tags: path globs → adapter mapping per Section 9.1; init warns once per absent optional capability), **backup path** (required, or explicit recorded opt-out — Section 2.3), **split launcher** (`sterling.bat` from the shipped template, machine-detected paths, gitignored — Section 11), **agent installation** (concrete agents generated from plugin templates into `.claude/agents/*.md`, each with a generated header: plugin version + template hash — Section 2.2; **project subagents load at session start, so init emits a loud restart/reload instruction and the first pipeline run is blocked until a runtime check confirms the installed agent set is visible**), `.mcp.json` wiring, hook registrations (project-level set from Section 6), gitignore entries, default config (caps N/M/dispatch/research; watcher 60/95; model+effort table; reviewer-selection rules; difficulty rubric thresholds — all tunable). Init also runs the dead-term check (no "brainstormer", no "wave", no "Forge" residue in scaffolded content). **No hand-maintained descriptive architecture file may ever exist** — the only permissible `architecture.md` is a generated read-only projection from the articles, clearly marked; checkable architectural rules are hooks; judgment-level principles are a lean convention section updated as a consequence of architecture-altering decision records.

**Cold start on an existing codebase (intended behavior, not a gap):** legacy code has no feature articles; retrieval over it returns nothing; reconcile lists start empty. Articles accrete as features are touched — the first run through an area creates its article; knowledge coverage grows along the working set, not the file tree. **Backfill is deliberately not automated** (an explorer crawl writing speculative articles would violate the no-speculation conventions and pollute the store) — a build agent must not invent one. If the user wants targeted backfill, it's a conductor-direct task per feature, human-reviewed like any capture.

## 13. Command surface

`/sterling:init` · `/sterling:feature` (force-pipeline override — conversation is the normal entry; the conductor selects the mode) · `/sterling:todo` · `/sterling:note` · `/sterling:debug` · `/sterling:cleanup` · `/sterling:dashboard` (TUI) · `/sterling:status` (inline run/board peek) · `/sterling:sync-agents` (refresh init-installed agents when plugin templates change — compares template hash in the generated header; **refuses to overwrite a locally modified generated agent and surfaces a three-way review instead**; without this, installed agents silently rot across plugin updates).

## 14. Context management

60% warn / 95% block (tunable), enforced by H6 externally — **never agent self-monitoring** (the degrading thing must not police its own degradation). Overflow responses are per-agent-shape: **coder/fixer** → phase too big → `phase-overflow` → re-decompose; **reviewer** → diff too big (re-decompose) or over-fed retrieval (tighten filtering — the signal payload says which); **classifiers** → should never approach it; if they do, it's a bug in what they're handed (prep is a script and has no context to overflow). Holistic work is never chunked — its *input* is shrunk. **Feature-sizing at intake** is the tier above phase-sizing: a feature that would overflow planning is split into features. No checkpoint/resume anywhere (P7): 95% work is rejected and re-scoped, not salvaged.

## 15. Architecture & extension document (a required deliverable alongside the code)

For each extensible set (signals, record types, agents, hooks, tools, toolchain adapters): the **registry** (single source of truth), the **checks** that guard it (and when they run), and an **"extending this"** section listing the coupled parts touching it obligates and the check that catches a miss. Sterling documents and extends itself by the same registry+checked-contract+fail-loud discipline it imposes (Section 6 checks). The design rationale behind this spec is captured as decision records during the build (P2 applied to Sterling itself).

## 16. Build order (probes → spine → full build)

### 16.0 Platform probes (Layer 0 — before any real code)

The verify-at-build register contains assumptions that are **existential** — if they fail, the enforcement model needs redesign, not a workaround. Retire them in hour one with **throwaway probe scripts** (deleted after; findings recorded in a `PROBES.md` committed once):

1. **Subagents can call MCP tools** (`handoff_write` / `agent_exit` depend on it) — **run this probe FIRST: the evidence is contested across versions/invocation paths.** Probe with a project-installed (NOT plugin-served) agent.
2. Frontmatter (per-agent) hooks **block** inside spawned subagents — confirm **exit 2** specifically (exit 1 is non-blocking) and the **`hookSpecificOutput.permissionDecision`** schema (PreToolUse does not use the top-level decision field other events use). Matchers are case-sensitive (`MultiEdit`, not `multiEdit`).
3. In-subagent hook input: `agent_id` present; `transcript_path` resolution; `message.usage` parseable from the transcript tail.
4. H14 Bash-allowlist hook blocks an off-list command inside a spawned coder-shaped agent.
5. Init-installed agents in `.claude/agents/` are visible after restart and carry working frontmatter hooks (plugin-served agents ignore hooks/mcpServers/permissionMode — already designed around, Section 2.2).

**Pre-recorded fallback if probe 1 fails (agreed, not improvised):** spawned agents write handoff and exit files under `runs/<id>/agent-outbox/` through ordinary Write. H3 permits exactly that run-scoped outbox path for protocol files. A PostToolUse command hook validates each written file against the same zod schemas and records validity on the run record. **The conductor consumes only valid outbox records.** Missing or invalid exit files map to `agent-died{empty_output|malformed_exit}` — malformed protocol files are never repaired or interpreted from prose. (Honest cost: validation is post-write, so an invalid file exists briefly — the failure mode changes; the architecture holds only because the conductor's consumption rule is as strict as the MCP path's.)

**A failed existential probe stops the build for a design conversation — never a silent workaround.** Non-existential register items remain at their owning step.

### 16.1 MVP spine (one vertical slice before breadth)

Prove the smallest complete Sterling loop end-to-end before building anything wide:

1. Plugin skeleton loads; init creates `.sterling/`, `.mcp.json`, gitignore entries, config, CLAUDE.md (from template), launcher.
2. Store (SQLite, WAL, FTS5) + shared zod schemas (POSIX path invariant live) for: `decision`, `feature_article`, `note`, `todo`, brief, run record, handoff.
3. MCP tools: `knowledge_create/query/get/update`, `board_add/query/remove`, `run_state`, `run_signal`, `agent_exit`, `handoff_write/read`.
4. Signal registry: `complete`, `blocked`, `agent-died` only — the registry + totality-check discipline makes later members safe to add.
5. Brain: CAS transitions from the first line; totality-tested over the spine enum.
6. Hooks: **H3 + H13 + H5 only** (H5 is nearly free — same path-glob machinery, adapter test-globs already in the slice — and without it the spine's TDD loop lets the coder edit tests). H6 runs in `observe` mode (record fills, never deny).
7. One toolchain adapter (node) — run + classify `pass | assertion_fail | crash`; no mutation capability.
8. One one-phase pipeline run end-to-end: brief → test-writer → red check → coder → green → completeness → capture → `dispose-run` (refusal paths tested) → merge gate.
9. **Every unimplemented full-spec check emits `check_skipped` where it would have run — never silent success.**

**Spine execution order (sliced — binding):**

- **Layer 0 — probes (16.0).** Scratch project, hand-placed throwaway agents — never Sterling's init machinery (the probes verify the assumptions that machinery depends on). Exit artifact: `PROBES.md` with explicit findings. **Slice 1 does not start until `PROBES.md` exists.**
- **Slice 1 — distribution foundation.** Packaging skeleton + agent-template install into `.claude/agents/` (version/hash headers) + restart instruction + runtime visibility check + `/sterling:sync-agents` stub (hash compare, refuse-on-local-modification; three-way review may stub to refuse-and-instruct). Proves the plugin-distributor/project-enforcement-surface shift on real mechanics before anything depends on it.
- **Slice 2 — data foundation.** `schemas` package (POSIX path invariant live) + `store` package (WAL, FTS5) + backup snapshot path.
- **Slice 3 — protocol core.** Minimal MCP server: knowledge CRUD, board tools, `run_state`/`run_signal`/`agent_exit`, handoff pair; brain with CAS transitions, totality-tested over the 3-signal spine enum.
- **Slice 4 — enforcement + adapter.** H3/H13/H5/H14, H6 in `observe` mode; node toolchain adapter with `pass | assertion_fail | crash` classification.
- **Slice 5 — the loop.** One-phase pipeline end-to-end: brief → prep (`knowledge_pack`) → test-writer → red → coder → green → completeness → capture → `dispose-run` (refusal paths tested) → merge gate. **Spine acceptance = this run completing with every unbuilt check emitting `check_skipped`.**

**A slice is done when its own tests pass and all prior slices' tests still pass. No slice starts before the previous one is done.**

Everything else — full signal enum, reviewer fan-out, mutation, remaining hooks, TUI, debug play, cleanup runs, domain stores, H6 `enforce` — comes after the spine works. **Self-hosting is permitted but never required:** once the spine survives its first real feature, remaining build steps *may* run as Sterling features.

### 16.2 Full build order (build-and-verify each layer before the next)

1. **Packaging skeleton** (2.2) + config defaults.
2. **Schemas + store + MCP server core** (3.1–3.2; zod validation; versioning/supersession/links; WAL). *Verify: storage choice against 3.1 criteria.*
3. **Tool surface + registries + consistency checks** (10, 6-checks, 15). Totality/spawn/linter/schema checks runnable from day one.
4. **Signal table + brain** (5) with full unit coverage over the enum (the totality test).
5. **Hooks** (6). ★ *Verify-at-build first:* current PreToolUse decision-field + exit-code semantics; **frontmatter (per-agent) hook blocking inside subagents**; whether parent-hook inheritance has shipped; in-subagent `transcript_path` resolution for H6 (agent's own transcript vs derived from `agent_id`) + presence of `message.usage` in assistant entries; statusline context fields.
6. **Agent definitions + SOP skills** (7) — prompt text drafted to pass the linter; per-agent hooks in frontmatter.
7. **Toolchain adapters** (9.1) — core interface + adapters for the project's declared toolchains; degrade paths (`check_skipped`) exercised. ★ *Verify: outcome classification (`pass | assertion_fail | crash`) against each real test framework before any check consumes it.*
8. **Pipeline mode** (8.1) incl. branch manager (run branch / per-phase commits / merge gate / discard paths) and both completeness checkers. ★ *Verify: native plan mode vs plan-mode-shaped (MCP writes inside plan mode; plan file as the brief).*
9. **Conductor-direct + debug + cleanup** (8.2–8.4) incl. H10 and reviewer-selection script.
10. **TUI** (11). ★ *Verify: ink-terminal vs ink+mouse-addon.*
11. **Init command** (12) + end-to-end dry run: init a scratch project → tiny conductor-direct task (capture fires) → one-phase pipeline run (gate→phase→completeness→capture→merge) → confirm board removal, article write, run-dir disposal, branch lifecycle.

**Standing verify-at-build register:** hook mechanics vs current docs (docs map URL, §0) · frontmatter-hook blocking semantics · subagent hook inheritance status · **subagent MCP tool access (handoff_write/agent_exit assume it)** · per-agent tool grants (`tools`/`disallowedTools`) syntax · plan-mode-literal vs -shaped · agent identity in hook input · statusline fields · ink-terminal evaluation.

## 17. Deferred / optional register (not designed-in; door open)

OpenAI cross-model slot (likely reviewer and/or test-writer; if-coder-then-reviewer-must-differ; decide on real output) · reviewer fan-out role-split (correctness/skeptic stay Opus, security/performance drop to Sonnet) **only if** run cost data shows reviewer input dominating run cost — a config edit, not a design change · non-Windows launchers (tmux/zellij split equivalents) · **usage-fed retrieval ranking** (the knowledge_pack makes staged-vs-dispositioned measurable later; no staged_count/cited_count/demotion logic and no ranking changes in v1 — revisit only on real run data) · statusline display · manual reconcile trigger · native `sub_agents[].context_usage` swap for H6 · banner art · Agent Teams for the review fan-out **only if** incident data shows isolated verdicts losing signal (costs: token multiplier, per-message billing, drift-babysitting) · agent-prompt regression evals **only if** prompt regressions bite after the linter floor is in place (event-triggered on prompt change, never scheduled).

---

*End of specification. Sterling: the seasoned guide who has walked this terrain before — because everything it learns, it keeps.*
