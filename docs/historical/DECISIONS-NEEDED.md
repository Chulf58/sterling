> **RETIRED 2026-07-12** (R2-AUDIT board c7053df5, the b7ce8798 precedent): build-era
> document, NOT authoritative — deferred decisions live in the knowledge base
> (the deferred/optional register is decision f6283a11, whose item (5) carries
> this file's one open item verbatim; no `STERLING-DEFERRED` code markers exist
> in the repo). Kept verbatim below for history only.

# DECISIONS-NEEDED — deferred decisions awaiting human review

Per the deferred-decision protocol: gaps/platform deltas where the most
conservative spec-faithful reading was implemented and work continued. Each
open code site is marked `STERLING-DEFERRED`.

## Open

6. **Per-phase judgment completeness** — decision order locked in §17.
   Half (1) "structure first" is BUILT: handoff `subtask_evidence`
   (subtask → diff files + tests) + the completeness script verifies every
   phase subtask is cited, cited files/tests exist, and cited tests pass
   (latest handoff per role supersedes earlier fixer attempts). Half (2),
   the Haiku citation-honesty classifier, is added ONLY if real runs show
   dishonest citations slipping past reviewers — revisit after the first
   real runs. (3) coder-tier never judges its own completeness.

## Resolved (adjudicated 2026-06-11, folded into the spec)

1. H11 command-hook fallback — approved; §6 H11 mechanism stands as built.
2. H12 dormancy source = the captured article's declared state — approved.
3. Plan-mode-shaped — approved; resolved into §16.2 step 8. The
   `STERLING-DEFERRED(plan-mode)` marker in skills/planning was removed.
4. Mutation capability deferral — approved; moved to the §17 register.
5. TUI renderer — superseded by evidence: §2.1 now mandates terminal-kit
   with a pure tested state layer; implemented (state.ts + thin renderer,
   native mouse: click-to-expand, right-click collapse, wheel scroll).
