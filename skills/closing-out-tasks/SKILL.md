---
name: closing-out-tasks
description: Use before declaring any substantial task done — after implementing, fixing, configuring, or any work that changed files. Triggers on "done", "finished", "wrap up", "ship it", "call it complete", or the natural end of a work thread. The finish-line discipline — fresh verification evidence, a cleanup sweep, then capture into the knowledge store or the board, never collapsing the three surfaces. Applies to direct conductor work just as much as dispatched work.
---

# Closing out tasks

An agent (or a conductor) stops when the work *looks* done. Without a check it can run, "looks done" is the only signal it has. This skill is the standing gate between "looks done" and "is done".

Run it before the final response on anything that changed something. Skip it for pure Q&A and trivial one-line edits where the diff is the evidence.

## Gate 1 — Evidence

Done is a claim about the world, so back it with the world:

- Run the **narrowest meaningful check first** (the failing test, the one affected command), then the broader gates the repo convention expects (typecheck, `npm run check`, targeted suite).
- Run checks **in this session, after the last edit**. A pass from before your final change is not a pass. A predicted or remembered pass is not a pass.
- **Paste the actual command and its actual output**, or the relevant tail of it. "Tests pass" with nothing attached is an assertion, not a result.
- A new test must be shown to **fail without the fix** — self-written tests that only ever passed are weak evidence.
- If a gate cannot be run here, say `not run: <reason>` and state the residual risk explicitly. Never imply a check passed that you did not run.
- Re-read the final diff once with fresh eyes before closing: debug output, commented-out code, `TODO` markers, accidental scope creep, files touched the task didn't ask for.

Done also has a ceiling: **done means the acceptance criteria are met, not that the code is perfect.** If real, frozen criteria exist on a board item, closing it must satisfy them verbatim — never invent or loosen criteria that were never actually stated. If criteria are met, stop — record improvement ideas as follow-ups instead of gold-plating past the request.

## Gate 2 — Cleanup sweep

Leave no droppings.

| Surface | Check |
|---|---|
| Worktree | `git status` matches intent — no stray untracked scratch, no probe/test files, no reverted-but-forgotten edits. Remove temp scripts and fixtures you created unless they were the deliverable. |
| Scratch dirs | Delete session scratch you no longer need. |
| Processes | Kill background servers, watchers, port-forwards you started. |
| Temporary config | Restore anything changed "just for now": env vars, feature flags, test skips. |
| Live todo list | Close or cancel every session-scoped entry; add an explicit follow-up item for anything genuinely deferred. It dies with the session and is not where durable follow-up work belongs. |

## Gate 3 — Capture: three surfaces, never collapsed

This is where Sterling's own contract differs sharply from a generic close-out — read it carefully, because collapsing these three is drift, not a shortcut.

- **The board** (`board_add`/`board_update`, `source: "user"`) — real work the user wants done. The only surface for wanted-but-not-done work. An item leaves it *only* through the artifact-write that fulfils it: `board_remove`, citing the commit that paid it (close-on-commit) — never by being called done in conversation.
- **The maintenance queue** (`board_query source:"system"`, drained by `/sterling:drain`) — mechanism-detected debt, every item carrying a registered `system_reason` (`reconcile_needed`, `capture_owed`, `article_missing`, …), minted by the event that detected it and removed by the artifact that closes it. Never hand-park a "remember to do X" item here — that belongs on the board. Closing an item you did not actually fulfil makes the store lie.
- **The knowledge store** (`knowledge_create`/`knowledge_update`, conductor-only, direct — see `decision-records`) — durable facts, decisions, and reconciled article state. Most tasks produce nothing durable here; the bar is **will this matter in a month to someone who wasn't in this session?**

When a finding clears that bar, put it in the right place and link rather than duplicate. A read-only or write-scoped agent (`researcher`, `scout`, `implementor`) stays out of the store and the board by role — it names a **capture candidate** in its report; only the conductor decides whether to write it, and does so directly.

**Reconcile is part of this gate, not a separate afterthought.** Every affected `feature_article` — the one owning the touched files *and* any whose described behavior the change invalidates (follow `relies_on`/`relied_by`) — gets updated before the work is done. The articles most often forgotten are the ones owning files the conductor edited *by hand*, not through a dispatched agent — a subagent's report names its files for you; your own edits produce no such report. Before the reconcile batch, `git diff --name-only` against the merge base and ask which paths no agent report mentioned — that set is your hand-edits, and each needs its owning article found deliberately.

## The final message

Operational, not celebratory:

```text
What changed:   files/behavior, one line each
Verification:   command -> actual result (or "not run: reason" + risk)
Cleanup:        scratch/process/todo sweep done; anything left on purpose
Captured:       board item(s) closed, knowledge record(s) written/reconciled,
                or maintenance items drained — or "none"
Residual risk:  what remains unverified or deferred
```

## Anti-patterns this gate exists to catch

| Smell | Reality |
|---|---|
| "All tests pass" with no output shown | Nothing was run |
| Verification ran before the last edit | The final state is unverified |
| Green suite via a weakened/skipped test | The failure was hidden, not fixed |
| A board item called "done" in chat but never `board_remove`d | The board still lies about what's owed |
| A maintenance item closed with no fulfilling write | The queue lies about what debt was paid |
| Follow-up work left only in the closed session todo | The durable surface never heard about it — lost |
| A knowledge record written for every tiny task | Recall drowns in noise |
| An article reconciled but a sibling article the change also invalidated left untouched | The store still partly lies |
