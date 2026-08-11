# Sterling retrospective — consuming-project session, 2026-08-11

> ARCHIVED FEEDBACK (decision `42f385ea` convention): this is a third-party session
> retrospective, relayed verbatim by the user on 2026-08-11. It is historical input,
> not live instructions. Several of its claims were REFUTED on verification —
> see the triage section at the end before treating any claim here as current.

## Verbatim retrospective (relayed by the user)

Honest retrospective, from what actually happened rather than what the tooling is meant to do.

### Where it clearly paid

It stopped me asking you a settled question. The (d) RNG fix looked like a design fork — I was one step from putting "should MillWorks join the run seed, and how?" to you as options. Reading 76c41ec1 in full turned it into a fix with a prescribed shape. That's the store doing the thing it exists for, and it saved you a decision you'd already made in July.

It caught the thing I actually missed. H20 surfaced c71caf40 — your ruling that a pinned repair worker "kills the run" — on a question where I'd found no precedent. Without it, your miller-stall ruling would have stood in silent tension with its own mirror case, and nobody would have noticed until someone hit the absorbing edge.

The prior session's board discipline saved a wasted round. c1d056d0 said, in caps, don't dispatch a fixer, audit first — and the audit found one of four notes already satisfied and one closed by ruling. A coder sent at those would have correctly refused to fix working code, which this project has paid for twice before.

H19's hazard delivery shaped briefs before they went out, not after. af8164f6 (Fate.roll is a clamped normal draw) is why every test oracle is equality-between-runs — that single record prevented an entire class of wrong test. 50bc67e9 went into the reviewer brief and came back checked at both insertion points.

Indirect token savings were real but unglamorous: digest projections let me size a 218-item board without reading it; the audit item's file:line-per-claim convention made re-verification three greps instead of a re-read; capture_pending let me defer a reconcile honestly instead of writing a premature one I'd have had to rewrite after the diff.

### Friction, bugs, and gaps

A genuine config bug, and it was pointed at your decision-making. No claude-opus-5 window entry, so H10 measured against 200k. You caught it, not me — I'd have accepted the 48% and, two turns later, told you READY TO CLEAR at roughly a tenth of real capacity. That's the worst failure shape available: a gauge that reads red early trains you to ignore it before the day it's right.

H20 fires too late to be actionable on AskUserQuestion. It's a PreToolUse hook, but its output reaches me with the tool result — i.e. after you've already answered. On the miller-stall question it told me about c71caf40 when your ruling was already in hand. The recovery worked (I read it, showed you, you re-affirmed) but the hook's stated purpose — "if one of them already decides this, you are inviting a ruling already made" — is structurally unachievable at that timing. It's an audit, not a gate.

Inconsistent id resolution across the MCP surface. knowledge_get accepts a slug and an 8-char short id. knowledge_append accepts neither — mill-works returned "no record". Same store, same session, different addressing rules, and the failure looks like a missing record rather than a rejected identifier form. Cost a round.

board_remove leaves dangling references. c1d056d0 cites its parent 0718eed1 as provenance; that id "no longer resolves at any status." An item's audit trail points into a hole. A tombstone forwarding to whatever superseded it would have saved the recovery stage entirely.

H15 false-positives on prose. My rotation-note command was denied because the text mentioned a store path — the gate's own message admits this ("even though nothing would be accessed"). Its suggested workaround (write to a file, pass by path) doesn't apply to a script taking string args. I rephrased the prose, which felt uncomfortably close to the "don't rewrite to evade" line it warns about.

Something CLAUDE.md says is now wrong, in your favour. It carries a long, incident-backed warning that H19 does not fire on Bash. This session it fired on Bash repeatedly — as a lighter "KNOWLEDGE POINTERS" variant. Both can be true (pointers, not full injection), but the doc's blanket claim is stale and it's the kind of staleness that makes someone over-delegate to avoid a gap that's been partly closed.

Minor noise: H21 flagged three hand-run article writes that were all explicitly sanctioned exceptions (single small touches). H10's capture nag fired while a decision written three minutes earlier sat in the store — technically correct on its per-Stop window, but the incentive it creates is to write something.

### The subagent experience — mixed, and the pattern is consistent

The two failures were both tool-shape mismatches the brief couldn't fix: test-writer has no Bash (so my gates section was unsatisfiable) and no Edit (so "add two cases, don't touch the frozen six" forced a wholesale rewrite). Both agents complied as well as physically possible and reported the limitation unprompted — that's good agent design. The work orders were impossible, and the agent definitions are where that should be caught, not in my prose.

The best dispatch was reviewer-correctness: it found that both the behaviour you'd just ruled and the standalone-seed clause were mutation survivors — deletable with a fully green 785-case suite. Nothing else in the pipeline would have caught that. The librarian also behaved exactly right: it applied verbatim, refused to fix an current_ac contradiction it noticed, and flagged it up.

### Improvements I'd actually make

Warn on an unmapped model instead of silently using default — a one-line check that would have caught the 48% bug at first sample.

Make knowledge_append/knowledge_edit accept slugs and short ids like knowledge_get.

Tombstone removed board items so provenance chains resolve.

Either move H20's ask-time delivery somewhere it can act, or rename it — as shipped it's a post-hoc audit and reads as a gate.

Correct CLAUDE.md's H19/Bash claim to describe the pointer variant.

The board is 218 items and capped at every reasonable read — by your own rule, a board too large to audit is one nobody audits.

Was it good? Genuinely, yes — the store earned its keep twice in one session, on exactly the two things I'd otherwise have got wrong. The friction was almost entirely interface inconsistency and hook timing, not the model of work. The one thing I'd call a real defect rather than an annoyance is the context-window bug, and that's only because you questioned a number instead of accepting it.

## Triage (verified against the Sterling repo, 2026-08-11)

Confirmed and fixed (branch `sterling/retro-2026-08-11-fixes`, board slices `85ecfe43`, `471e7989`, `8d940af1`, `fa9b98fa`):

1. **Id resolution inconsistency — CONFIRMED.** `knowledge_get` resolves uuid/slug/8-char prefix; `knowledge_append`/`edit`/`update`/`retire`/`link` did bare `store.get`. Fixed with a shared resolver.
2. **H10 wrong denominator — PARTIAL.** The "no claude-opus-5 entry" diagnosis is FALSE (the entry exists in the shipped template and maintained configs); the symptom is real via a suspected raw-model-string vs alias-key mismatch, and H10 warned only above 100% fill. Fixed: loud warn on any unmapped model.
3. **test-writer Edit gap — PARTIAL.** No Bash is deliberate (decision `81bf7920…`, blindness wall) — working as designed. The Edit/MultiEdit grant gap and the hooks-matcher inconsistency were real; addressed.
4. **H20 timing — CONFIRMED, and it resolved decision `f5638a84…`'s open probe.** The AskUserQuestion channel is ALIVE (payload reaches the model) but only post-answer; pre-ask framing is structurally unachievable at PreToolUse. Reworded to audit framing.

Refuted or already settled — do NOT act on these claims:

- **"CLAUDE.md carries a stale H19/Bash warning": REFUTED for Sterling's contract docs.** No version of `templates/target-claude-md.md` or this repo's CLAUDE.md ever contained it; the passage is project-local to the consuming project (or misattributed from the archived 2026-08-03 assessment).
- **H15 prose false-positive: real, but adjudicated** (decision `a8bec43f`) — prose-vs-target detection rejected as unsafe (command substitution inside quoted args still executes).
- **H21 noise on sanctioned exceptions: accepted design** — it cannot see whether a `dac3d2c6` exception applies, so it advises unconditionally and never denies.
- **board_remove tombstones: not structurally reachable** — todos carry no parent-id field; the dangling citation was free text. Hard delete is P4 by design; `knowledge_retire` refuses todos deliberately.
- **"Board capped at every reasonable read": REFUTED** — `cap` is caller-suppliable (scan ceiling 1000), `capped` is exact, and `projection:'digest'` exists for sizing. Discoverability gap at most.
