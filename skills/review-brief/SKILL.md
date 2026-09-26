---
name: review-brief
description: Use before dispatching a review of a finished diff — the brief template and rubric for a review sent to Codex Sol or Claude Opus. Triggers on "review this before I commit", "get a review", "second opinion on this diff". There is no standing reviewer agent — a review is a brief sent to the OTHER model family from whichever executed the work.
---

# Review brief

When a review happens, who reviews whose work, and the loop cap are in the conductor prompt (`agent-templates/conductor.md`, installed in each project as `.claude/agents/conductor.md`), section "Review sparsely, and only before a commit": one review before a commit, over the riskiest part of the diff; Codex **Sol** (`gpt-5.6-sol`) for Claude-executed work and Claude **Opus** for Terra-executed work; in a WORK-mode project, Sol reviews before the PR and takes precedence over the Terra→Opus pairing; one review, one fix round, one re-check by the same warm reviewer. There is no standing `reviewer` agent template; a review is a **brief** the conductor sends to a model, structured by this skill.

Dispatch a Sol review through the `codex` MCP tool at `sandbox: read-only` — the call-site shape is in `CLAUDE.md`, "Codex runs through the MCP tool, never the shell". Riskiest means runtime/product code, config, permissions, credentials, lifecycle, migrations, generated catalogs, third-party patches; docs, probe scripts and generated projections go unreviewed.

## The brief

```text
Objective:       What this change is FOR — the outcome, one sentence.
Diff:             The actual diff or the file paths + `git diff` command to run.
Acceptance:       The frozen acceptance criteria this change must meet, verbatim
                  — never paraphrased or loosened for the review.
Project rules:    Pointers to the governing AGENTS.md/CLAUDE.md conduct rules or decision
                  records this diff must not violate (cite by slug).
Context:          What the reviewer cannot infer — prior findings, why this
                  shape was chosen over an alternative, what's explicitly out
                  of scope for this pass.
Changed tests:    Every test file the diff touched or removed assertions from —
                  named explicitly, not left for the reviewer to discover.
```

## Review order — ACs first, then project rules, then correctness

1. **Acceptance criteria** — does the diff actually satisfy what was asked, verbatim? A criterion silently loosened or reinterpreted is a finding on its own, independent of code quality.
2. **Project rules** — AGENTS.md/CLAUDE.md conduct rules, cited decisions and anti-patterns, existing conventions. A diff that is locally correct but violates a governing rule (e.g., a hand-rolled schema duplicating `packages/schemas`) is still a defect.
3. **General correctness** — logic, state, error handling, security, performance where the diff touches a hot path.

## The non-negotiable: inspect every changed test in full

**Every changed test file, fixture, and removed assertion gets read in full** — not sampled, not skimmed for the diff hunk alone. A weakened test is what a risk-ranked sweep most easily misses, and it is the single most damaging thing a review can let through: a test that now passes for the wrong reason, or an assertion quietly dropped to make a suite green, reads identically to a healthy diff from the hunk alone. If the diff removed or loosened an assertion, the reviewer states explicitly why that was acceptable or flags it — silence is not a pass.

## Severity

- `CRITICAL` — data loss, security exposure, a stated acceptance criterion not met, a committed secret, destructive behavior.
- `HIGH` — likely runtime bug, missing validation at a trust boundary, broken error propagation, a violated architectural invariant, a weakened/hollow test.
- `MEDIUM` — realistic edge case, maintainability risk, departure from an established project pattern.
- `LOW` — naming, docs, optional cleanup. Never blocking.

## Output contract the reviewer returns

```text
[SEVERITY] path:line
Issue: what is wrong
Impact: why it matters
Fix: concrete repair direction
```

Close with:

```text
Verdict: APPROVE | REQUEST_CHANGES | COMMENT
Verification: commands run -> results, or "not run" + reason
Residual risk: what could not be checked
```

`APPROVE` requires zero `CRITICAL`, zero `HIGH`, and every acceptance criterion met. Any `CRITICAL` or `HIGH` is `REQUEST_CHANGES`. If the reviewer could not cover enough of the change to be confident, that is `COMMENT` — never `APPROVE`.

## Reading the result back

A review claim needs a substantive response on the **final** diff — a review consult that only saw an earlier slice does not discharge the duty for what actually landed. Treat the reviewer's findings as evidence, not a verdict: the conductor adjudicates, fixes what's real, and records disagreement rather than silently overriding it. A disagreement over a correctness finding is settled on evidence — reproduce it, run the test, read the cited line — not by authority. The "conductor's solution stands" default in the conductor prompt ("Astra is the solution-sparring partner") covers Astra design consults only; it does not dismiss a review finding.
