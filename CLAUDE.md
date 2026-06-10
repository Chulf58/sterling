# CLAUDE.md — Building Sterling

You are building Sterling from `STERLING-SPEC.md` (repo root). This file governs the build itself.

## Authority

- **The spec is law.** Where this file and the spec conflict, the spec wins.
- **Ambiguity → stop and ask.** Never improvise around a spec gap, never "interpret" a missing detail. The spec was reviewed to be precise; a gap is a defect to raise, not a license.
- Read **§0** (how to read the spec) and **§16** (build order) before writing any code. §16 is three stages: **16.0 platform probes** (hour one, throwaway, existential assumptions), **16.1 MVP spine** (executed in the binding slice order: Layer 0 probes → distribution foundation → data foundation → protocol core → enforcement + adapter → the loop), **16.2 full build**. **Slice 1 does not start until `PROBES.md` exists with explicit findings.** A failed existential probe stops the build for a design conversation.

## Build order

- §16 is **binding and sequential**. Do not skip ahead, do not build later steps "while you're in there".
- Every ★ verify-at-build item in a step is checked against **current Claude Code documentation** (docs map URL in §0) *before* implementing that step. Record what you verified and what you found in the step's commit message.
- Do not build anything in the §17 deferred register. It is deferred on purpose.
- Definition of done per step: implementation + its tests + all consistency checks pass. A step without its tests is not done.
- **Session resume:** at the start of every session, check `git log` — commit messages record completed steps and their verify findings. Continue from the first incomplete §16 step; never re-do or re-verify completed steps unless a discrepancy is found.

## Repo layout (fixed)

```
packages/schemas      zod schemas + path normalization (shared; nothing defines a schema twice)
packages/store        SQLite access layer (WAL, FTS5) — the one write code path; imported by mcp-server AND tui
packages/mcp-server   the brain (state machine) + tool surface
packages/tui          Ink app
scripts/              hooks, toolchain adapters, fs helpers, dispose-run, reviewer-selection
agent-templates/      agent templates (markdown + frontmatter) — NOT named agents/, which the platform auto-serves with hooks stripped; init installs into project .claude/agents/
skills/               SOP skills
templates/            shipped templates, incl. target-claude-md.md (what init generates)
```

npm workspaces monorepo. TypeScript everywhere except `scripts/` (standalone `.mjs`).

## Invariants — hold from line one, not retrofitted

1. **Shared schemas:** every record/signal/handoff shape is defined once in `packages/schemas` and imported. A schema defined anywhere else fails review.
2. **POSIX paths:** every path is stored/compared repo-relative with forward slashes, normalized in `packages/schemas` (§3.2 path invariant). No raw path ever enters the store.
3. **Registries first:** for every extensible set (signals, record types, agents, hooks, tools, toolchain adapters) the registry and its consistency check exist before the first member is added (§15).
4. **Hooks are dependency-light and bundled.** H6 fires on every tool call of every agent. Hook scripts are small standalone `.mjs`, esbuild-bundled, no workspace imports at runtime, minimal startup.
5. **Brain transitions are CAS** (`UPDATE … WHERE machine_state = <observed>`) from the first implementation (§5.2). The totality test over the full signal enum exists before the brain is "done".
6. **dispose-run refuses before it deletes.** Its refusal paths are unit-tested with stores missing each promotion condition (§ H9).

## Conduct rules

(These are the same rules Sterling injects into target projects — `templates/target-claude-md.md`. Keep the two in sync; the template is the source.)

- **Anti-speculation:** never invent an API, field, flag, or behavior. Verify in docs or code first. If you cannot verify, say so and ask.
- **No false action claims:** never report something as done, run, or passing that was not actually done, run, or passing.
- **Read before edit; grep callers before changing a signature.**
- **Minimal change:** no drive-by refactors, no "while I'm here" improvements. One concern per change.
- **Ask, don't guess.** One question at a time.
- **Canonical naming:** one name per concept, taken from the spec and registries. Run the dead-term check: no "Forge", "Quatermain", "wave", or "brainstormer" residue in any scaffolded or generated content.
- **No hand-maintained architecture documents.** Generated projections only, clearly marked.

## When the platform disagrees with the spec

Claude Code's hook/frontmatter/transcript mechanics move between versions. If verified current behavior contradicts a spec assumption: **stop, report the discrepancy with the doc reference AND a proposed degraded-loud fallback, then wait for approval.** Never silently adapt the design — the human approves every deviation, but always has a concrete proposal to approve.
