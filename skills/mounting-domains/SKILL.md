---
name: mounting-domains
description: Add a knowledge domain to a project, or fix what the domain map shows as wrong, without forgetting a step. Use when the user runs /sterling:domains, asks which domains a project should mount, says two projects do not share knowledge, or after an upgrade when a mounted domain has no description, no store or the old format.
---

# Mounting domains SOP

Decision `consumers-learn-domain-mounting-from-agents-md-and-a-domain-check-command` (user-ruled 2026-10-03). The command is `node "${CLAUDE_PLUGIN_ROOT}/bin/domains.mjs"`, called "the map" below. Work the steps in order.

## 1. What a domain is

A domain is a shared knowledge store for one subject, kept per user at `~/.sterling/domains/<name>/sterling.db`. A project mounts the domains named in `stack_tags` in its `.sterling/config.json`. Every project on the machine that mounts a domain reads and writes the same store.

The rule: **mount every subject the project works with, its own included. Two projects share knowledge only through a domain both mount.**

The mistake this SOP exists to prevent, in the user's words: "i have a project called Salesforce which mounted the domain genesys. The i have a genesys project which mounted the domain Salesforce. This resulted in my projects not having anything actually shared knowledge". Each project mounted only the other's subject, so no store was mounted by both. Both should mount `salesforce` and `genesys`.

## 2. Look before creating

Run the map: `node "${CLAUDE_PLUGIN_ROOT}/bin/domains.mjs"` (add `--json` for data).

Check before moving on:
- Read the whole "Domains" list, not only this project's mounts. If a store for the subject already exists under the same or a near name (different case, plural, hyphen: `Salesforce`, `sales-force`, `genesys-cloud`), mount that one. The map lists names that differ only by case, and `--apply` refuses to add one; a plural or a hyphen it cannot see, so read for those. Never create a second store for one subject: two stores split the knowledge the same way the Salesforce and Genesys case did.
- Read the "Note:" lines. One says when this project was missing from the project registry and has now been added by this run (only a project with a `.sterling/sterling.db` is added).

## 3. Decide the list with the user

Propose the list, then put it to the user through ONE AskUserQuestion form. The session proposes; the user decides.

The list is: the project's own subject, each other system the project integrates with, and `sterling`, which init mounts in every project. Start from the map's "Proposal" block and add any subject the user names. Never apply before the answer, and never add a domain the user did not choose.

## 4. A new store needs a description

A domain with no store yet is created with a description that says which knowledge belongs in it and which does not. The description decides two things: where a new record is written (a record about the subject gets scope `domain:<name>`), and what promotion suggests for records already in a project.

Ask the user for it in their words. Do not invent one.

- Good: "Salesforce platform facts: objects, Apex, flows, API limits and org configuration that hold in any org. Not facts about one project's repo, and not Genesys integration details."
- Bad: "Salesforce stuff." It names no boundary, so every record that mentions Salesforce looks like a fit.

## 5. Apply with the CLI

Run it once, with one `--add` per domain and one `--description` per domain that has no store:

`node "${CLAUDE_PLUGIN_ROOT}/bin/domains.mjs" --apply --add <domain> --description "<domain>=<text>"`

It adds the tags to this project's `stack_tags`, creates each missing store with its description and refreshes this project's entry in the project registry. Exit 2 is a refusal that names its reason; report it as printed. A refusal before the first store is created has written nothing. Stores are created before `stack_tags` is written and are not rolled back, so a failure after that point names the stores it already created and says that `stack_tags` was not changed; run the same command again once the cause is fixed.

Check before moving on: the output lists each domain as created, already having a store, or already mounted, and prints the new `stack_tags`.

Never hand-edit `stack_tags` when the CLI can make the change: a hand edit skips the store creation and leaves the registry entry stale. Never remove a mount and never move records as part of this SOP.

## 6. Load the mount and confirm it

The Sterling MCP server mounts domains once, when it starts (verified in `packages/mcp-server/src/server.ts`: the mounted set is built at boot from the config). So the new domain is not readable or writable in the running session. Tell the user to restart the session.

Then:
- Update the "Stack tags" and "Domain stores" lines in the project's `AGENTS.md`. Init writes them once and does not rewrite an existing `AGENTS.md`.
- Re-run the map and confirm the domain lists this project under "mounted by", and that the proposal for this project is empty or holds only what the user declined.

## 7. The other side

The command changes only the current project. For each sibling that should mount the same domain, the map prints the step ("In <project> (<path>): add '<domain>'"). Tell the user each one by project name and path: open that project and run `/sterling:domains` there.

The map sees one user on one machine. A project on another machine, or under another user (native Windows and WSL are two users), is not listed, and its domain stores are separate files. Say so, and say that those projects must be checked where they live.

## 8. Existing knowledge stays where it is

Records already written in the project about the subject stay project-scoped. Do not move them by hand, and do not sweep the store for them as part of this SOP. The promotion path is the maintenance queue: a project-scoped record with no repo paths that fits a mounted domain's description gets a `promotion_review` item when it is written, and `/sterling:drain` promotes the ones where exactly one domain fits and asks the user about the rest. New records about the subject are created with scope `domain:<name>` from now on.

## 9. What can be wrong after an upgrade

- **A store with no description** ("Stores with no description"): from a project that mounts it, set one with the `domain_describe` tool, using the user's words as in step 4.
- **A store in the old format** ("Stores in the old format"): in a project that mounts it, `knowledge_query` and `knowledge_get` fail until Sterling is updated to a version that isolates the store. Do not repair or migrate it here. Tell the user, run `/sterling:update`, and if it persists report it with `/sterling:report-issue`.
- **A tag with no store** ("Tags that name no store"): the tag is not mounted, so nothing is read from it and writes to it are refused. First check step 2 for a near name. If the subject is real and has no store, run step 5 for that tag with a description: the CLI creates the store and leaves the tag as it is.

## 10. Before saying done

- [ ] The map was run and the full domain list was read for an existing or near-named store.
- [ ] The user chose the list through the question form.
- [ ] Each new store has a description in the user's words that names what belongs and what does not.
- [ ] The apply output was read and shows the new `stack_tags`.
- [ ] The user was told to restart the session, and `AGENTS.md` matches the new tags.
- [ ] The map was re-run and shows this project under each added domain.
- [ ] Each sibling step was named to the user with the project and its path, and the one-machine, one-user limit was stated.
- [ ] Nothing was removed and no record was moved by hand.
