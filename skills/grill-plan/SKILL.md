---
name: grill-plan
description: Post-plan fidelity walkthrough SOP — adjudicate mechanically pre-computed intent↔plan divergence flags with the human. Runs in full regardless of familiarity.
---

# Grill-plan SOP (§7.6)

Runs AFTER planning, BEFORE the gate — in full, every time. The urge to skim is highest exactly when an edge will slip.

1. Run the divergence script: `node scripts/grill-plan-flags.mjs --brief <id>` — it pre-computes the mechanical flags (ACs without phases, phases without ACs, unconfirmed proposals, scope conflicts vs `out_of_scope`, phase file claims outside the blast radius, phases missing their §8.1 interface slice, absent risk flags). The script flags; the human adjudicates.
2. Walk the human through each flag, one at a time: state the divergence, the plan's reading, and the user-stated text verbatim. The human adjudicates; record the resolution on the brief.
3. Unconfirmed `conductor_proposals` are decided here — confirmed or struck. None survive to the gate unresolved.
4. Exit: all flags adjudicated → the brief is gate-ready (AC confirmed, contract locked, difficulty flags overridable at the gate).
