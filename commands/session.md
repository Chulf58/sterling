---
description: Open an extra parallel session in this project — creates a git worktree on its own branch, sets up OpenCode there and prints the command that starts the session; --window opens it in a tmux window under the multi_session cap; --remove retires a finished one.
---

Several sessions can work one project at once, each in its own git worktree and branch, all sharing the project's one board and store (decision `parallel-sessions-in-one-project-run-one-per-git-worktree-sh`). From the project (any Sterling project, not only Customer Hub):

```
node "${CLAUDE_PLUGIN_ROOT}/bin/open-session.mjs" [--name <label>]
```

It resolves the main checkout (the target may itself be a linked worktree; `--target <project>` names another project), then:

- creates the worktree at `<main>/../<project>.worktrees/<label>` on a new branch `session/<label>`, cut from the default branch. `--name` defaults to the first free `session-2`, `session-3`, and so on. The worktree is a sibling of the main checkout, never inside it: a nested worktree shows up as untracked content in the main checkout and confuses every lookup of which checkout a command runs in.
- copies the main checkout's `.sterling/config.json` into the worktree for the duration of the setup only (it is gitignored, so a fresh worktree has none and the OpenCode agents could not be pinned to the configured models), runs the same OpenCode setup `/sterling:update` runs, aimed at the worktree, and deletes the copy again, also when the setup fails. A config in the worktree would make it look like its own Sterling root, so the main checkout's config stays the only one. The setup writes the untracked `.opencode/opencode.json` and the Sterling agents there.
- prints the command that starts the session: `cd "<worktree>" && opencode`. Start the session there. Never move an existing session into the worktree: the move loses the Sterling conductor agent (anti-pattern `moving-an-opencode-session-into-a-git-worktree-loses-the-sterling-agent`).

It does not run `npm install` or link `node_modules` into the worktree. A session that needs a build there makes its own real `node_modules`.

It refuses, with exit 2 and a message naming the cause, when the directory is not a git repository, when the worktree path or the branch `session/<label>` already exists, or when the label has characters other than letters, digits, `-` and `_`. When OpenCode 2 is not installed, or the setup refuses a file, the worktree already exists: it says so, exits 2, and tells you to fix the cause, run `--remove <label>` and open the session again.

## --window: open the session in a tmux window

`/sterling:session --window` (Linux and WSL with tmux only) creates the worktree as above, then starts its OpenCode conductor in a tmux session of its own. It needs the multi-session toolkit on for the project (`multi_session.enabled`, decision `sterling-ports-ch-hub-s-whole-multi-session-toolkit-session`). Run the two steps in order:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/open-session.mjs" [--name <label>] [--create-session]
node "${CLAUDE_PLUGIN_ROOT}/bin/open-session-window.mjs" --name <label> [--session <ses_id>] [--detached] [--dry-run]
```

Pass the label the first step printed. With `--create-session` in the first step, pass the printed session id as `--session`. `--checkout <folder>` names the worktree by path instead of `--name`, and `--target <project>` names another project, as for open-session. The window starts OpenCode in the worktree (`tmux new-session -c <worktree>`), never moved there, and is named as the worktree's own `sterling-launch.sh` would name its OpenCode session. The script prints one JSON line.

`multi_session.max_sessions` caps how many checkouts of the project may hold a session when this launcher starts one. It counts the main checkout and every session worktree that has an OpenCode tmux window, a live conductor, or a launch reservation, including sessions you opened by hand. Sessions opened by hand are never blocked; only this launcher refuses (`ceiling_reached`, with the list of what it counted). The count, the comparison and the reservation run under one lock, with the reservations kept in the main checkout's `.sterling/transient/launch-reservations.json`, so launches started at the same time cannot pass the cap together. A start whose result is unknown (`start_uncertain`) stays counted for 15 minutes or until its window is seen. Inspect it before you retry. An idle conductor in a plain terminal outside tmux cannot be seen and is not counted.

It refuses, starting nothing, when: the platform is not Linux or tmux is missing; the toolkit is off (exit 2); the folder is the main checkout or not a registered session worktree; the worktree has no `.opencode/agents/sterling/conductor.md` (`agents_missing`); a tmux session already holds that name or folder (`window_exists`); a conductor of that worktree is live or cannot be checked (`conductor_live`, `conductor_unknown`); `--session` does not name a top-level conductor of that worktree; or the cap is reached. It never kills a tmux session. When a second session for the same folder appears around the start, it reports `window_conflict`, names both, and leaves both running. Every tmux command after the start names the server with `-S <socket>` and runs only while that server is still the process that created the session. `--dry-run` runs every check, the cap included, and starts and reserves nothing.

Report the status, the window name, its attach command when it was started detached, and any refusal reason with its text.

Tasks are claimed on the shared board: a session claims a board item before it starts work on it, so two sessions do not take the same one. Say this when you report the new session.

To retire a finished session, run it from the main checkout:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/open-session.mjs" --remove <label>
```

`--remove` deletes the worktree only when it is clean, and refuses (exit 2) while it holds uncommitted changes, listing them. It then deletes the branch `session/<label>` with `git branch -d`; a branch with commits not yet merged into the base is kept and named, because deleting it would lose that work. Merge the branch into the base first, or discard it with `git branch -D`. A hobby-mode `/sterling:merge` refuses to run from a linked worktree.

Report the worktree path, the branch, any OpenCode setup line that is not `created`, `matches` or `refreshed`, and the start command.
