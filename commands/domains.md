---
description: Map every knowledge domain on this machine to the projects that mount it, and add the domains this project is missing.
---

Run the domain map: `node "${CLAUDE_PLUGIN_ROOT}/bin/domains.mjs"` (the script ships with the plugin, not the project; add `--json` for the same map as data). Show the user the map as printed: each domain with its description and the projects that mount it, stores no project mounts, tags that name no store, stores with no description, stores in the old format, what each other project shares with this one, and the limits (one user on one machine, registered projects only). A report run writes one thing: when this project is initialized but missing from the project registry, it registers it and prints a Note saying so.

Then invoke the `mounting-domains` skill and follow it for anything that changes a mount or fixes a problem the map shows. The rule it applies: a project mounts every subject it works with, its own included, and two projects share knowledge only through a domain both mount. A Salesforce project that mounts only `genesys` and a Genesys project that mounts only `salesforce` share nothing; both should mount `salesforce` and `genesys`.

The three points that are never skipped:

1. Put the additions to the user through ONE AskUserQuestion form before any `--apply`. A domain with no store yet needs a description of which knowledge belongs in it; ask the user for it, do not invent one.
2. Apply with `node "${CLAUDE_PLUGIN_ROOT}/bin/domains.mjs" --apply --add <domain>`, with `--description "<domain>=<text>"` for each domain that has no store. It adds the tags to this project's `stack_tags`, creates a missing store and updates the tags in the project's registry entry. It changes only the project the session is in: `--target` is for report runs. It never removes a tag, never moves a record and never changes another project. A refusal exits 2 and names its reason; report it as printed.
3. After an apply, tell the user to restart the session: the Sterling MCP server mounts domains once, when it starts. A step the map lists for another project is run in that project with this same command.
