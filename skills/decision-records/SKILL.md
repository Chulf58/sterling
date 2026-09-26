---
name: decision-records
description: Capture and read Sterling's durable decision records through the knowledge_* MCP tools. Use when a design choice is made between real alternatives ("let's go with X", "we decided", "the reason we picked X over Y"), when the user says "record this decision", or asks "why did we choose X". Turns decisions that would otherwise live only in chat into durable, queryable records.
---

# Decision records

Decisions that live only in chat, a commit message, or one person's memory rot. Sterling keeps them instead as `decision` (or `anti_pattern` / `research_finding`) records in the knowledge store, retrieved through the `knowledge_*` MCP tools.

**Only the conductor authors a record, and it creates one directly.** `researcher`, `scout`, and `implementor` hold no store-write grant. If any of them surfaces a decision worth recording, it comes back as a **capture candidate** in its report, and the conductor writes the record itself, never by dispatching another agent to do it. `librarian`'s grant (`agent-templates/librarian.md`) is update-shaped knowledge writes (`knowledge_update`/`append`/`edit`/`array_remove`) plus board and queue writes — all applying conductor-drafted content verbatim; it never creates a record and never authors one.

## When to activate

- A choice is made between credible alternatives (a sync strategy, a persistence model, reuse vs. build, a data-shape choice).
- The user says "record this", "decide this", "we decided", or states a rationale ("we're doing X instead of Y because…").
- An open question gets resolved.
- The user asks "why did we choose X?" — query the store and answer from it.

Two different situations, two different responses:

- **The decision is already settled** — the user ruled it through an `AskUserQuestion` form, or it is the direct, unambiguous conclusion of research that already resolved the question, or it is a conductor decision within the conductor's own remit. This is routine capture: write the record. It does not need a suggestion or a separate ask. **Label it as what it is**: only a form answer is a user ruling (`CLAUDE.md`, "Ask, don't guess — through the AskUserQuestion tool" — a ruling exists only if it came through the form; a prose answer is not one). A research conclusion or a conductor decision is recorded as that, never attributed to the user.
- **The decision is not actually settled yet** — you noticed an implicit choice being made but the alternatives were never weighed, or it's genuinely unclear which option the user wants. That is an open question: put it to the user through `AskUserQuestion`, one question at a time (`AGENTS.md`, "Ask, don't guess — one question at a time"), and record it only once they have answered the form.

## Before writing anything: check for a conflict

`knowledge_preflight(text)` on the decision's subject — **before** drafting it and before putting any related question to the user. It takes no `file_keys`, so it answers for a SUBJECT rather than a path. A `verify_targets` verdict names the governing records to open before you proceed: fold the ruling in, or supersede it, rather than writing a second, contradicting record. A `knowledge_query` sweep (`rank_terms` from the subject) is the fallback wide check. Nothing found in a reasonably wide sweep means it is genuinely open — proceed.

## Recording a new decision

1. **Identify** the core choice being made.
2. **Check for a conflict** (above).
3. **Gather alternatives** — every credible option considered, and the specific reason each one was rejected. "We just picked it" is not a reason; capture the real one.
4. **Check the shape before writing it** — `knowledge_schema('decision')` (or `anti_pattern` / `research_finding`) returns each field with `required`, its type, and any closed enum values, so you build the body against what the write will actually accept rather than guessing. `alternatives_rejected` is `{option, reason}[]`, not a plain string array.
5. **Write the record** with `knowledge_create`: a slug-worthy title, the statement in present tense ("Sterling uses…"), `alternatives_rejected` with real reasons, the rationale, and `file_keys` for the record types that carry them (`decision`/`anti_pattern`/`research_finding` — `file_keys[]`; `feature_article` uses `files[{path,role}]` instead; `reference_material` carries no path field, its location comes from `location`).
6. **Write it once the decision is actually settled — no extra confirmation ceremony.** If the choice was already made, the write itself is the record.

## Reading decisions

- `knowledge_query(types, rank_terms)` to find candidates — `rank_terms` are single keywords, never prose. A `capped` result is a window, not the whole store: raise `cap` or narrow before concluding nothing governs the area.
- `knowledge_get(id)` for the full-fidelity current or archived record (query results are projected/bounded, and omit the supersedes chain).
- Answer from the record's substance, and cite it by **slug** in prose (`[slug] (knowledge_get <id>)`) — a slug survives supersession, a bare id does not age as well. Never put a bare id in front of a human without its name beside it.

If nothing exists, say so and offer to record one once the discussion resolves.

## Correcting or replacing a decision — fix forward, never a second copy

- **The old decision was simply wrong or incomplete** → `knowledge_update` (fix-forward, same id — ids are permanent across updates; only the version bumps). For a long string field, prefer `knowledge_edit(id, field, find, replace)` over a full retransmit — `find` must match exactly once. `status`/`superseded_by` are server-owned and refused if you pass them.
- **A genuine duplicate** (two records describe the same thing) → `knowledge_retire(id, in_favor_of)`, pointing at the survivor. This is narrow — it is not a way to discard a merely-wrong record; use `knowledge_update` for that. Never create a replacement beside the original and leave both live: two records under one slug is worse than one wrong record, because retrieval serves both and they contradict.

## What makes a good decision record

- Specific ("Reuse the existing X as the Y substrate"), not vague.
- Records the **why**, not just the what.
- Includes every rejected alternative with the actual reason.
- Readable in two minutes. If the rationale needs more than a short paragraph, it is probably several decisions.
- Don't record trivia (naming, formatting) — decision records are for choices that constrain the future.

## Related skills

- `design-research` — produces the evidence a decision's rationale cites, and checks the store for a pre-existing decision before researching further.
- `closing-out-tasks` — the capture gate that reaches for this skill at the end of a unit of work.
