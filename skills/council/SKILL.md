---
name: council
description: Run the six-hats council — an opt-in, pre-build deliberation pass (3 bounded rounds + blue synthesis) that returns a question agenda, risks, and alternatives to sharpen intake. Mode-independent; user-invoked; never auto-fires.
---

# Council SOP — opt-in pre-build deliberation

The council multiplies the perspectives that generate an intake pass's questions: five de Bono hats (⚪ facts, 🔴 intuition, 🟡 value, ⚫ risks, 🟢 alternatives) deliberate across three bounded rounds (blind → rebut → converge), and 🔵 blue synthesizes their three rounds into an interview agenda. It is available from BOTH intakes — a pass inside the pipeline grill-intent interview, and the optional third step of conductor-direct intake — and never for trivial edits (no intake at all, P1). ~16 opus agents per run, each doing KB + code reads: the user owns the worth-it call, always. The conductor asks; it never scores "width" and never auto-fires.

1. **Invoke on the idea + answers-so-far, verbatim.** No paraphrase, no pre-stuffing. `answers_so_far` is the prior intake passes' Q&A (in conductor-direct: the fit-for-purpose answers + relevant conversation).
2. **Readiness gate first.** The council needs the intent bar, not the full brief: (a) can you state the change in one sentence the user would endorse? (b) can you state the problem/value it serves? (c) can you name where it lands sharply enough that a hat could aim a KB + code query? Any "no" → one more intake pass targeting that gap, then re-check. Never deliberate on mush — even when the user invokes the council directly, close the gap first.
3. **Run it:** `Workflow({ scriptPath: "scripts/council.workflow.mjs", args: { idea, answers_so_far, scope, stack_tags } })`. Hats query the KB and read code themselves (retrieval-first is baked into their prompts); the conductor stages no central pack. Hats are read-only by construction (explorer agent type — no Bash, no Edit/Write, no store-write tools).
4. **Present blue's read.** Surface `red_hunch` explicitly as intuition, never as fact (the red hat is the sanctioned, always-labeled exception to anti-speculation — for its own output only). `advisory_lean` is colour, not a verdict.
5. **Drain the agenda one question at a time.** The `interview_agenda` is the next pass's question QUEUE — grill-intent step 1 (one question at a time) is inviolate; a council never batches the ask. Route `research_questions[]` to the grill's bounded researcher trigger (grill-intent research step), captured as `research_finding` with both clocks.
6. **Capture is lifecycle-bound — the deliberation is transient.** The council auto-writes nothing and is never parked in a note. A `decision` is written only on a later explicit user commitment downstream; green's `best_alternative` and rejected angles feed its `alternatives_rejected`.
7. **Both intakes must run fully with zero council.** Optionality is a hard guardrail: the interview and the direct intake are complete without it.
