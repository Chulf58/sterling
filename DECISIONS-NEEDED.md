# DECISIONS-NEEDED — deferred decisions awaiting human review

Per the overnight mandate: gaps/platform deltas where the most conservative
spec-faithful reading was implemented and work continued. Each code site is
marked `STERLING-DEFERRED`. Reversible unless noted.

## Open

3. **Plan mode: native vs plan-mode-shaped** (step 8 ★verify). Current docs:
   native plan mode is read-only with prompts identical to default — MCP
   write tools (planning-time decision capture) would prompt per call (P1
   ceremony), and the approved plan is not programmatically deliverable as
   the brief object. CHOSE: plan-mode-shaped — the planning skill's
   read-only discipline + the store brief as the single authority; native
   plan mode is not load-bearing. Reversible: skill text + conductor
   contract only. `STERLING-DEFERRED(plan-mode)` in skills/planning.
4. **Mutation capability** (step 7): deliberately absent on the node
   adapter; the green check skips it loudly. Implementing it is additive
   (adapter capability + §9.2 round logic); deferred to real run data per
   the spec's own economics. No code marker (the degrade path IS the
   designed behavior).
5. **ink-terminal evaluation** (step 10 ★verify): exists on npm only at
   0.1.0-alpha.1 — alpha is not a shippable base. CHOSE: base ink 7
   (stable, react 19), arrow-key navigation; mouse support door-open.
   Reversible: a renderer swap inside packages/tui.
6. **Per-phase JUDGMENT completeness checker** (step 8): "every subtask
   evidenced" is an LLM judgment; the mechanical halves are scripted and
   the judgment half skips loudly (completeness-judgment). Options: a
   classifier-tier prompt step at phase completeness, or conductor-run
   review against the handoff. Choose when the first real run shows what
   the handoffs actually contain.

## Carried forward from earlier steps (already flagged in commits/session log)

1. **H11 handler mechanism** (step 5): prompt hooks are read-only on the
   current platform; implemented as a command hook running headless
   `claude -p --model haiku`, degrading loud. Alternative: prompt hook
   injecting candidates for conductor-mediated writes. Awaiting approval.
2. **H12 dormancy source** (step 5): spec says "unless brief declared
   dormancy" but §4 has no dormancy field; implemented against the captured
   article's `state: dormant` (+ required state_reason/wiring_todo_id).
   Spec touch-up or redirect needed.
