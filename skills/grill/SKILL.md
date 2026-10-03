---
name: grill
description: Interview the user about a plan, design or new ask until every consequential choice is ruled or explicitly deferred, one AskUserQuestion form at a time, capturing each settled choice as a decision record. Use when the user says "grill me", "interview me about this", "poke holes in this plan", or runs /sterling:grill — when a new non-trivial ask is ambiguous at intake (intent, acceptance or scope unstated, or two or more reasonable readings), where a short intake grill runs before the first dispatch — and when the conductor can NAME a consequential unresolved choice (scope, acceptance, architecture, an expensive commitment) that the store cannot settle.
---

# Grill — the design interview

Decision `sterling-grill-skill-design`. The interview and its capture only; no brief, no gate, no flag script. Standing rules apply unchanged: one question at a time, a ruling exists only through the form, preflight before asking.

## 0. Entry

- **User-invoked** (`/sterling:grill`, "grill me"): the subject is what they named; if it is unclear, the first form asks which subject.
- **Conductor-invoked at intake:** for every new non-trivial ask, before the first dispatch, the conductor checks whether the intent, the acceptance or the scope is unstated, or whether there are two or more reasonable readings. If any holds, run the intake grill (section 0a). A clear ask starts at once; a vague one always gets the grill (user-ruled 2026-10-03, "On ambiguity, at intake (Recommended)").
- **Conductor-invoked mid-task:** first state, in one line, the consequential choice you cannot settle and why the store does not settle it. No nameable choice, no grill — decide it yourself or ask one ordinary question.

## 0a. Intake grill

A short shape for an ambiguous new ask. It is the same interview, scaled down:

- **1-3 questions**, one form each, dependency-ready first. Stop when the intent, the acceptance and the scope are each stated; do not grow it into a full tree unless a consequential choice appears.
- **The first question restates your understanding as an option:** "Proceed as I understand it: ..." (intent, acceptance and scope in a sentence or two), recommended first, with 1-3 alternative readings beside it. If the user picks it, the grill ends there.
- **Facts still go to lanes** (section 1). Ask only what the ask leaves open and the store cannot settle.
- **Capture** only a choice that is a real decision (section 4); a restated ask that the user accepts is a board item's acceptance text, not a decision record.
- Ending the grill is not an order to stop: once the ask is clear, board it and start, unless the user only asked to be grilled.

## 1. Stage before asking

- `knowledge_preflight` and `knowledge_query` on the subject **in the store's vocabulary** (its titles' words, sibling slugs); re-ask once in that vocabulary after an `ungoverned` verdict on a subject you expect to be governed.
- **Facts go to lanes, never to the user.** Anything the code, the store or the web can answer goes to a lane: the code, the store or a web fact to a scout or researcher (only the researcher has web tools); a question of judgement to an Astra consult. Only decisions go to the user.
- **A settled ruling is not a question.** Never re-ask it. Show it only where it explains a recommendation, cited by slug.

## 2. The tree

- Hold a tree of open choices, grown as answers arrive; an answer can open, close or reshape branches.
- Ask next the **dependency-ready** question that removes the most consequential uncertainty. Skip what is reversible and cheap — decide it yourself and say so.
- When independently deliverable outcomes emerge, **split the scope**: ask which one to grill now; the rest are deferred by name.
- An **ungrillable** branch (feel, UX, "I'll know it when I see it") becomes a bounded prototype with a stated learning question, not more questions.

## 3. One form per question

Each question is its own `AskUserQuestion` call:

- 2-4 options, **recommended first** and labelled so.
- Each option states its **cost** and **what would overturn it**.
- Use the option `preview` when options are concrete artifacts to compare (code shapes, layouts, file trees).
- Plain language; a system term is defined in the question that introduces it.

**Not a ruling:** an answer given in prose, a question asked back, an interrupted or dismissed form. Answer the question if one was asked, then put the form again. Never read agreement into silence.

## 4. Capture as choices settle

- **One decision record per settled choice** (related answers fold into one): `knowledge_preflight` first, then `knowledge_create` per the decision-records skill.
  - `statement` opens `USER-RULED <date> through the question form` and quotes the **chosen label verbatim**.
  - Attribution stays structural: user-stated text vs conductor proposals, never blended.
  - `alternatives_rejected`: each unselected option with the reason **only as it was presented in the form** ("Form option not chosen. As presented: …"). Never invent a reason.
- **Lesser detail** goes into the subject's existing article (`knowledge_update`), nothing else is written. A new concept family gets its concept article per CLAUDE.md.
- Capture as you go, not at the end: an interrupted session keeps what was ruled.

## 5. Before closure

- **Astra sparring, when warranted** (a new mechanism, persistent state, a deletion boundary, anything hard to unship): put the ruled design, your proposal and your own objections through the `codex` MCP tool — `model: gpt-6-astra`, `sandbox: read-only`, `approval-policy: never`, `config: {model_reasoning_effort: "high"}`. It runs **before** closure; a new trade-off it raises goes back to the tree as a form.
- **Close** when each consequential branch is resolved or **explicitly deferred** (named, with why). Never close with a "done?" or "is this ready?" form.
- **Ending the interview does not authorize building.** Building is its own ask unless the user already asked for it.
- **Clear `needs: grill` at the end.** When the grill was for a board item marked `needs: grill`, clear the mark with `board_update {needs: ""}` once the interview closes (or set `needs: user` if a ruling is still owed), so the item leaves WAITING ON YOU and can start (decision `board-items-carry-a-needs-field-and-h1-lists-ready-items-for-auto-start`).

## 6. Fidelity check

When the design or brief is written down, compare it line by line with the session's rulings. Repair your own drift and say what you changed ("corrected X to match the ruling"). Go back to a form only on a genuine conflict or a new trade-off. No flag script, no second interview.

## Interruption and nesting

- Interrupted: ruled choices are already captured; unanswered ones stay **open** — list them when you stop, and resume from the tree, not from the start.
- Nested (another skill or a subagent reaches a grill): only the user answers. No calling agent, subagent or skill answers a form, picks a default for a gate, or treats its own recommendation as ruled. A subagent that needs a ruling returns the question to the conductor.
