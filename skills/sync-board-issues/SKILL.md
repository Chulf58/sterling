---
name: sync-board-issues
description: Mirror a project's user board tasks one way to GitHub issues in the project's own repo with bin/sync-board-issues.mjs, so a dashboard that reads issues (Nemlig's Clear View) shows tasks moving from to-do to done. Use when the user wants board tasks on GitHub, asks to sync tasks to issues, wants a done list for the business, or asks why an issue was or was not created, labelled or closed.
---

# Mirroring board tasks to GitHub issues

Decisions `board-to-github-issues-one-way-mirror-first-shared-board-later`, `board-issue-mirror-design-required-outcome-snapshot-read-single-writer`, `board-issue-mirror-skips-trackers-labels-origin-and-label-lifecycle` and `board-remove-records-outcome-and-evidence-in-a-removal-journal`. The command is `node "${CLAUDE_PLUGIN_ROOT}/bin/sync-board-issues.mjs" [--dry-run] [--project <dir>]`.

## 1. When to run it

Run it in a project whose board should show up as issues in the GitHub repo of its `origin` remote. Each run brings the issues in line with the board as it is now. It can run by hand or from a schedule.

- Without `--project` it uses the current directory. A linked git worktree reads the main checkout's board.
- It needs `gh` on PATH, logged in to the repo's host, with permission to create issues, comments and labels. Under WSL, `gh` is often the Windows `gh.exe`, which sees a `GH_TOKEN` set in WSL only when `WSLENV` lists it (anti-pattern `work-mode-pr-create-fails-with-must-be-a-collaborator-http-4`).

## 2. Dry run first

Run with `--dry-run` before the first real run in a project, and show the user what it prints. A dry run reads the board and the repo, prints every planned step (labels to create, issues to create, labels to add or remove, comments, closes) and any text drift, and writes nothing. Run for real after the user agrees.

## 3. What a run does

- Creates one issue per open user task. The title is the first line of the task text, and the body is the text plus three hidden markers: `<!-- sterling-key: board:<board item uuid> -->`, which ties the issue to the task, `<!-- sterling-project: <identity> -->`, which ties it to this project, and a hash of the text. The identity is the `project_id` in `.sterling/project.json` when the project has one, else `project_name` in `.sterling/config.json`, else the folder name. An issue written under the name stays the project's after it gains a `project_id`.
- Changes only issues that carry this project's marker. When several projects mirror into one repo, an issue with another project's marker, or a key with no project marker, is left alone and named in a `WARNING` line. No second issue is created for a task whose key such an issue already carries. The title and body are never edited afterwards. When the task text changes, the run prints a `text drift` line and leaves the issue as it is.
- Skips hand-off trackers (tasks handed to another project); the receiving project mirrors the task instead. A received task gets the label `from:<sending project>`. For a task already removed from the board, the removal journal says whether it was a tracker or a received task. Journal entries written by Sterling 0.19.130, before the journal kept that, are judged from the hand-off lines Sterling writes into a hand-off's text.
- Keeps two labels in step with the board, `in-progress` while a session holds a live claim on the task, and `blocked` while the board's readiness says blocked or waiting. Labels are the only thing a rerun changes on an open issue. A missing label is created; when the account may not create it, the run stops and says so.
- Closes the issue of a task that left the board. Outcome `done` closes it as completed, with one comment listing the evidence (commit, PR, deploy or URL). Outcomes `dropped`, `superseded` and `duplicate` close it as not planned, with a comment naming the outcome. A task that left the board with no journal entry also closes as not planned. Each closing comment carries `<!-- sterling-close: board:<uuid> -->`, and a rerun looks for it first, so a run cut off between the comment and the close never comments twice. Closing removes `in-progress` and `blocked` and keeps `from:`.
- A task that was added and removed between two runs gets an issue that is created and closed in the same run, so short tasks still reach the done list.
- Stops creating issues once the repo holds 200 issues (all states, pull requests not counted), because Clear View rejects a repo past that cap. Closing and labelling still run. The run then prints a `CEILING` line and exits 3.

## 4. What it never does

- Never reads GitHub back into Sterling, and never changes the board.
- Never reopens an issue, and never edits a title or body.
- Never mirrors maintenance-queue items.
- Never touches an issue without its key marker and this project's marker.
- Never retries a refused call. On an auth error or a rate limit it stops at once and names the `gh` binary it ran; a rerun starts from what GitHub then holds.
- Never schedules itself. A schedule (cron, a CI job, a Windows task) is the user's own.

## 5. When it refuses

Exit 1 with a message, before anything is written, when the board cannot be read (no store, a store on another schema version, or a store no Sterling session has opened since the removal journal shipped), when there is no `origin` remote or its URL is not a GitHub repo, when `gh` is missing or not logged in, when `.sterling/project.json` or `.sterling/config.json` cannot be read, when two of this project's issues carry the same marker (fix it by hand; the run will not pick one), or when another run for the same project and repo holds the run lock. An empty board is fine: closures backed by the journal still run.

Exit codes: 0 done, 1 refused or failed, 2 a usage error, 3 done but some tasks got no issue because of the 200-issue cap.
