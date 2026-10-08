# Join a Served Postgres project from OpenCode

> Retired 2026-10-08. Postgres storage is switched off (decision `postgres-storage-switched-off-every-project-locked-to-local-sqlite`), so no project can be joined this way and `move-store --attach` refuses. This page is kept for reference.

This page is for the person who hands out access. A new user gets two things from you:

1. **The credentials file.** It is a copy of your own `~/.sterling/credentials/served.json`. Make it with:

   ```
   cp ~/.sterling/credentials/served.json ~/sterling-served.json
   ```

   Send it through a private channel (a direct Teams message or a shared password manager entry, not a public channel or a ticket). Never commit it or put it in this repo, which is public. Everyone who has the file uses the same database login, so if one copy leaks, the password has to be changed and the file sent out again.

2. **The prompt below**, with the values filled in. The user pastes it into OpenCode on their machine. It works on native Linux and on WSL2; on WSL2, `CREDENTIALS_FILE` can be a Windows path under `/mnt/c/`.

A project can only be joined after it has moved to Served Postgres (`config.storage: postgres` on the machine that moved it). On 2026-10-07 only the Sterling repo itself has moved.

## Values to fill in

| Placeholder | What it is | Sterling repo (test project) |
|---|---|---|
| `CREDENTIALS_FILE` | Where the user saved the file you sent | e.g. `/mnt/c/Users/<user>/Downloads/sterling-served.json` |
| `PROJECT_REPO_URL` | The project's git URL | `https://github.com/Chulf58/sterling.git` |
| `PROJECT_DIR` | Where the project should live on the user's machine | `~/code/sterling-project` |
| `PROJECT_NAME` | The project's name | `Sterling` |
| `STACK_TAGS` | The project's stack tags, the same as on the machine that moved it | `node,typescript,sterling,design` |
| `TOOLCHAIN` | The project's toolchain | `node:**/*.mjs,**/*.ts` |
| `MODE` | `work` for a work project, `hobby` for the Sterling repo | `hobby` |

Stack tags decide which shared domains the project mounts. If they differ from the original machine's, the attach step refuses a domain that has no receipt.

## The prompt

```text
Set up this machine so I can work in a Sterling project whose knowledge store is on the Served Postgres database. Run the steps below in order. Show me the output of each command. Stop at the first failure and tell me what failed. Never print, cat, copy into a repository, commit or paste the contents of the credentials file.

Values:
- Credentials file I was given: CREDENTIALS_FILE
- Project repository: PROJECT_REPO_URL
- Project folder: PROJECT_DIR
- Project name: PROJECT_NAME
- Stack tags: STACK_TAGS
- Toolchain: TOOLCHAIN
- Mode: MODE
- Sterling folder: ~/sterling

1. Check versions. Run `node --version` (it must be 24 or later) and `opencode --version` (it must be 2.0.22 or later). If either is too old, stop and tell me.

2. Install the credentials file:
   mkdir -p ~/.sterling/credentials
   install -m 600 "CREDENTIALS_FILE" ~/.sterling/credentials/served.json
   stat -c '%a %n' ~/.sterling/credentials/served.json
   The mode must be 600. Then ask me whether to delete the copy at CREDENTIALS_FILE, and delete it only if I say yes.

3. Install Sterling. If ~/sterling exists, run `git -C ~/sterling pull --ff-only`. Otherwise run `git clone https://github.com/Chulf58/sterling.git ~/sterling`. Then run `cd ~/sterling && npm ci`. Show `git -C ~/sterling log -1 --oneline` and the "version" line from ~/sterling/.claude-plugin/plugin.json. It must be 0.19.16 or later.

4. Get the project. If PROJECT_DIR does not exist, run `git clone PROJECT_REPO_URL PROJECT_DIR`. Check that PROJECT_DIR/.sterling/project.json exists. It is committed in the project. If it is missing, stop and tell me.

5. Initialize Sterling in the project:
   node ~/sterling/bin/init.mjs --target PROJECT_DIR --project-name "PROJECT_NAME" --stack-tags STACK_TAGS --toolchain "TOOLCHAIN" --mode MODE --backup-opt-out

6. Dry-run the attach:
   node ~/sterling/bin/move-store.mjs --attach --dry-run --project PROJECT_DIR
   Every store (the project and each domain) must be listed as registered, with a receipt, and unfenced. If it reports a credentials error, stop and show me the error. It names the problem, never the password. If it refuses because the local SQLite store already holds rows, stop and ask me before going on.

7. Attach for real: run the same command without --dry-run. Add --fence-local only if step 6 refused because of local rows and I said yes. The output must include "config.storage switched to postgres".

8. Tell me to quit OpenCode and start it again in PROJECT_DIR. In the new session, check that the session context has the line "Storage: SERVED POSTGRES". Then run knowledge_query with rank_terms ["postgres"] and cap 3. Records must come back, with score_scale "pg_bm25_v1". Report both results.

9. If Sterling was also installed globally with `opencode plugin add`, tell me, because the server must not load twice.
```

## When something fails

- A credentials error at step 6 means the file is wrong or incomplete. Send a fresh copy.
- "readable by group or other" means the file is not mode 600. Run step 2 again.
- A domain without a receipt means the stack tags differ from the original machine's. Check them there with `/sterling:domains`.
- No `Storage:` line at step 8 means the plugin in use is older than 0.19.13. Run step 3 again.

These steps have not been run end to end yet. The first real run is the machine-B test (board item f97f3084).
