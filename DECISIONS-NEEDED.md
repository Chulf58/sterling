# DECISIONS-NEEDED — deferred decisions awaiting human review

Per the overnight mandate: gaps/platform deltas where the most conservative
spec-faithful reading was implemented and work continued. Each code site is
marked `STERLING-DEFERRED`. Reversible unless noted.

## Open

(none yet)

## Carried forward from earlier steps (already flagged in commits/session log)

1. **H11 handler mechanism** (step 5): prompt hooks are read-only on the
   current platform; implemented as a command hook running headless
   `claude -p --model haiku`, degrading loud. Alternative: prompt hook
   injecting candidates for conductor-mediated writes. Awaiting approval.
2. **H12 dormancy source** (step 5): spec says "unless brief declared
   dormancy" but §4 has no dormancy field; implemented against the captured
   article's `state: dormant` (+ required state_reason/wiring_todo_id).
   Spec touch-up or redirect needed.
