---
name: review-brief
description: Use before dispatching a review of a finished diff — the brief for the `reviewer` agent (Claude Opus) and for a Codex Sol review call. Triggers on "review this before I commit", "get a review", "second opinion on this diff". The rubric lives in the reviewer agent's body, not here.
---

# Review brief

<!-- claude-only -->
When a review happens, who reviews whose work, and the loop cap are in the conductor prompt (`agent-templates/conductor.md`, installed in each project as `.claude/agents/conductor.md`), section "Review sparsely, and only when a task is done": one review per task, over the riskiest part of the whole branch's diff; Codex **Sol** (`gpt-5.6-sol`) for Claude-executed work and Claude **Opus** for Terra-executed work; in a HOBBY-mode project, one review, one fix round, one re-check by the same warm reviewer; in a WORK-mode project, 3 to 5 Sol reviewers run in parallel before the PR (see below) and take precedence over the Terra→Opus pairing.
<!-- /claude-only -->
<!-- opencode-only -->
On OpenCode, when a review happens, who reviews whose work, and the loop cap are in the conductor prompt (`agent-templates/conductor.md`, installed in each project as `.opencode/agents/sterling/conductor.md`), section "Review sparsely, and only when a task is done": one review per task, over the riskiest part of the whole branch's diff; **Sol** (`gpt-6.1-sol`) for Claude-executed work and Claude **Opus** for Terra-executed work; in a HOBBY-mode project, one review, one fix round, one re-check by the same warm reviewer; in a WORK-mode project, 3 to 5 Sol reviewers run in parallel before the PR (see below) and take precedence over the Terra→Opus pairing.
<!-- /opencode-only -->

The rubric is the body of the `reviewer` agent (`agent-templates/reviewer.md`, installed as `.claude/agents/reviewer.md`): riskiest part first, every changed test read in full, findings ranked `CRITICAL` to `LOW` with a `file:line`, a failure scenario and a fix, a test-integrity verdict per changed test file, and the areas checked with nothing found. This skill holds no copy of it, so the Claude and Codex review surfaces cannot drift apart (decision `reviewer-agent-is-the-one-review-rubric-for-claude-and-codex`). The brief carries what the reviewer cannot infer; the rubric is not retyped into it.

## Dispatching

- **Claude reviewer** (Opus, including while Sol is capped): dispatch the `reviewer` agent with the model pinned on the call. Its tool grant is read-only, so the lane cannot edit files or write to the store. Resume the same warm reviewer for the one re-check.
<!-- claude-only -->
- **Codex Sol**: call the `codex` MCP tool at `sandbox: read-only`, with the call-site shape in `CLAUDE.md`, "Codex runs through the MCP tool, never the shell". Start the prompt with the body of `.claude/agents/reviewer.md`: everything after the closing `---` of its frontmatter, unedited. Then append the brief below. Do not paraphrase or shorten the body, and do not paste the frontmatter, which names Claude tools Sol does not have. In a clone that has no installed copy, read `agent-templates/reviewer.md` instead. If Codex answers HTTP 400 "not supported when using Codex with a ChatGPT account", say so, review on Opus, and tell the user to check the Codex login (API key versus ChatGPT plan; a lapsed or free account was the earlier cause); do not retry on another Sol id, and never fall back silently (decision `claude-code-sol-route-uses-gpt-5-6-sol-because-mcp-route-is-frozen-at-0-153-4`).
<!-- /claude-only -->
<!-- opencode-only -->
On OpenCode, the Sol bullet reads as follows.
- **Sol**: dispatch the `subagent` tool with agent `sterling/reviewer` and `model` set to `openai/gpt-6.1-sol#high`. The rubric is that agent's body, so do not paste it: the prompt is only the brief below. The agent's permissions deny edits, but shell stays available to it and no sandbox was shown, so add "do not modify the worktree" to the brief. The `codex` MCP tool is the Claude Code route only and is not used here. If the openai provider is not logged in, say so and dispatch the Opus reviewer instead.
<!-- /opencode-only -->

## Work mode: 3 to 5 parallel Sol reviewers

Decision `work-mode-3-to-5-parallel-sol-reviewers-before-copilot-loop`. In a work-mode project, when the task is done and before the PR opens, dispatch 3 to 5 Sol reviewers at once, in the background, each with the same brief below over the whole branch's diff and the same rubric (the `reviewer` agent's body). Do not split them by angle and do not mix models. Pick the count by risk: 3 for a small or low-risk diff, up to 5 when it touches runtime code, permissions, credentials or migrations.

Merge and de-duplicate the findings, and adjudicate each on evidence. Run one fix round, then resume ONE warm Sol reviewer for the re-check of the fixes. Findings left at MEDIUM or below are recorded as residual risk. Then the PR opens and the Copilot loop (`pr-review-loop`) starts. A test file marked `WEAKENED`, `HOLLOW` or `NOT READ` by any one reviewer is sent back, whatever the others said.

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

A review claim needs a substantive response on the **final** diff: a review consult that only saw an earlier slice does not discharge the duty for what actually landed. A verdict of `APPROVE` with any test file marked `WEAKENED`, `HOLLOW` or `NOT READ` is a contradiction: send it back. Treat the reviewer's findings as evidence, not a verdict: the conductor adjudicates, fixes what's real, and records disagreement rather than silently overriding it. A disagreement over a correctness finding is settled on evidence (reproduce it, run the test, read the cited line), not by authority. The "conductor's solution stands" default in the conductor prompt ("Astra is the solution-sparring partner") covers Astra design consults only; it does not dismiss a review finding.
