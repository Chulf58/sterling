---
name: design-research
description: Evidence-first research workflow for design decisions. Use when comparing options, evaluating prior art, or asking "should we use X or build it", "is there an existing pattern for this", "what's the best way to do Y". Consults the knowledge store first, then the repo, then prior art via scout, then the web — and always separates sourced fact from inference from recommendation. Do NOT use for trivial lookups or when the answer is already obvious from one file.
---

# Design research

The point of good engineering is to **converge on the best design** before pouring concrete. Bad designs usually come from skipping research, not from bad taste. This skill enforces the order: **consult what already exists and is already decided, then decide.**

Its prime directive: **do not build a second version of something the knowledge base already settled.** Most "how do we build X" questions are really "does the store already govern X, and should we adopt / extend / reuse it instead of writing it."

## When to use

- Comparing two or more credible approaches (a sync strategy, a persistence choice, an identity model).
- Before designing any new mechanism, service, or abstraction.
- The request says "research", "investigate", "compare", "evaluate", "prior art", or "should we use X or build our own".

## When NOT to use

- The answer is one `grep`/`Read` away — just look it up.
- The decision is already made and unambiguous — just do it.
- This is a pure value judgment with no facts to gather — have the tradeoff conversation directly with the user instead of researching facts that don't exist.

## Core rule: the store and repo before the web

Search in this order and stop as soon as the question is answered:

1. **The knowledge store, always first.** Run `knowledge_preflight(text)` on the subject before drafting anything or asking the user — a `verify_targets` verdict means the store already governs or contradicts this, and you open the named records before proceeding. Then `knowledge_query` (`rank_terms` from the subject, `types: ["decision","anti_pattern","research_finding","feature_article"]`) — articles first, code second. A governing decision or research_finding settles the question outright; re-litigating it without new evidence is a waste, not rigor. A `capped` result is a window, not the whole store — raise `cap` or narrow before concluding absence.
2. **This repo** — `AGENTS.md`, `CLAUDE.md`, `docs/`, existing scripts and config. Design intent often lives here even beyond the store.
3. **Prior art via `scout`.** Dispatch it to map an unfamiliar area of the repo instead of reading it all yourself — its `path:line` map plus stated coverage gaps is the compact form you need.
4. **The platform itself.** If you're building on a shared runtime (Claude Code, an MCP server, a shared library), check its own docs and source for the exact behavior before assuming you need to build around it.
5. **The web** — only after local and prior-art channels are exhausted or clearly insufficient. A web FACT (a library's documented behavior, a version, a known issue) goes to the `researcher`, which has WebSearch and WebFetch and cites every web claim with its URL and access date; a question of JUDGEMENT goes to an Astra consult (the conductor prompt, `agent-templates/conductor.md` — installed in each project as `.claude/agents/conductor.md` — section "Astra is the solution-sparring partner"). Decision `researcher-gets-web-search-and-fetch`.

State honestly which channels you actually checked. "Nothing found" is only valid if you say *where* you looked. `researcher` and `scout` read the knowledge store as part of this research, but writing to it is out of role for them — a finding worth keeping durably is a **capture candidate** for the conductor to record, never something they save themselves.

## The adopt / extend / reuse / build decision

| Signal | Action |
|---|---|
| A governing decision or article already settles this | **Adopt the ruling** — fold it in, or supersede it if genuinely wrong, never write a second contradicting record |
| An existing mechanism in this repo already does this | **Reuse its pattern** unless a decision record says otherwise |
| Close third-party fit, well-maintained | **Adopt / extend** — thin wrapper at most |
| Partial fits only | **Compose** — combine, or extend the closest |
| Genuinely nothing fits | **Build** — but build *informed* by the research |

Default bias: reuse what the store and repo already carry over building new mechanisms (P3 — scripts over agents; P7 — prevention over recovery).

## Workflow

1. **Scope the question.** Reduce to one explicit question. If it is actually two, split them.
2. **`knowledge_preflight` + `knowledge_query` the store** (step 1 above) before anything else.
3. **Gather local evidence** (repo, scout) — keep the returned context compact.
4. **Gather external evidence** only if needed, with dates.
5. **Separate the layers** (below) — never blur them.
6. **For a non-trivial design, put it to Astra before committing to a shape** — when a design counts as non-trivial, what the consult carries, how it is dispatched and how a disagreement resolves are all in the conductor prompt, section "Astra is the solution-sparring partner". Never for a routine change.
7. **Recommend** with a clear adopt/extend/reuse/build call and the main risk, then capture the settled decision (see the `decision-records` skill).

## Evidence boundaries (non-negotiable)

Label every important claim. Two readers must be able to agree on what is fact vs opinion.

```text
SOURCED FACT   — from the store or the web, with a record id / link and date
LOCAL FACT     — from this repo, with file:line
INFERENCE      — what follows from the facts (clearly your reasoning)
RECOMMENDATION — the call, and the strongest reason against it
```

Freshness-sensitive claims (versions, "current state of") carry a date; a `research_finding` that measured only part of its subject states the measured population and its exclusions explicitly — an unstated gap reads as "measured the whole question" to the next reader.

## Output format

```text
QUESTION
- the one thing being decided

EVIDENCE
- SOURCED FACT: ... (record id / url, date)
- LOCAL FACT: ... (file:line)

INFERENCE
- what the evidence implies

RECOMMENDATION
- adopt / extend / reuse / build, and why
- strongest reason against
- open follow-ups (candidates for a decision record)
```

## Anti-patterns

- Jumping to "let's build it" before checking the store or the repo.
- Re-researching a question the store already has a live `decision` or `research_finding` for — always `knowledge_preflight` first.
- Reading a whole unfamiliar area yourself instead of dispatching `scout`.
- Reporting "nothing found" when a channel was simply not checked.
- Mixing inference into facts, or giving a versioned answer with no date.

## Related skills

- `decision-records` — once research resolves a question, record it as a durable decision or research_finding.
- `delegating-to-subagents` — for dispatching `scout` on the prior-art pass.
