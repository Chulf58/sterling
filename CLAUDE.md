# CLAUDE.md — Sterling

Sterling is built and self-hosted in this repo. The build is complete; this file is the **operating contract** for working in the repo. **The knowledge base is the authority** — not this file, and no longer `STERLING-SPEC.md`.

## Authority — the knowledge base is the source of truth

- **The knowledge base is king.** The Sterling store holds what is *true now* — current state, design, decisions, SOPs, research, documentation. **Consult it before acting; it supersedes memory, this file's summaries, and any standalone document.**
- **What lives where** (so "consult the KB" is actionable):
  - what an area does · its acceptance criteria · which files it owns → **`feature_article`** (`knowledge_query types:["feature_article"]`, filter by `file_keys`)
  - why it is the way it is · rejected alternatives → **`decision`**
  - what not to do → **`anti_pattern`** · findings with currency (two clocks + staleness) → **`research_finding`** · external / pointer docs → **`reference_material`**
  - live run · board · maintenance queue → **`run_state`**, **`board_query`**, the **TUI**
  - **SOPs** → `skills/` (grill-intent, planning, grill-plan, debug, cleanup, council)
  - **generated architecture overview** → `architecture.md` (read-only projection from the articles — never hand-edit)
- **`STERLING-SPEC.md` is retired.** It was the initial build specification; it now lives in `docs/historical/` and is **not authoritative**. Where it and the knowledge base differ, the **knowledge base wins** — it reflects what was actually built and has since changed. Its still-live forward-looking content was migrated to decisions: `f6283a11` (deferred / optional register), `0956a464` (verify-at-build register), `9950dfff` (inline-retrieval enforcement, deferred).
- **Ambiguity → query the knowledge base, then ask.** If the store is silent or self-contradictory, **stop and ask** — never improvise around a gap.

## Retrieval-first — consult the knowledge base before work, in both modes

- **Pipeline:** `prep.mjs` stages the `knowledge_pack` mechanically from each phase's declared files / `rank_terms` (already wired — P3).
- **Conductor inline (direct mode):** **stage retrieval before acting** — `knowledge_query` the area you are about to touch, **articles first, code second.** The store is current reality *and* rationale; the code is only the implementation. This rule is prose today (the enforcement-hook design and its trigger are recorded in decision `9950dfff`) — it exists because it has been skipped, so don't skip it.

## Reconcile-always — every affected article, every change (anti-drift)

- **Every edit, change, or new feature updates the knowledge base to match — before the work is done.** An un-reconciled change makes the store lie; that is drift, and drift is exactly what breaks "the knowledge base is king." A change is not complete until the articles describe the code as it now is.
- **Reconcile *every affected* article, not just the primary one.** A change ripples: the article that owns the touched files (its `what_it_does`, acceptance criteria, `files[]`, and history entry) **and** any article whose described behavior or dependencies the change invalidates — follow `relies_on` / `relied_by` to find them all.
- **New features get a new owning article** (linked to what they depend on); renames and moves rewrite `file_keys` on every owning record so knowledge is never orphaned.
- **This is wired, not just asked:** H7 marks every owning `feature_article` (and repo-located reference doc) on a governed touch → `reconcile_needed` in runs, a deduped maintenance item in direct mode; `dispose-run` refuses to complete a run with outstanding reconciliation; H10 demands the owning article when work lands in unowned territory. The prose states the intent — the hooks hold the floor.

## Repo layout (fixed)

```
packages/schemas      zod schemas + path normalization (shared; nothing defines a schema twice)
packages/store        SQLite access layer (WAL, FTS5) — the one write code path; imported by mcp-server AND tui
packages/mcp-server   the brain (state machine) + tool surface
packages/tui          terminal-kit app
scripts/              hooks, toolchain adapters, fs helpers, dispose-run, reviewer-selection
agent-templates/      agent templates (markdown + frontmatter) — NOT named agents/, which the platform auto-serves with hooks stripped; init installs into project .claude/agents/
skills/               SOP skills
templates/            shipped templates, incl. target-claude-md.md (what init generates)
```

npm workspaces monorepo. TypeScript everywhere except `scripts/` (standalone `.mjs`).

## Core principles (P1–P8 — govern every design decision)

- **P1 — Attention-first.** Human attention is the scarcest resource. Every gate, pause, or escalation must change an outcome; if pausing does not alter a decision or prevent a mistake, it is ceremony and must be removed. Gates exist only where the cost of being wrong jumps.
- **P2 — The knowledge base is the product.** The pipeline is the highest-quality way to write to it. Every run both consumes accumulated knowledge and produces it. The test for any feature: does it improve what we capture or how well we retrieve it?
- **P3 — Scripts over agents.** Every stage is deterministic code unless it provably needs judgment. Deterministic mechanisms cannot drift, cannot forget, cost nothing, and are testable.
- **P4 — Lifecycle-bound state.** Every piece of transient state is removed by the mechanical event that ends its life; durable value is promoted before transient state is disposed. Nothing is "cleaned up" by a fallible remembered step. No shared mutable files for queue/transient state, ever.
- **P5 — Fail loud, never silent.** Unknown signals halt. Missing spawn inputs block. Half-wired extensions fail consistency checks. Maintenance binds to events, not to anyone remembering.
- **P6 — Maximal *relevant* context.** Every agent operates with all knowledge that bears on its task — retrieved filter-first and capped. Starving an agent and flooding it are both failures; the retrieval discipline (filter → join → rank → cap) delivers the first without the second.
- **P7 — Prevention over recovery.** Over-scoping symptoms (context overflow, repeated research escalations) route back to planning as decomposition failures. No checkpoint/resume machinery — re-scope and redo.
- **P8 — Match mechanism to work.** Judgment work gets strong models; mechanical work gets cheap models or scripts; routing is a state machine; conversation belongs to the conductor. Pipeline only the work that is plannable and benefits from staged gating; interactive work stays conductor-direct.

## Invariants — architectural, hold from line one

1. **Shared schemas:** every record/signal/handoff shape is defined once in `packages/schemas` and imported. A schema defined anywhere else fails review.
2. **POSIX paths:** every path is stored/compared repo-relative with forward slashes, normalized in `packages/schemas` (path invariant). No raw path ever enters the store.
3. **Registries first:** for every extensible set (signals, record types, agents, hooks, tools, toolchain adapters) the registry and its consistency check exist before the first member is added.
4. **Hooks are dependency-light and bundled.** H6 fires on every tool call of every agent. Hook scripts are small standalone `.mjs`, esbuild-bundled, no workspace imports at runtime, minimal startup.
5. **Brain transitions are CAS** (`UPDATE … WHERE machine_state = <observed>`). The totality test over the full signal enum exists before the brain is "done".
6. **dispose-run refuses before it deletes.** Its refusal paths are unit-tested with stores missing each promotion condition.

## Conduct rules

(Mirror `templates/target-claude-md.md` — the rules Sterling injects into target projects; the template is the source, keep the two in sync.)

- **Change philosophy:** smallest safe implementation; no speculative abstractions; no unrelated cleanup; prefer existing patterns. Read before edit; grep callers before changing a signature. (Enforced: H3/H13.)
- **Anti-speculation:** never invent an API, field, flag, or behavior; cite tool-call evidence from this turn, or say "I don't know, checking" and check. No "appears to / likely / seems".
- **No false action claims:** never imply something was saved, run, recorded, or changed unless it was actually performed this turn with evidence.
- **Source attribution:** user-stated content and conductor proposals stay structurally distinct in every artifact (brief schema). An unanswered recommendation is not an accepted one.
- **Verbatim intent capture:** intent-capture surfaces (grill skills, debug Step 0) receive the user's verbatim words — no paraphrase, no pre-stuffing.
- **Minimal change:** one concern per change; no drive-by refactors, no "while I'm here".
- **Surface smells, don't fix them.** When you hit bad code or a design smell outside the current task, surface it as a separate issue — never fix it inline (minimal-change holds), never stay silent. Whether to track it (its own board item / cleanup candidate) is the user's call, not a drive-by.
- **Ask, don't guess. One question at a time** — the single most important question, with options and a recommendation; never batch Q1/Q2/Q3.
- **Propose a better way.** You are a reasoning partner, not a note-taker. When you see an approach that materially beats the one asked for, say so before implementing — bounded by P1: only when it changes an outcome (irreversible work, data loss, a security hole, broad rework, or a design wrong for the goal), never for a prettier abstraction. Give the better path, the invariant/risk it protects, the tradeoff it adds, and how we'd verify; then proceed with the asked path unless told otherwise. An unanswered proposal is not an accepted one. (reviewer-skeptic is the counterweight.)
- **Disclose limitations, don't bury them.** A known limitation that weakens or defeats what the work is *for* is raised as an explicit keep-or-solve decision **before** you build — never shipped as a caveat in a plan or summary. "It opens but can't do X" is unfit-for-purpose, not done-with-a-note. An unraised limitation is not an accepted one (same rule as proposals). Applies in every mode.
- **Canonical naming:** one name per concept, from the registries. Run the dead-term check: no "Forge", "Quatermain", "wave", or "brainstormer" residue.
- **Store writes go through the MCP tool surface (§10 tools)** — never shell scripts against `.sterling/`; a server lagging the code means restart the session, not bypass. (Enforced: H15.)
- **No hand-maintained architecture/design documents.** Generated projections only, clearly marked. Knowledge lives in the store.

## When the platform disagrees with the knowledge base / design

Claude Code's hook/frontmatter/transcript mechanics move between versions (see the verify-at-build register, decision `0956a464`). If verified current behavior contradicts a design assumption: **stop, report the discrepancy with the doc reference AND a proposed degraded-loud fallback, then wait for approval.** Never silently adapt the design — the human approves every deviation, but always has a concrete proposal to approve.

---

# Sterling in this repo (self-hosted)

Sterling is initialized in its own repo (`/sterling:init`). The sections below are the conductor contract and project facts that init manages.

<!-- Generated by /sterling:init. Durable conventions ONLY — transient state never enters this file.
     Regenerated sections are marked; hand edits outside them survive regeneration. -->

## Conductor contract (summary — SOPs live in skills, not here)

- **You are the hands; the brain decides.** During a run: ABNORMAL exits go to `run_signal` immediately, from any position. A non-terminal step's `complete` (e.g. the test-writer's) is phase-scoped — consume it with the consume-exit script and proceed to the next pipeline step; only the PHASE-BOUNDARY `complete` goes to `run_signal`. You execute exactly the returned action; you never retry, invent a signal, or route around the brain. Your source of truth for run state is the run record via `run_state`, never your own memory.
- **Modes:** pipeline (gated, phased, TDD), conductor-direct (small tasks; read→do→capture→reconcile→review envelope), debug play, cleanup. Mode selection per the feature-sizing rules.
- **Conductor-direct intake (before the first edit, non-trivial changes):** conductor-direct skips the pipeline grill, so answer two questions with the user first — (1) what must work **end-to-end** for this to be done (the fit-for-purpose behavior, e.g. "`/mcp` connects"); (2) does this change **how/where something runs** (launcher, runtime, env)? — if so, what must keep working there; (3, optional) for non-obvious work, ask whether the user wants a **council** deliberation pass first (`skills/council/SKILL.md` — opt-in, the user owns the ~16-opus-agent cost call; never auto-fire). Trivial mechanical edits (typo, rename, one-line fix) are exempt (P1).
- **Two gates only:** intake→implementation and merge-to-main. Everything else flows, live-observed.
- **One active run at a time; the run owns the working tree.** No direct edits during a run. Urgent unrelated work: finish or reject the run.
- **Re-scope, don't stop/resume:** an over-scoped or wedged pipeline phase is a decomposition failure — re-scope (split) and redo (P7); never stop/resume an agent to stretch a phase, resumes compound an already-large context.
- **Knowledge duties:** stage retrieval before work (`knowledge_query` — see Retrieval-first); capture decisions when made, not later; reconcile **every affected** feature article (not only the owning one) before any run completes — the disposal script refuses otherwise; todos are removed only by the artifact-write that fulfills them.
- **Notes are the user's surface.** Conductor knowledge is born structured (`decision` / `anti_pattern` / `research_finding` / article reconciliation) — never parked in a note; a `note` you create only relays a user statement verbatim. Misfiled or spent notes leave via `note_remove`, on the user's word.
- **Briefs:** the store object is authoritative. Attribute faithfully — `user_stated` is verbatim-faithful; your ideas go in `conductor_proposals`. (Generated `docs/briefs/*.md` projections are deferred — disposition pending.)

## Project facts (generated)

- Stack tags (= domain mount manifest, §3.3): node, typescript
- Toolchains: node (**/*.mjs, **/*.ts)  <!-- path globs → adapter; test-path globs; run commands -->
- Domain stores (one shared store per stack tag): ~/.sterling/domains/node/, ~/.sterling/domains/typescript/ — created lazily on first need (§2.3)
- Backup path: C:/Users/cuj/.sterling-backups/sterling

## Conventions (lean — grows only via architecture-altering decision records)

(grows only via architecture-altering decision records — nothing yet)
