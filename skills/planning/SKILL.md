---
name: planning
description: Plan-mode-shaped conductor phase SOP — read-only discipline; design, decompose, formalize ACs, assemble the brief. Iterable steps; each step's output is a required, checked brief section.
---

# Planning SOP (§7.6)

Read-only discipline throughout (plan-mode-shaped). Iterable steps; each output is a required brief section:

1. **Technical design.** Pre-dispatch the implementation-architect when complexity is visible at intake (the common case). Dispatch explorer/researcher for heavy reads. Small bounded questions: inline lookups (web + knowledge tools) are licensed — capture findings; big unknowns → researcher. Output: `technical_design` (approach, interfaces with contracts, shared structures).
2. **Decomposition into phases**, informed by the design. Re-read blast radius if the design widened scope. Each phase spec declares its `files` + `rank_terms` — prep's staging inputs are planning outputs, never improvised at staging time. Every phase's interfaces must be declared (the test-writer's spawn fails loud otherwise).
3. **AC formalization + flags.** ACs as observable end-to-end behavior, each with `verifiable_at`. Difficulty per the rubric (mechanical inputs: blast-radius count vs config threshold, prep retrieval volume; plus algorithmic complexity, ambiguity residue, poorly-covered external integration — cite reasons). Risk flags `security_relevant`/`perf_sensitive` proposed here, human-confirmed at the gate.
4. **Brief assembly + decision capture.** Planning retrieval runs with `include_unconfirmed: true`; any `derived_unconfirmed` record relied on is confirmed-or-killed on the spot (§3.2.6). Design decisions → decision records, cited in `decisions_made`.

**Feature-sizing check:** a feature too big to plan in one conversation is split into features (P7). The brief's AC + scope sections lock at the gate — hooks will enforce them for hours.
