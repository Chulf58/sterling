# Sterling retrospective — authoring-repo self-session, 2026-08-20

> SELF-RETROSPECTIVE (decision `42f385ea` tracking convention): this is written by the
> AUTHORING repo's own conductor, mid-campaign, on the authoring repo itself — not a
> consuming-project relay. Its claims describe branch `sterling/feedback-aug-2026-fixes`
> at commit `acc11a2` and are current to that point, not to `main`.

## The session

One conductor-direct session on the authoring repo: ~25 commits, ~35 subagent dispatches
(test-writers, coders, librarians, explorers, 2 opus reviewers). 24 of 38 feedback-batch
board tasks closed. Full suite went 948 → 1056 tests. The delegation ceiling was raised
5 → 15 mid-session as parallel lanes proved themselves. Two user rules were adopted
in-flight: doer ≠ checker, and parallel lanes.

This is a working session's honest account, written before the campaign closes — not a
final tally. The six structural gaps it surfaces are already boarded (see Missing, below);
this document is their evidence trail, not a substitute for closing them.

## Worst: id churn

The H10 article passed through **six ids in one session**. Every librarian batch had to
re-resolve its targets against whatever id the article held by the time the batch ran.
Slugs are carrying the addressing load that ids were supposed to carry — they are the
workaround, not the design. This is the single worst mechanical friction of the day:
not a bug in any one write, but a design gap that made every write to that record a
small hazard, and made "which id do I cite" a live question instead of a settled one.

## Costly

**(1) Delivery volume vs hit rate.** 60+ H19/H20 deliveries fired over the session,
at roughly 1-in-5 useful. Each delivery costs 1–3k tokens whether or not it lands, and
the volume was a real driver of the hard context pressure hit mid-session. The hits,
when they landed, were excellent — settled rulings surfaced before being contradicted,
which is exactly the failure mode the mechanism exists to prevent. The problem is not
that the good deliveries aren't good; it's that four bad ones are paid for every one
useful — no ranking or relevance trim exists to change that ratio.

**(2) Gates colliding with orchestration.** Roughly 3 dispatches were degraded by a gate
firing correctly but with no cheap way through:

- A coder burned ~205k tokens against a torn reads-ledger. H3 fail-closed on corrupt
  state, which is the right call — the corruption was real, caused by concurrent Read
  hooks tearing the file under concurrent access on DrvFs. Root-caused live, same
  session, and fixed with a self-heal plus tmp/rename write. But the coder paid the
  full token cost of the failure before the fix landed.
- `sync-agents` was blocked by H14. The denial was correct on its own terms.
- In both cases: the gate did its job, but there was no cheap "this is an environment
  defect, not a violation" escape hatch. Every degraded dispatch cost real tokens to a
  correct-but-expensive refusal.

**(3) Stop-hook nags under fan-out.** `capture_pending` declared itself three separate
times for the same underlying reason — in-flight lanes not yet settled. The hook has no
way to see that the reason is unchanged since the last time it fired, so it re-nags on
every Stop rather than once per state.

## Worked, but could work better

- **Frozen blind tests caught a real defect nobody asked about**: H14 had a traversal
  hole that surfaced only because the test-writer, working blind from the brief and
  ACs, wrote a case that happened to exercise it. This is the TDD-by-default rule
  paying for itself in exactly the way it's supposed to.
- Of the frozen-test defects found, 4 were old-pin-vs-new-spec conflicts that needed
  conductor adjudication rather than resolving themselves — the blind-authoring
  discipline surfaces real conflicts, but someone still has to rule on them; it does
  not remove that cost, only relocates it to where it's cheaper to pay.
- **Store primitives and refusal messages are strong** — where the store said no, it
  said no with enough detail to fix the call without a round trip.
- **The oversize article problem persists**: `mcp-tool-surface` is 74k characters and
  nags on every append, with no remedy tool offered. The nag is correct (the article
  really is too large to round-trip) but there is nothing to do about it in the moment
  except keep appending to an article everyone agrees is already too big.
- **H20's catches were the best thing all day.** Its live self-catches during this very
  session included the feedback-filing decision and a settled-ruling contradiction —
  it caught the session second-guessing itself in real time, which is the mechanism
  working exactly as designed, on its own record, not a downstream one.

## Missing

- **A lane concept for N concurrent writers.** Nothing today models file-set claims or
  build-slot serialization between concurrently dispatched agents. One real collision
  occurred this session for lack of it.
- **Doer ≠ checker as a mechanism, not a habit.** Reviewers found 3 merge-blocking H15
  holes — but only because the user explicitly ordered a review pass. Nothing in the
  system requires that separation; it worked because a human insisted on it this time.
- **A wave-settle primitive.** No in-flight-writer tracking exists for projections or
  bundles, which is the root cause behind both the lane-collision gap and the
  triple-firing capture-pending nag above — different symptoms of the same missing
  primitive.

All six MISSING/COSTLY structural items were boarded on 2026-08-20 under objective
`feedback-aug-2026`:

| item | board id |
|---|---|
| lane concept | `b6a355f4` |
| doer ≠ checker | `d3752b2e` |
| wave-settle primitive | `54c451b4` |
| H20 rank/trim | `b6214ea9` |
| environment-defect escape path | `c7b81456` |
| fan-out-aware registers | `570832d4` |

## Meta-observation: the session ate its own dog food

Three of the day's shipped fixes — the H15 newline splitter, heredoc handling, and the
reads-ledger self-heal — were defects **caught live** by the session's own use of the
freshly shipped code, minutes after shipping it. This is the loop the whole
reconcile-always / fix-forward discipline is meant to produce, and it worked: ship,
use, catch, fix, same session, no separate discovery pass required.

## Bottom line

The session was productive by volume (24/38 board items, +108 tests, a tripled
delegation ceiling that held) and the mechanisms that are supposed to catch real
problems did catch real problems — H14's traversal hole and H20's live self-catches
are the clearest evidence the model of work is sound. The costs were concentrated in
exactly three places: an id-addressing design that hasn't caught up to how often
records get rewritten mid-session, a delivery mechanism tuned for recall over
precision, and a set of gates that are individually correct but have no cheap path
around them when the thing they're blocking is an environment defect rather than a
violation. None of the three is a defect in judgment; all three are places where the
mechanism needs a primitive it doesn't have yet. The six board items above are that
list, not a promise that the list is complete.
