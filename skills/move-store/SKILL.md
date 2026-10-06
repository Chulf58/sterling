---
name: move-store
description: Move a project's knowledge, with its mounted domains, from SQLite to Postgres or back with scripts/move-store.mjs. Use when the user wants a work project on Postgres, wants a project back on SQLite because it became a hobby project or the Served database is closing, or asks what a store move does, why a write was refused with StoreMovedError, or how to recover a move that crashed.
---

# Moving a project's store SOP

Decisions `store-move-skill-two-way-one-direction-at-a-time-no-live-sync` and `storage-backend-is-its-own-config-key-written-only-by-store-move`. The command is `node "${CLAUDE_PLUGIN_ROOT}/scripts/move-store.mjs" --to pg|sqlite [--dry-run] [--project <dir>]`, called "the move" below. Work the steps in order.

## 1. What the move does

The move copies ONE project's knowledge store, plus the domain stores that project mounts, from one backend to the other. It runs in one direction per call, and the user can repeat it in either direction as often as wanted. It is a one-time copy, not a sync: both sides are never writable at once, so nothing is merged and nothing needs a merge rule.

- `--to pg` moves SQLite to Postgres.
- `--to sqlite` moves Postgres back to SQLite.
- `--project <dir>` names the project. Without it the move uses the project containing the current directory.
- There is no `--all`. Other projects, and domains only hobby projects mount, are never touched.

The move writes `config.storage` (`postgres` or `sqlite`) and nothing else in the config. `config.mode` is never changed by it. Do not edit `config.storage` by hand to switch backends: the key is written by the move only, after every store has been copied and checked.

## 2. When to use it

- A project is in work mode and should keep its knowledge on the Served Postgres database: `--to pg`.
- A work project became a hobby project, or the Served database is going to close: `--to sqlite`. The export reads Postgres, so it has to run while the database is still reachable. A database that is already gone cannot be exported; the Served platform's point-in-time restore is the recovery for an unplanned loss, not this move.

If the user asks for a live two-way sync, say that the move does not do one (decision above, user-ruled 2026-10-06) and offer the move in one direction.

## 3. Preconditions

Check these before the first run. The move refuses by name when one is missing and moves nothing.

- `--to pg` needs the project in work mode. A hobby project is refused. Switching mode is the user's choice, made on the TUI System tab; this SOP never changes it.
- `.sterling/project.json` exists in the project. A work project's Postgres store is named by its `project_id`. If it is missing, restore it from git or let init write it.
- `~/.sterling/credentials/served.json` exists and is valid. Both directions need it, because both read or write Postgres.
- Every registered project must have a readable config. One that cannot be read blocks the move, since whether it shares a domain is then unknown; fix or unregister it first.

Never read or print the contents of `served.json`. Check that the file exists and report only that.

## 4. Dry run first, and show it

Run the move with `--dry-run` and the direction the user wants:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/move-store.mjs" --to <pg|sqlite> --dry-run`

A dry run reads every store and fences nothing. It writes no receipt and does not change `config.storage`. Show the user the report, not a summary of it. Point out:

- the stores that would move: this project and each mounted domain, each with its source and target;
- the id counts per table for each store, so the user can see that the numbers match what they expect;
- every shared domain, named with the projects that also mount it (see section 6).

If the report ends in a `FAILED` line, that is a refusal (section 8). Do not go on to the real run.

## 5. Ask, then run

Put the choice to the user through ONE AskUserQuestion form, with the dry-run report already shown. Options: run the move as reported, or stop. When the report names a forked domain, say so in the question text. The session proposes; the user decides. Never run the real move before an answer, and never choose the direction for the user.

Then run the same command without `--dry-run`:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/move-store.mjs" --to <pg|sqlite>`

Each store is checked read-only first, so a refusal anywhere stops the run before any store is fenced. Then each store is fenced on the side it leaves, copied, compared against a content-hash manifest of both sides and given a receipt. `config.storage` is written last. Check before moving on: no `FAILED` line, every store shows `hash match: yes`, and the last lines read `config.storage switched to <backend>` and `config.mode unchanged (<mode>)`.

Tell the user to restart the session, so the running tools pick up the new `config.storage`.

## 6. Shared domains fork

A domain can be mounted by more than one project. The move fences a store only when no other project would be cut off from it.

- `--to pg`: a domain also mounted by a hobby project is copied but NOT fenced. The hobby project keeps writing its SQLite copy, and the two copies diverge from the move on. The report names the hobby projects.
- `--to sqlite`: a domain also mounted by another work project is copied but NOT fenced. That project keeps using the Postgres copy. The report names those projects.
- `--to sqlite` is refused for a domain whose SQLite copy a hobby project kept writing after an earlier move to Postgres. Going back would mean merging the two copies, which a move never does (`MoveForkDivergedError`). Report the refusal as printed and ask the user how to proceed; do not delete either copy.

Say plainly what a fork means: after the move there are two copies of that domain's knowledge, and nothing keeps them in step. That is the cost of the user's choice to move the project, so show it in the dry-run report and in the question.

## 7. The fence

The side the move leaves is fenced. A write to a fenced store is refused with `StoreMovedError` and writes nothing. This is what keeps both sides from being writable at once.

What the user may see:

- `StoreMovedError` from a tool or hook that still opens the old backend. It means the project moved. Check `config.storage`, and restart the session if it already names the new backend.
- Do not remove the fence or copy files between backends to get around it. A fenced copy is also what a later move back replaces, and only when its content is untouched since the fence.

## 8. Recovery and refusals

**A crash or interrupt in the middle of a real run.** Re-run the same command. Each finished store replays from its receipt and is skipped, an unfinished store is copied again, and an unfinished switch of `config.storage` is completed. A failed run leaves `config.storage` unchanged and prints `config.storage was not changed. Fix the cause and re-run`. Do not delete a target by hand first.

**A refusal.** It names its reason and ends with `Nothing was moved.` when it came from the read-only pass. Report it as printed, in the user's terms, and put the next step to the user through the question form. The common ones:

- hobby project with `--to pg`: the mode precondition in section 3.
- `.sterling/project.json` missing, or the Postgres credentials missing or invalid: the preconditions in section 3.
- target not empty or id collision: the target already holds records that do not come from this source. The move fills an empty target, replays its own receipt, or replaces a copy it left itself, and nothing else. Find out what is in the target; never clear it as part of this SOP.
- source already fenced to a different target: an earlier move took this project elsewhere. Read the message for the move and date.
- schema version or missing columns: open the store once with this Sterling build so its migrations run, or run `bin/migrate-stores.mjs`, then re-run the dry run.
- copy does not match the manifest: the Postgres transaction was rolled back and nothing was committed. Re-run the dry run; if it repeats, stop and report it as a defect with the exact message.

A usage error exits 2 and prints the usage line; any other failure exits 1.

## 9. After the move

- Re-run the dry run in the other direction only if the user wants to confirm the round trip; it changes nothing.
- Do not move the project again without a new question to the user.
