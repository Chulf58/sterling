---
name: review-brief
description: Use before dispatching a review of a finished diff — the brief for the `reviewer` agent. Triggers on "review this before I commit", "get a review", "second opinion on this diff". The rubric lives in the reviewer agent's body, not here.
---

# Review brief

<!-- claude-only -->
When a review happens, who reviews whose work, and the loop cap are in the conductor prompt (`agent-templates/conductor.md`, installed in each project as `.claude/agents/conductor.md`), section "Review sparsely, and only when a task is done": one review per task, over the riskiest part of the whole branch's diff; N reviewers (the Reviewers setting) run in parallel, then one fix round and one re-check by the same warm reviewer.
<!-- /claude-only -->
<!-- opencode-only -->
On OpenCode, when a review happens, who reviews whose work, and the loop cap are in the conductor prompt (`agent-templates/conductor.md`, installed in each project as `.opencode/agents/sterling/conductor.md`), section "Review sparsely, and only when a task is done": one review per task, over the riskiest part of the whole branch's diff; N reviewers (the Reviewers setting) run in parallel, then one fix round and one re-check by the same warm reviewer. Each reviewer runs on the one model selected for the `reviewer` agent.
<!-- /opencode-only -->

The rubric is the body of the `reviewer` agent (`agent-templates/reviewer.md`, installed as `.claude/agents/reviewer.md`): riskiest part first, every changed test read in full, findings ranked `CRITICAL` to `LOW` with a `file:line`, a failure scenario and a fix, a test-integrity verdict per changed test file, and the areas checked with nothing found. This skill holds no copy of it, so the review surfaces cannot drift apart (decision `reviewer-agent-is-the-one-review-rubric-for-claude-and-codex`). The brief carries what the reviewer cannot infer; the rubric is not retyped into it.

## Dispatching

- **Reviewer**: dispatch the `reviewer` agent (on OpenCode `sterling/reviewer`, with no `model`); it runs on the one model selected for that agent. The rubric is that agent's body, so do not paste it: the prompt is only the brief below. Its tool grant is read-only, so the lane cannot edit files or write to the store; shell stays available on OpenCode, so add "do not modify the worktree" to the brief. Resume the same warm reviewer for the one re-check.

## The Reviewers setting: N parallel reviewers

Decision `settings-that-replace-project-mode-merge-path-reviewer-count`. Run N reviewers where N is the Reviewers setting shown in STERLING CONTEXT (the Workflow line, `config.workflow.reviewers`, 1 to 5); one fix round and one re-check. When N is more than one, dispatch them at once, in the background, each with the same brief below over the whole branch's diff and the same rubric (the `reviewer` agent's body). Do not split them by angle and do not mix models.

Merge and de-duplicate the findings, and adjudicate each on evidence. Run one fix round, then resume ONE warm reviewer for the re-check of the fixes. Findings left at MEDIUM or below are recorded as residual risk. Then merge (direct path), or open the PR (pull-request path), after which the Copilot loop (`pr-review-loop`) starts when the Copilot loop setting is on. A test file marked `WEAKENED`, `HOLLOW` or `NOT READ` by any one reviewer is sent back, whatever the others said.

Riskiest means runtime/product code, config, permissions, credentials, lifecycle, migrations, generated catalogs, third-party patches; docs, probe scripts and generated projections go unreviewed.

## The brief

```text
Objective:       What this change is FOR — the outcome, one sentence.
Diff:            The git range, or the file paths plus the command that produces the diff.
Acceptance:      The frozen acceptance criteria this change must meet, verbatim
                 — never paraphrased or loosened for the review.
Project rules:   The governing decision and anti-pattern records this diff must not
                 violate, cited by slug.
Risk areas:      Where to look first, and what is explicitly out of scope for this pass.
Changed tests:   Every test file the diff touched or removed assertions from —
                 named explicitly, not left for the reviewer to discover.
Context:         What the reviewer cannot infer — prior findings, why this shape
                 was chosen over an alternative.
```

## Reading the result back

A review claim needs a substantive response on the **final** diff: a review consult that only saw an earlier slice does not discharge the duty for what actually landed. A verdict of `APPROVE` with any test file marked `WEAKENED`, `HOLLOW` or `NOT READ` is a contradiction: send it back. Treat the reviewer's findings as evidence, not a verdict: the conductor adjudicates, fixes what's real, and records disagreement rather than silently overriding it. A disagreement over a correctness finding is settled on evidence (reproduce it, run the test, read the cited line), not by authority. The "conductor's solution stands" default in the conductor prompt ("Sparring") covers Astra design consults only; it does not dismiss a review finding.
