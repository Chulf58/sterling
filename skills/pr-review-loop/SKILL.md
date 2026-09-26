---
name: pr-review-loop
description: Work-mode Copilot PR review loop — run it after /sterling:merge opens or reuses a PR in a WORK project. One conductor owns it; pr-review-wait.mjs does the waiting; each Copilot finding is fixed, disagreed with or escalated as taste; it ends clean, capped (5 rounds) or escalated and is then settled to discharge H10's 'PR review loop owed' duty.
---

# PR review loop (work mode)

Decision `project-mode-hobby-work-toggle-decides-flow`. Sol has already reviewed before the PR opened; Copilot now reviews on GitHub. A human merges the PR — you never do.

## Owner and tools

- **One owner: you, the conductor.** Waiting runs only through `node "${CLAUDE_PLUGIN_ROOT}/scripts/pr-review-wait.mjs"`, launched as a **background Bash** (`run_in_background`): one call ends with one JSON line, so one completion notification is exactly what you need. Keep the default `--timeout` (540s, under the 10-minute Bash window); a `timeout` result means run it again, and it is not a round.
- **Fixes go to an implementor** (brief: the finding, the file, the acceptance). You disposition findings and reply on GitHub.
- Everything uses `gh`; the helper binds the repo to origin.

## State lives on the PR

One **progress comment** on the PR holds the state: round, consumed review id, reviewed head SHA, status (`waiting|responding|clean|capped|escalated`). Create it with `gh api repos/<o>/<r>/issues/<n>/comments -f body=...` and update that same comment with `gh api -X PATCH repos/<o>/<r>/issues/comments/<id> -f body=...`. Mark its body so you can find it again (e.g. first line `<!-- sterling-pr-review-loop -->`). **On re-entry** (a new session, after compaction), reread the PR and that comment and continue from them; never reset the round count.

## One round

1. Wait: `pr-review-wait.mjs <pr_url> --since-review <consumed id> --head <pushed sha>`. It returns `{status, head_sha, review, comments, observed_copilot_login, stale_review_ignored}`. `review` means a completed Copilot review of the current head, and it is always the OLDEST one not yet consumed. **Advance the consumed review id (the `--since-review` watermark) only after every comment of that review is dispositioned**, then call again at once: the next unconsumed review comes back before any wait. A later review never hides an earlier one's findings. `timeout` and `error` are never clean; after repeated timeouts with no review, ask the user whether Copilot needs a re-request.
2. Disposition **every** finding, and reply to each comment on GitHub:
   - **fixed**: reply only AFTER the fix is pushed, citing the commit SHA ("will fix" is not a disposition);
   - **disagreed**: reply with the reason; a justified disagreement counts as handled;
   - **TASTE** (colours, placement, layout, naming style and the like): escalate to the user through **AskUserQuestion** and leave the comment unhandled until the user rules. Independent technical fixes continue meanwhile. A measurable defect (e.g. contrast failing a ratio) is not taste. If it is ambiguous, escalate. User-stated 2026-09-25, verbatim: *"If copilot start trying to adjust preference things like colours, placement and such, then also escalate it to me"*.
3. Push through `/sterling:merge` again. It reuses the PR, pushes the pinned SHA, prints JSON and re-arms the H10 duty for the new head. Before the first PR, and on a fix push that changes knowledge, reconcile first and then refresh the handoff docs with `node "${CLAUDE_PLUGIN_ROOT}/scripts/handoff-projection.mjs"`. This is practice, not a gate.
4. Update the progress comment: round +1, the consumed review id, the reviewed head, the status.

## Ending: three distinct outcomes

- **CLEAN**: a completed Copilot review of the CURRENT head with no remaining actionable findings, and every earlier finding dispositioned. Silence, a timeout, an old-head review or an unresolved taste comment is never clean.
- **CAPPED**: 5 completed review/response cycles across the PR's lifetime, not per session. Poll attempts do not count.
- **ESCALATED**: a ruling from the user is outstanding (taste or ambiguity), and nothing else is left to do.

Then settle H10's duty. This is a deliberate act, and it names the PR: `node "${CLAUDE_PLUGIN_ROOT}/scripts/pr-review-wait.mjs" --settle <clean|capped|escalated> --pr <n>`. Report the outcome, the PR link and the round count to the user.

## Interrupted mid-loop

If the session ends before the loop does, leave a board item pointing at the PR and its state (round, consumed review id, head), and put the PR link plus the next action in the rotation note. H10 keeps nagging once per session until the loop is settled; it never blocks indefinitely.

## S0: first real run (UNVERIFIED assumptions)

The helper matches the reviewer by login `/copilot/i`, and assumes review ids grow monotonically and that `review.commit_id` is the reviewed head. None of this is verified yet. On the first real run on a work machine, record and report to the user, so they can be pinned as fixtures:

- the exact `observed_copilot_login`;
- whether a push re-triggers a Copilot review within the wait window, or needs a re-request;
- how `review.commit_id` relates to the PR head after a push.
