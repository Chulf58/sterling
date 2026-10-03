---
name: pr-review-loop
description: Work-mode Copilot PR review loop — run it after /sterling:merge opens or reuses a PR in a WORK project. One conductor owns it; pr-review-wait.mjs does the waiting; each Copilot finding is fixed, disagreed with or escalated as taste; it ends clean, capped (5 rounds) or escalated and is then settled to discharge H10's 'PR review loop owed' duty.
---

# PR review loop (work mode)

Decision `project-mode-hobby-work-toggle-decides-flow`. Sol (the `reviewer` agent on Opus when Sol is capped) has already reviewed before the PR opened; Copilot now reviews on GitHub. A human merges the PR — you never do.

## Owner and tools

<!-- claude-only -->
- **One owner: you, the conductor.** Waiting runs only through `node "${CLAUDE_PLUGIN_ROOT}/bin/pr-review-wait.mjs"`, launched as a **background Bash** (`run_in_background`): one call ends with one JSON line, so one completion notification is exactly what you need. Keep the default `--timeout` (540s, under the 10-minute Bash window); a `timeout` result means run it again, and it is not a round.
<!-- /claude-only -->
<!-- opencode-only -->
On OpenCode, the owner-and-waiting bullet reads as follows.
- **One owner: you, the conductor.** Waiting runs only through `node "${CLAUDE_PLUGIN_ROOT}/bin/pr-review-wait.mjs"`, run detached in the shell (there is no `run_in_background` flag, and nothing notifies you when a detached process ends). Remove the last output, then launch: `mkdir -p .sterling/transient && rm -f .sterling/transient/pr-wait.json && nohup node "${CLAUDE_PLUGIN_ROOT}/bin/pr-review-wait.mjs" <args> > .sterling/transient/pr-wait.json 2> .sterling/transient/pr-wait.err < /dev/null &`. The helper ends with exactly one JSON line, so the wait is over when `pr-wait.json` holds that line: check it between other work or with a short shell call (`sleep 30; cat .sterling/transient/pr-wait.json`). Keep the default `--timeout` (540s); a `timeout` result means run it again, and it is not a round. Whether a detached child outlives the shell tool call is unmeasured on OpenCode 2.0.21: if the output file stays empty and `pgrep -f pr-review-wait` finds no process, the child died with the call, so run the helper in the foreground with a `--timeout` below the shell tool's call limit instead, and rerun on `timeout`.
<!-- /opencode-only -->
- **Fixes go to an implementor** (brief: the finding, the file, the acceptance). You disposition findings and reply on GitHub.
- Everything uses `gh`; the helper binds the repo to origin.

## State lives on the PR

One **progress comment** on the PR holds the state: round, consumed review id, reviewed head SHA, status (`waiting|responding|clean|capped|escalated`). Create it with `gh api repos/<o>/<r>/issues/<n>/comments -f body=...` and update that same comment with `gh api -X PATCH repos/<o>/<r>/issues/comments/<id> -f body=...`. Mark its body so you can find it again (e.g. first line `<!-- sterling-pr-review-loop -->`). **On re-entry** (a new session, after compaction), reread the PR and that comment and continue from them; never reset the round count.

## One round

1. Wait: `pr-review-wait.mjs <pr_url> --since-review <consumed id> --head <pushed sha>`, adding `--request-copilot` after each fix push (see step 3). Pass the full sha; a short one (7-40 hex characters) is accepted and matched as a prefix, anything else is refused. It returns `{status, head_sha, review, comments, previously_missed, body_findings_without_comments, copilot_request, observed_copilot_login, stale_review_ignored}`. `review` means a completed Copilot review of the current head, and it is always the OLDEST one not yet consumed. **The helper keeps only reviews of the current head** (`scripts/pr-review-wait.mjs`, `poll()`): a review of an earlier head is dropped and only flagged through `stale_review_ignored`. So carry undispositioned findings from earlier heads forward yourself: before each push, note every finding of a consumed review that is not yet dispositioned; and when `stale_review_ignored` is true, list the PR's reviews by hand (`gh api repos/<o>/<r>/pulls/<n>/reviews`) and disposition any earlier-head review the helper skipped. The helper will never return either again. **Advance the consumed review id (the `--since-review` watermark) only after every comment of that review is dispositioned**, then call again at once: the next unconsumed review comes back before any wait. A later review never hides an earlier one's findings. `timeout` and `error` are never clean. After repeated timeouts with no review, ask the user about a re-request only if `copilot_request.requested` was false (the mutation failed); if it succeeded, Copilot was asked and the wait just needs to run again.
   **Read the review body, not only `comments`.** Copilot can put findings in the body (a "Previously missed" section) with no inline comments. A review whose `comments` is empty but whose `previously_missed` is non-empty is NOT clean: disposition each listed finding. `body_findings_without_comments: true` (any non-blank body with no inline comments) is also NOT clean until you have read the body yourself, because the format is Copilot's and may change; a body that is only an overview with no finding may then be called clean.
2. Disposition **every** finding, and reply to each comment on GitHub:
   - **fixed**: reply only AFTER the fix is pushed, citing the commit SHA ("will fix" is not a disposition);
   - **disagreed**: reply with the reason; a justified disagreement counts as handled;
   - **TASTE** (colours, placement, layout, naming style and the like): escalate to the user through **AskUserQuestion** and leave the comment unhandled until the user rules. Independent technical fixes continue meanwhile. A measurable defect (e.g. contrast failing a ratio) is not taste. If it is ambiguous, escalate. User-stated 2026-09-25, verbatim: *"If copilot start trying to adjust preference things like colours, placement and such, then also escalate it to me"*.
3. **Only if this round's fixes produced a new head**, push through `/sterling:merge` again. Push the fix straight back to Copilot — no Sol, Opus or other reviewer re-checks a loop fix round; Copilot is the reviewer inside the loop (user-stated 2026-09-28: "co-pilot is the reviewer"). The one Sol review (the `reviewer` agent on Opus when Sol is capped) happens before the PR is opened. A round with no fix commits (every finding disagreed with or escalated) is dispositioned directly: no push and no re-arm, and the next wait keeps the same `--head`. The push reuses the PR, pushes the pinned SHA, prints JSON and re-arms the H10 duty for the new head. Copilot does not review the new head until it is re-requested, so the next wait passes `--request-copilot`: it fires the GraphQL `requestReviewsByLogin` mutation once before polling and records `copilot_request` as `{requested: true}` or `{requested: false, error}`. A failed request never aborts the wait; it is the one case that goes to the user, who is asked whether to re-request by hand. Before the first PR, and on a fix push that changes knowledge, reconcile first and then refresh the handoff docs with `node "${CLAUDE_PLUGIN_ROOT}/bin/handoff-projection.mjs"`. This is practice, not a gate.
4. Update the progress comment: round +1, the consumed review id, the reviewed head, the status.

## Ending: three distinct outcomes

- **CLEAN**: a completed Copilot review of the CURRENT head with no remaining actionable findings, and every earlier finding dispositioned. Silence, a timeout, an old-head review or an unresolved taste comment is never clean.
- **CAPPED**: 5 completed review/response cycles across the PR's lifetime, not per session. Poll attempts do not count.
- **ESCALATED**: a ruling from the user is outstanding (taste or ambiguity), and nothing else is left to do.

Then settle H10's duty. This is a deliberate act, and it names the PR: `node "${CLAUDE_PLUGIN_ROOT}/bin/pr-review-wait.mjs" --settle <clean|capped|escalated> --pr <n|PR URL>`. It refuses unless the armed loop is still owed, is for origin's repo and is the PR you name; a settled loop is never re-settled (the next `/sterling:merge` push re-arms it). Report the outcome, the PR link and the round count to the user.

## Interrupted mid-loop

<!-- claude-only -->
If the session ends before the loop does, leave a board item pointing at the PR and its state (round, consumed review id, head), and put the PR link plus the next action in the rotation note. H10 keeps nagging once per session until the loop is settled; it never blocks indefinitely.
<!-- /claude-only -->
<!-- opencode-only -->
On OpenCode, if the session ends before the loop does, leave a board item pointing at the PR and its state (round, consumed review id, head), and put the PR link plus the next action in the rotation note. The Sterling plugin raises a 'PR review loop owed' notice at the end of each execution until the loop is settled (the full next action the first time after OpenCode starts, a short reminder after that); it never blocks.
<!-- /opencode-only -->

## S0: first real run (UNVERIFIED assumptions)

**Identity.** The reviewer must be a Bot account (`user.type` `Bot`). Until `.sterling/config.json` `pr_review.copilot_logins` lists the exact login, the helper accepts any Bot login matching `/copilot/i` and reports `identity_confirmed: false`. With an unconfirmed identity, **confirm the observed login with the user (AskUserQuestion) before the first CLEAN**; once confirmed, pin it in `pr_review.copilot_logins`, and from then on only that login counts.

The helper matches the reviewer by a Bot login `/copilot/i` while unpinned, and assumes review ids grow monotonically and that `review.commit_id` is the reviewed head. None of this is verified yet. On the first real run on a work machine, record and report to the user, so they can be pinned as fixtures:

- the exact `observed_copilot_login`;
- whether `--request-copilot` after a push gets a Copilot review of the new head within the wait window (without it, a push alone does not);
- how `review.commit_id` relates to the PR head after a push.
