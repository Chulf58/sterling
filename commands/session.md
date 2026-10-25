---
description: Open an extra parallel session in this project — creates a git worktree on its own branch, sets up OpenCode there and prints the command that starts the session; --remove retires a finished one.
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

Tasks are claimed on the shared board: a session claims a board item before it starts work on it, so two sessions do not take the same one. Say this when you report the new session.

To retire a finished session, run it from the main checkout:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/open-session.mjs" --remove <label>
```

`--remove` deletes the worktree only when it is clean, and refuses (exit 2) while it holds uncommitted changes, listing them. It then deletes the branch `session/<label>` with `git branch -d`; a branch with commits not yet merged into the base is kept and named, because deleting it would lose that work. Merge the branch into the base first, or discard it with `git branch -D`. A hobby-mode `/sterling:merge` refuses to run from a linked worktree.

Report the worktree path, the branch, any OpenCode setup line that is not `created`, `matches` or `refreshed`, and the start command.
