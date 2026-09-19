# CLAUDE.md — Sterling

Durable conventions and repo facts. The **knowledge base is the authority**, not this file. The conductor's working posture is not here: H1 injects it once per session from `docs/conductor-contract.md`. Each rule lives in exactly one of the two.

Scope (decision `sterling-claude-code-scale-down-boundary`, user-ruled 2026-09-19, verbatim: *"All the rules and locks is friction, so I want to scale it down ALOT!"*): Sterling on Claude Code is the **knowledge loop plus the task board**. No staged pipeline, no frozen-test wall, no read wall, no shell allowlist, no review ledger, no merge gate, no config key allowlist. Do not reintroduce one because a single incident argues for it.

## Core principles (P1-P8, cited by number)

- **P1 — Attention-first.** Human attention is the scarcest resource; a gate, pause or escalation that does not change an outcome is ceremony and must be removed.
- **P2 — The knowledge base is the product.** Every unit of work consumes accumulated knowledge and produces it. The test for a feature: does it improve what we capture, or how well we retrieve it?
- **P3 — Scripts over agents.** Deterministic code unless the work provably needs judgment; code cannot drift or forget.
- **P4 — Lifecycle-bound state.** Transient state is removed by the event that ends its life; durable value is promoted before disposal, never by a remembered step.
- **P5 — Fail loud, never silent.** Unknown signals halt. Missing inputs block. A degraded path announces that it is degraded.
- **P6 — Maximal *relevant* context.** Every agent operates with all knowledge bearing on its task, retrieved filter-first and capped; starving and flooding are both failures.
- **P7 — Prevention over recovery.** Over-scoping is a decomposition failure: re-scope and redo rather than build resume machinery.
- **P8 — Match mechanism to work.** Judgment gets strong models; mechanical work gets cheap models or scripts; conversation belongs to the conductor.

## Authority (the knowledge base is the source of truth)

- **The store holds what is *true now***. Consult it before acting; it supersedes memory, this file's summaries and any standalone document.
- **What lives where:** what an area does, its acceptance criteria, which files it owns → **`feature_article`** (filter by `file_keys`). Why it is that way, rejected alternatives → **`decision`**. What not to do → **`anti_pattern`**. Findings with currency → **`research_finding`** — one that measured only PART of its subject states the population and its exclusions in `answer`, because an unstated gap reads as "measured the whole question". External docs → **`reference_material`**. Board and queue → `board_query`, the TUI. SOPs → `skills/`. Architecture → `architecture.md` (generated; never hand-edit).
- **Ambiguity → query the store, then ask.** If it is silent or self-contradictory, stop and ask — never improvise around a gap.
- **A query result is a WINDOW, not an inventory.** `capped: true` means more matched — raise `cap` or narrow the filter; never infer absence from a capped result. `knowledge_get` is the full-fidelity read. `projection:"digest"` buys a cheap wide landscape; `min_score` answers the absence question a capped window cannot.
- **`knowledge_preflight(text)` is the pre-write conflict check.** It takes no `file_keys` — it answers for a SUBJECT. Run it before drafting a record, before a design settles and before putting a question to the user; a `verify_targets` verdict names the governing records to open BEFORE you proceed.
- **Stage retrieval before work.** Query the area you are about to touch, **articles first, code second** — the store is current reality *and* rationale; the code is only the implementation. Delivery surfaces an owning article when you touch its files, but cannot cover unowned territory nor tell you where to look. The duty stays yours.

## Reconcile-always (every affected article, every change)

- **Every change updates the knowledge base to match, before the work is done.** An un-reconciled change makes the store lie; that is drift, and drift is what breaks the store's authority.
- **Reconcile *every affected* article** — the one owning the touched files (`what_it_does`, acceptance criteria, `files[]`, a history entry) **and** any article whose described behavior or dependencies the change invalidates; follow `relies_on` / `relied_by`.
- **The articles you forget own files YOU edited by hand.** Dispatched work arrives with a report naming its files; your own edits produce none. Before the reconcile batch, `git diff --name-only` against the last settled commit and ask which paths no agent report mentioned — that set is your hand-edits.
- **New features get a new owning article**; a recurring domain concept gets a **concept article** — one `feature_article` per concept FAMILY, marked `concept_family`: what the concept IS plus its members, its INTENT and INTERACTIONS cross-referenced by sibling slug, its owning files. Create it the moment a design settles. Renames rewrite `file_keys` on every owning record, so knowledge is never orphaned.
- **Which field carries paths is PER TYPE:** `feature_article` → `files[{path, role}]`; `decision`/`anti_pattern`/`research_finding`/`todo` → `file_keys[]`; `reference_material` → `location`. A field the type does not define is refused, never silently dropped.
- **Fix a wrong record FORWARD** with `knowledge_update` — the correction supersedes the error. **Retirement is narrow:** `knowledge_retire(id, in_favor_of)` is for a genuine DUPLICATE, never for a record that is merely wrong, and never by creating a replacement beside the original. **Ask the schema, don't guess it** (`knowledge_schema`), and take the refusal as the authority over the projection. An 8-char prefix resolves when reading and updating; every destroying path demands the full id.
- **When an article QUOTES a ruling, the quote carries its justification clause.** A ruling stripped of its *why* reproduces the gap it was written to close.

## Repo layout (fixed)

```
packages/schemas      zod schemas + path normalization (shared; nothing defines a schema twice)
packages/store        SQLite access layer (WAL, FTS5) — the one write code path
packages/mcp-server   tool surface
packages/tui          terminal-kit app
scripts/              hooks, toolchain adapters, fs helpers
agent-templates/      agent templates — NOT named agents/, which the platform auto-serves with hooks stripped
skills/               SOP skills
templates/            shipped templates, incl. target-claude-md.md (what init generates)
```

npm workspaces monorepo; TypeScript everywhere except `scripts/` (standalone `.mjs`).

## Invariants (architectural, hold from line one)

1. **Shared schemas:** every record/signal/handoff shape is defined once in `packages/schemas` and imported. A schema defined anywhere else fails review.
2. **POSIX paths:** every path is stored and compared repo-relative with forward slashes, normalized in `packages/schemas`. No raw path enters the store.
3. **Registries first:** for every extensible set (record types, agents, hooks, tools, toolchain adapters) the registry and its consistency check exist before the first member.
4. **Hooks are dependency-light and bundled:** small standalone `.mjs`, esbuild-bundled, no workspace imports at runtime. Every hook resolves `.sterling/` through `readStdin`'s project-root normalization, never the raw shell cwd.
5. **The store DB is sealed:** nothing but the MCP server writes `.sterling/sterling.db` (H15's one rule) — a data-integrity boundary, not a conductor lock. Every other file under `.sterling/`, `config.json` included, is editable by any tool, and `config_set` has no key allowlist (user-stated 2026-09-19: *"You need to fix that you can change the config yourself."*).

## Conduct rules

- **Minimal change:** smallest safe implementation; one concern per change; no speculative abstractions, no drive-by refactors; prefer existing patterns. Read before edit; grep callers before changing a signature. **Does not override** consolidating a mechanism you are ALREADY modifying — on a third-or-later change to it, consolidating is the smallest total change, and boarding it is the drive-by.
- **Rebuild over patch.** A fix growing out of proportion to its defect stops and rebuilds from blank: *is the fix removing the cause, or adding handlers for its effects?* Freeze the pins (existing plus the new findings — their union is the spec), state the invariant in one paragraph including what it does NOT guarantee, rebuild against those pins, read the old file only afterwards to check nothing was dropped. **Does not override** minimal-change for a first defect.
- **A new incident may add a regression test or a policy record. It may NOT add a new enforcement program** (hook, gate, scanner) — the stable unit of growth is policy data. The presumption for a mechanism is REMOVE unless it has a measured catch no record or test can replace; the burden of proof is on keeping. **Does not override** P5 for a destructive action.
- **Anti-speculation:** never invent an API, field, flag or behavior; cite tool-call evidence from this turn, or say "I don't know, checking" and check. No "appears to / likely / seems". **No false action claims:** never imply something was saved, run or changed unless it was performed this turn, with evidence.
- **An index or summary is a lookup, never a source.** A digest line or a quotation inside another record LOCATES the source; it never replaces it. A cited `file:line` is an instruction to open the file — the binding constraint often lives in the prose around that line. Never present a question a decision already settles as open: whichever option the user picks becomes a false ruling.
- **Cite rulings by SLUG in durable pointers** (commit messages, briefs, article prose): a slug names the concept and survives supersession; ids version-pin. Where space allows print both — `[slug] (knowledge_get <id>)`. Bare ids stay correct on mechanically-resolved surfaces and in history entries pinned to what was live then. **Never put a bare id in front of a HUMAN** — an identifier shown to a person carries its name beside it, `name (id8)`, name first: names clip, ids never do. Asked to rule on "board 17204d1e" the reader cannot know what they are ruling on, and an unanswerable question still manufactures a ruling.
- **Source attribution:** user-stated content and conductor proposals stay structurally distinct in every artifact; an unanswered recommendation is not an accepted one. Intent capture is **verbatim** — a paraphrase substitutes your model of the intent for theirs, and every artifact downstream inherits your version.
- **Ask, don't guess — one question at a time, through the AskUserQuestion tool**, with options and a recommendation; never batch. A prose question reads as rhetorical and gets missed (user-stated 2026-08-11) — not asked. Run `knowledge_preflight` on the subject first (see Authority). Safe-default-and-proceed only for a reversible choice needing no authorization, never for a gate.
- **Surface smells, don't fix them** — an out-of-scope issue is reported as a separate item, never fixed inline and never left unsaid; tracking it is the user's call. **Solve, don't board** inside the current task's scope: fix it in-session, board only what cannot be done now and say why (user-stated 2026-07-27). Neither gets silently parked.
- **Close-on-commit:** a commit that fulfils a board item pays it — `board_remove` in the same breath, citing the commit. **A board item states its EVIDENCE, not its conclusion:** quote the deciding `file:line` or the measured number; "the facing is broken" cannot be re-checked and rots invisibly. Re-verify an item against HEAD before dispatching at it — refreshing its BLOCKER is not re-checking its DEFECT. A partly-done item is rewritten, never removed.
- **Disclose limitations, don't bury them.** A known limitation that weakens what the work is *for* is raised as a keep-or-solve decision **before** you build. "It opens but can't do X" is unfit-for-purpose, not done-with-a-note.
- **Propose a better way** when an approach materially beats the one asked for — bounded by P1: only when it changes an outcome (irreversible work, data loss, a security hole, broad rework), never for a prettier abstraction. Give the path, the risk it protects and the tradeoff, then proceed as asked unless told otherwise.
- **Canonical naming:** one name per concept, from the registries; no dead terms ("Forge", "wave").
- **No hand-maintained architecture or design documents.** Generated projections only, clearly marked: a document duplicating the store drifts from it, and the copy is always the one that lies.
- **When the platform disagrees with the design** — Claude Code's hook and frontmatter mechanics move between versions — stop, report the discrepancy with its doc reference and a proposed degraded-loud fallback, and wait for approval. Never silently adapt.
- **Mechanism inventories do not live in THIS file — the store is the census.** Never copy in what a self-describing surface answers: record shapes (`knowledge_schema`), the hook roster (`hooks.json`), the anti-pattern set (`knowledge_query`). A summary of the store is a second copy that rots. This file carries durable conventions and their justifying incidents; repo layout and invariants are the deliberate exceptions.

- **Never ship:** hardcoded secrets or credentials; swallowed errors, bare catch-alls or silent fallbacks that mask a real failure; weakened, skipped or deleted tests to make a suite green; leftover debug output or commented-out code unless a stub was asked for.

## Sterling in this repo (self-hosted)

- **Stack tags** (= domain mount manifest): node, typescript, sterling. **Toolchains:** node (`**/*.mjs`, `**/*.ts`). **Domain stores:** `~/.sterling/domains/{node,typescript,sterling}/`, created lazily. **Backup path:** `.sterling/config.json` → `backup_path` (machine-local, not restated here).
- **Local only.** SQLite in `.sterling/sterling.db`; no cloud database (user-stated 2026-09-19: *"There is no more other engineers, from now on it is just us, so we dont need the cloud data base at all, everything can run locally"*).
- **WSL2 everywhere.** Claude Code, this clone, Codex and every project run under WSL2 (Ubuntu-24.04); the Windows `.bat` launchers open the project inside WSL2 (user-stated 2026-09-19: *"everything going forward should run through WSL2. change the bat files so they open the project in WSL2 instead of windows"*).
- **This machine authors; every other machine consumes.** Sterling ships as a git clone — no npm package, no marketplace entry. Work lands here, merges to `main`, and reaches other machines via `/sterling:update` (fast-forward-or-refuse). Within a machine there is no fan-out: every project launches with `--plugin-dir` at this one clone, so updating it moves the hook surface for all siblings at their next session start; only per-project copies need syncing (`sync-agents`, `stamp-contract`). Machine-local truth is H1's MACHINE ROLE line (`machine_role` in `.sterling/config.json`) — on a CONSUMER or UNDECLARED clone the authoring language does not apply.
