---
name: debug
description: Root-cause debug SOP (§8.3) — trace to the floor before any fix; independent verification fan-out; deterministic tests at the real seam; capture including disconfirmed hypotheses.
---

# Debug SOP (§8.3) — interactive by nature; conductor-run inline

1. **Trace to the floor before proposing any fix.** From evidence, descend one governing mechanism at a time, citing file:line at each step, until a cited floor. GATE: no fix proposal until the chain bottoms out.
2. **Read context first.** Explorer pulls owning articles (intended_behavior is the breakage oracle), decisions (the "bug" may be deliberate), anti-patterns, research, and disconfirmed hypotheses (do not re-litigate disproved trails). This makes the true fix size visible before committing to a patch.
3. **Verification fan-out (mandatory for code-touching bugs).** Dispatch researcher + independent codebase tracer (explorer) + skeptic in parallel — each receives the SYMPTOM + RAW EVIDENCE ONLY, never your floor or fix (independent derivation refutes; a handed conclusion only confirms). Synthesize after all report; a refutation revises the diagnosis. The skeptic owns root-vs-symptom: floor = the one root fix; mid-chain = workaround; symptom = patch — never a co-equal menu.
4. **Promotion threshold.** Explorer's blast radius spans multiple features/downstream paths → feature-sized change → promote to a fix pipeline (human confirms; the map becomes the brief's scope; each downstream path a phase). Localized → stay inline.
5. **Test before AND after, deterministic, at the real seam.** Force intermittent failures deterministically. Layer 1: logic unit (RED→GREEN). Layer 2: real-dispatch smoke at the actual seam — must reproduce pre-fix (a test green on the broken state tests nothing). Layer 3: don't-re-break the legitimate path. Layer 4: end-to-end the way the bug was found. Mutation-check the regression test.
6. **Capture.** Anti-pattern (what broke / wrong way / right way — noise-gated, evidence-required); disconfirmed hypotheses from the fan-out's refutations (§3.2.8); article reconciliation; regression test promoted; workaround removed if one was built; boarded todo removed. H3 debug-scope mode live throughout (the explorer map registers as the lightweight contract).
