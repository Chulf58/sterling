---
name: review-brief
description: Use before dispatching a review of a finished diff — the brief template and rubric for a review sent to Codex Sol or Claude Opus. Triggers on "review this before I commit", "get a review", "second opinion on this diff". There is no standing reviewer agent — a review is a brief sent to the OTHER model family from whichever executed the work.
---

# Review brief

Sterling reviews **sparsely, and only before a commit** (user ruling, 2026-09-18: "we dont review everything as that is overkill, we only review before a commit, and we still do it sparsely"). Per-slice work is verification-only — the `implementor` pastes its own test output, the conductor spot-checks, work proceeds. There is no standing `reviewer` agent template; a review is a **brief** the conductor sends to a model, structured by this skill.

## Who reviews what — cross-family pairing, reviewer never the author

- **Codex Sol** (`gpt-5.6-sol`) reviews Claude-executed work. Dispatch it through the `codex` MCP tool — never a shelled `codex exec` (user-ruled 2026-09-20) — setting `model`, `sandbox`, `approval-policy: never` and `config.model_reasoning_effort: "high"` at the call site. A review lane is `sandbox: read-only` — an enforced filesystem boundary, not a prose instruction.
- **Claude Opus** reviews Terra-executed work.

The reviewer is always the *other* family from whoever wrote the diff — never the same model checking its own output, and never routed through the agent that authored the change. This is a practice the conductor follows, not a hook or a merge gate that will catch a skipped review — which is exactly why it does not get skipped.

## When to dispatch one

Before a commit, over the **riskiest part** of the accumulated diff — never every file. Riskiest means: runtime/product code, config, permissions, credentials, lifecycle, migrations, generated catalogs, third-party patches. Docs, probe scripts, and generated projections go unreviewed.

Cap the loop at **one review + one fix round + one re-check by the same warm reviewer**; leftover MEDIUM-or-below findings become recorded residual risk, not an endless loop.

## The brief

```text
Objective:       What this change is FOR — the outcome, one sentence.
Diff:             The actual diff or the file paths + `git diff` command to run.
Acceptance:       The frozen acceptance criteria this change must meet, verbatim
                  — never paraphrased or loosened for the review.
Project rules:    Pointers to the governing CLAUDE.md conduct rules or decision
                  records this diff must not violate (cite by slug).
Context:          What the reviewer cannot infer — prior findings, why this
                  shape was chosen over an alternative, what's explicitly out
                  of scope for this pass.
Changed tests:    Every test file the diff touched or removed assertions from —
                  named explicitly, not left for the reviewer to discover.
```

## Review order — ACs first, then project rules, then correctness

1. **Acceptance criteria** — does the diff actually satisfy what was asked, verbatim? A criterion silently loosened or reinterpreted is a finding on its own, independent of code quality.
2. **Project rules** — CLAUDE.md conduct rules, cited decisions and anti-patterns, existing conventions. A diff that is locally correct but violates a governing rule (e.g., a hand-rolled schema duplicating `packages/schemas`) is still a defect.
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

A review claim needs a substantive response on the **final** diff — a review consult that only saw an earlier slice does not discharge the duty for what actually landed. Treat the reviewer's findings as evidence, not a verdict: the conductor adjudicates, fixes what's real, and records disagreement rather than silently overriding it. Per CLAUDE.md's sparring-partner rule, a genuine disagreement is not escalated to the user — the conductor's solution stands and gets built, with the disagreement recorded.
