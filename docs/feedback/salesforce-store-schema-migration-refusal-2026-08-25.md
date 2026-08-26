# Feedback: knowledge write refused — store at schema v0, build requires v2, no migration ever offered (Salesforce project)

- **Date:** 2026-08-25
- **Project:** `C:\Users\cuj\Salesforce` (WSL `/mnt/c/Users/cuj/Salesforce`, store `.sterling/sterling.db`)
- **Session:** interactive Claude Code (Fable 5), Sterling plugin MCP tools mounted and working for reads
- **Severity:** blocks every store write in the project; reconcile/capture duties cannot be fulfilled

## What happened

Mid-session, the conductor attempted a routine capture — `knowledge_create` of a `reference_material` record for a newly added file (`docs/own-what-we-use.html`). The write was refused:

```
Schema migration required: this store is at schema version 0, but this build requires
version 2. The store is open READ-ONLY — 'recordCheckSkipped' and every other write
refuses until the stable-identity migration has run. Run the stable-identity store
migration (decision stable-identity-design-v2) against this store file; the migration
runner reports the exact command, takes a VACUUM INTO backup first, and bumps
user_version last. Nothing was written.
```

The refusal itself behaved correctly: loud, nothing written, names the fix. That part is good.

## The actual issues

1. **Reads worked all session, so the read-only state was invisible until the first write.** The same session had already run `knowledge_query` (digest, 78 records) and ~16 `knowledge_get` calls with no hint the store was write-locked. The version mismatch was knowable at mount time. A whole work session can be conducted on top of a store that silently cannot accept the reconcile the conventions demand at the end of that work.

2. **No session-start surfacing.** H1 injected the usual conventions at SessionStart but nothing said "this store needs the stable-identity migration; writes will refuse." If the server can detect v0-vs-v2 when refusing a write, it can detect it when mounting the store and say so up front — before the user and conductor accumulate capture debt.

3. **The error says "the migration runner reports the exact command" but gives no way to reach the runner from the seat where the error lands.** The conductor's contract forbids shelling against `.sterling/` (H15) and prescribes "restart the session, not bypass" for a server lagging the code. From inside the session there is no MCP tool, skill, or named command to invoke the migration — `/sterling:update` updates the clone, but nothing indicates whether it also runs per-project store migrations. The error should name the concrete user-facing action (e.g. "run `/sterling:update`, then restart this session" or the literal CLI command), not refer to a runner the reader cannot see.

4. **Version skew question:** this project was initialized and heavily used (78 records) — the store presumably matched its build once. The plugin build has moved to schema v2 while per-project stores stay at v0 until someone happens to write. If `/sterling:update` is the intended migration vehicle, it apparently did not migrate (or was not run against) this project's store even though the project is in the shared registry. Sibling projects on this machine likely have the same latent state and will hit the same wall on their next write.

## What was owed and is now parked

- `reference_material` capture for `docs/own-what-we-use.html` (pitch deck, also published as artifact `5d670b5e-905d-4c87-b0c0-ce8e5c780c83`) — drafted, refused, not written. H10 will presumably demand it; the demand is unfulfillable until the store is migrated.

## Suggested fixes (in order of value)

1. Surface the schema-lag/read-only state at session start (H1 line: store version, required version, the one command to run).
2. Make the refusal message name the exact user-runnable command instead of referring to the migration runner's own output.
3. Have `/sterling:update` (or a dedicated `/sterling:migrate`) sweep registered projects' stores and run pending migrations, reporting per-project results.
4. Consider whether read-only-due-to-pending-migration should also be visible in `/sterling:status` and the TUI.
