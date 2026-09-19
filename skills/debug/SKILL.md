---
name: debug
description: Root-cause debug SOP (§8.3) — trace to the floor before any fix; independent verification fan-out; deterministic tests at the real seam; capture including disconfirmed hypotheses.
---

# Debug SOP (§8.3) — interactive by nature; conductor-run inline

1. **Trace to the floor before proposing any fix.** From evidence, descend one governing mechanism at a time, citing file:line at each step, until a cited floor. GATE: no fix proposal until the chain bottoms out.
2. **Read context first.** Use the explorer for owning articles, decisions, anti-patterns, and repository evidence; use the researcher for online research and disconfirmed hypotheses. Intended behavior is the breakage oracle, and the apparent bug may be deliberate.
3. **Independent verification for code-touching bugs.** Give the researcher and an independent explorer the symptom and raw evidence, not your proposed fix. Synthesize their findings; a refutation revises the diagnosis. Distinguish the root fix from a mid-chain workaround or symptom patch.
4. **Scope threshold.** If the explorer finds multiple affected features or downstream paths, stop and agree a feature-sized scope with the human. Localized fixes stay inline.
5. **Test before AND after, deterministic, at the real seam.** Force intermittent failures deterministically. Layer 1: logic unit (RED→GREEN). Layer 2: real-dispatch smoke at the actual seam — must reproduce pre-fix (a test green on the broken state tests nothing). Layer 3: don't-re-break the legitimate path. Layer 4: end-to-end the way the bug was found. Mutation-check the regression test.
6. **Capture.** Record the anti-pattern when evidence warrants it, preserve disconfirmed hypotheses, reconcile the owning article, keep the regression test, remove any temporary workaround, and close the boarded task by exact full UUID. Obtain an independent review appropriate to the risk before committing.
