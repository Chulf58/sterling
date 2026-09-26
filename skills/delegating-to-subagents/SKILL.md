---
name: delegating-to-subagents
description: Use before dispatching a subagent or choosing which agent should do a piece of work — "delegate this", "use a subagent", "which agent should I use", "run these in parallel", "get a second opinion". Covers the delegation brief contract, the implementor/researcher/scout/librarian roster, warm-agent reuse, one-writer-per-file, and the failure modes that make delegation lose to just doing the work yourself.
---

# Delegating to subagents

## The one thing to get right

A subagent starts with a **fresh, empty context window**. It cannot see your conversation, the files you already read, the user's corrections, or the constraint you settled three turns ago. It gets its own system prompt, `AGENTS.md` and `CLAUDE.md`, and *your brief*. Nothing else.

Under-specified briefs are the single largest source of wasted delegation. Agents duplicate each other, answer a subtly different question, or return something unusable — and you pay full price for it.

## Delegate, or do it yourself?

Delegate when at least one of these is true:

- **Context isolation.** The subtask will generate a lot of output you will never reference again — log trawls, wide searches, reading twenty files to extract three facts.
- **Genuine parallelism.** Two or more strands are independent, touch different files, and share no state.
- **Independence.** You need judgement not contaminated by your own reasoning — review of your own work is the canonical case.
- **Cost.** Mechanical work a cheaper agent can do under an objective acceptance check.

Do it yourself only within the conductor's four hand-work exceptions — a ruling, a small authored record, verifying one subagent claim with one command, and the commit (the conductor prompt, `agent-templates/conductor.md` — installed in each project as `.claude/agents/conductor.md` — section "You are the delegator, not the worker"). Everything else is a dispatch; the same section names the opposite defect, a dispatch without value. Two tests still decide *how* to split the work: pieces that are sequential phases of the *same* change go to one agent (splitting loses context at every handoff), and if you cannot state an acceptance check, fix that first — if you can't tell whether the result is right, neither can a subagent.

The honest test: **would a competent colleague, given only your brief and no other context, produce what you need?** If not, fix the brief.

## The brief

The seven fields (Objective, Context, Scope, Out of scope, Acceptance, Budget, Return) and the point-at-files-never-paste rule are in `agent-templates/conductor.md`, "Brief quality is your product". Omissions are where delegation fails. A worked example:

```text
Objective: Make POST /orders reject a negative quantity with 422 instead of 500.
Context: Handler is src/api/orders.py:88. Validation elsewhere uses the
  pydantic models in src/api/schemas.py — follow that pattern.
  Repro: tests/api/test_orders.py::test_negative_qty currently errors 500.
Scope: src/api/orders.py, src/api/schemas.py, tests/api/test_orders.py
Out of scope: the shared error middleware, any other endpoint.
Acceptance: `pytest tests/api/test_orders.py` green, including a new case
  for quantity=0 which must still be accepted.
Budget: ~15 tool calls. Return after 3 failed attempts at the same error.
Return: files changed, the diff rationale, pasted pytest output, blockers.
```

## Picking the agent

The roster, each role's return shape, and the escalate-on-evidence rule are in `agent-templates/conductor.md`, "The roster"; each role's shipped default model and effort are in `templates/default-config.json` (`models`), and a project's own values in `.sterling/config.json`. In short: `scout` locates, `researcher` traces and answers web facts (it has WebSearch and WebFetch; the scout has no web tools), `implementor` changes code and owns its tests (Opus 5.5 by default; pin Sonnet 5 on a dispatch for a narrow mechanical lane), `librarian` applies conductor-drafted store writes, and **Terra** (`gpt-5.6-terra`, through the `codex` MCP tool) is an alternative to the implementor's default. Every dispatch carries an explicitly pinned model.

Reviews are not a roster role: dispatch them per the `review-brief` skill. Who reviews what — the cross-family pairing, and in a WORK-mode project Sol before the PR, which takes precedence over the Terra→Opus pairing — is in `agent-templates/conductor.md`, "Review sparsely, and only before a commit".

## Parallel lanes, warm agents, reading results back

See `agent-templates/conductor.md`, "Reuse warm agents; one writer per file" and "A subagent result is evidence, not a verdict". Two dispatch-sizing points they do not spell out:

- A dispatch has a size, and it is not the smallest slice's size — batch related work needing the same files or context into one agent rather than fanning out five one-liners.
- For large artifacts, have the agent write to disk and return the path — copying big payloads through reports burns your context.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Two agents did the same work | Overlapping scopes | State each lane's distinct question before spawning |
| Answer solves the wrong problem | Objective described the activity, not the outcome | Rewrite the objective as a result |
| Agent wandered far out of scope | No boundaries, no budget | Add `Out of scope` and a tool-call cap |
| Agent edited a file another owned | No ownership assignment | One writer per file |
| Cost blew up, output was thin | A dispatch without value | Fold it into a larger unit of work |
| Endless back-and-forth | No stop condition | Cap attempts; require an evidence-backed blocker report |
| Confident but wrong summary | Accepted a claim with no cited evidence | Require `path:line`, commands, or record ids |
