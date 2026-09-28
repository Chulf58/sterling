---
name: plain-prose
description: Rewrite a knowledge-store record's prose to remove AI-style writing tics (em-dash overuse, AI vocabulary like "delve"/"leverage"/"robust", "not just X but Y" constructions, manufactured triads). Use when the user says "de-AI this record", "clean up this prose", "this reads like AI wrote it", or runs /sterling:plain-prose. A prompt SOP only — no script, hook or enforcement mechanism (finding de-ai-text-skill-fit-for-sterling-knowledge-prose-september-2026; decision gap-hunt-2026-09-28-rulings, item (+)).
---

# Plain prose — de-AI a knowledge-store record

Scoped to knowledge-store prose, which accumulates these tics over many LLM edits (decision `gap-hunt-2026-09-28-rulings`, item `(+)`). It is a prompt SOP only: read, judge, rewrite, show, write only on approval. No grep script, no hook, no enforcement mechanism — consistent with `sterling-claude-code-scale-down-boundary`.

## 1. Read

`knowledge_get(id)` for the full-fidelity record. Identify the prose fields worth rewriting for the type at hand (`statement`/`rationale`/`alternatives_rejected[].reason` for a `decision`; `what_it_does`/`intended_behavior` for a `feature_article`; `answer` for a `research_finding`; the equivalent long-text fields for other types). Leave structural fields (`slug`, `title`, `file_keys`, `status`, dates, links) untouched.

## 2. Judge

Scan each prose field for the tic set (Wikipedia's "Signs of AI writing", via `de-ai-text`):

- Em-dash overuse where a comma or period reads more plainly.
- AI vocabulary: "delve", "leverage", "robust", "seamless", "furthermore", "in conclusion", and similar filler.
- "Not just X but Y" and "it's not only X, it's Y" constructions.
- Manufactured triads (three-item lists reached for rhythm, not because the count is actually three).
- Any other pattern from that source that reads as templated rather than said.

A hit is not automatically a fix — the same construction can be the plainest way to say something. Judge each one in context before touching it.

## 3. Rewrite

Fix only what earns a fix: same meaning, plainer wording. Do not shorten, restructure, reorganize, or touch anything outside the identified tics — this is a prose cleanup, not a rewrite of the record's substance.

**A quoted ruling stays verbatim, including its justification clause.** A `statement` or `rationale` that quotes the user ("user-ruled 2026-09-22, verbatim: ...") or cites another record's wording carries that quote and the clause explaining why it was ruled — rewriting either would strip the record of the justification it exists to preserve (CLAUDE.md, "When an article QUOTES a ruling, the quote carries its justification clause"). Rewrite only the surrounding prose, never the quoted span.

## 4. Show before/after

Present each changed field as a before/after pair (not a full-record diff) so the user can judge the actual wording change. If no field has a genuine tic worth fixing, say so and stop — do not manufacture a rewrite to have something to show.

## 5. Approve, then write

Put the rewrite to the user through `AskUserQuestion` — approve as drafted, edit further, or drop. **Only a form answer authorizes the write** (CLAUDE.md, "a ruling exists only if it came through the form" — the same standard applies here to authorizing a store write, not just to a decision). On approval, write with `knowledge_update(id, {field: value, ...})` for each changed field — never `knowledge_create`, this is a fix-forward edit of the existing record, not a new one. On "edit further", loop back to step 3 with the requested change. On "drop", make no write.

No write happens without this exchange — never rewrite and save on your own judgment alone.

## Related skills

- `decision-records` — the fix-forward-with-`knowledge_update` pattern this skill also uses; same reason, same mechanism, applied to writing quality instead of a wrong fact.
