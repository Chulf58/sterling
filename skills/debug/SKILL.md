---
name: debug
description: Root-cause debug SOP — trace to the floor before any fix; a diagnosis backed by evidence and a regression test that fails before the fix; independent verification and extra test layers when the bug is high-risk or contested; capture including disconfirmed hypotheses.
---

# Debug SOP — interactive by nature; conductor-run inline

Every bug gets a **diagnosis backed by evidence** and **a regression test that fails before the fix**. The heavier steps — the independent verification fan-out, the extra test layers, the mutation check — are for a **high-risk or contested** bug: one that touches runtime code under `packages/`, hooks, config, permissions or persisted data, or one whose diagnosis is disputed or already failed once (decision `skill-ceremony-scaled-to-risk-after-2026-09-26-audit`).

1. **Trace to the floor before proposing any fix.** From evidence, descend one governing mechanism at a time, citing file:line at each step, until a cited floor. GATE: no fix proposal until the chain bottoms out.
2. **Read context first.** The scout locates owning articles, decisions, anti-patterns, and repository evidence; the researcher traces the mechanism and disconfirmed hypotheses; the implementor fixes. Intended behavior is the breakage oracle, and the apparent bug may be deliberate. A web fact (a library's documented behavior, a known upstream issue) goes to the researcher, which has WebSearch and WebFetch and cites URL and access date; a judgement call goes to an Astra consult.
3. **Independent verification — high-risk or contested bugs only.** Give the researcher and an independent scout the symptom and raw evidence, not your proposed fix. Synthesize their findings; a refutation revises the diagnosis. Whatever the risk, distinguish the root fix from a mid-chain workaround or symptom patch.
4. **Scope threshold.** If the trace finds multiple affected features or downstream paths, stop and agree a feature-sized scope with the human. Localized fixes stay inline. `debug-scope` records observation and capture metadata; it refuses nothing (decision `debug-scope-is-metadata-fs-helpers-stop-refusing`).
5. **Test at the real seam.** Always: a deterministic regression test at the seam where the bug lives, shown failing on the broken state and passing after the fix (a test green on the broken state tests nothing). Force intermittent failures deterministically. For a high-risk or contested bug, add the further layers: a real-dispatch smoke at the actual seam, a don't-re-break check on the legitimate path, an end-to-end repro the way the bug was found, and a mutation check of the regression test.
6. **Capture.** Record the anti-pattern when evidence warrants it, preserve disconfirmed hypotheses, reconcile the owning article, keep the regression test, remove any temporary workaround, and close the boarded task by exact full UUID. Obtain an independent review appropriate to the risk before committing.
