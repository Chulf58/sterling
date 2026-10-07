# OpenSterling report — H10 window gauge still asks for context_watch.windows["claude-fable-5-1"], and no sanctioned route can write it (2026-09-09)

Received 2026-09-09 from the OpenSterling project (a registered sibling on the authoring machine). Verbatim below; the Sterling response follows.

## Report (verbatim)

Subject: H10 window gauge still asks for context_watch.windows["claude-fable-5-1"], and no sanctioned route can write it (should have shipped in the last update)

Measured against: Sterling clone version 0.15.0 (.claude-plugin/plugin.json),
HEAD 1ef128a "Merge fix/oracle-h10-marker-h20-probes into main" (2026-09-08),
consuming project OpenSterling, session 2026-09-09.
Session-start banner AGENT CURRENCY: "of 11 Sterling-generated agent file(s) in
.claude/agents/, 11 stale against the clone's templates" — so this project is
running frozen agents while the clone is current.

WHAT HAPPENED
1. Stop hook H10 (hooks/h10-direct-capture.mjs) reported:
   "H10 window gauge: model 'claude-fable-5-1' has no entry in
   context_watch.windows — measured against the 200000-tok default (may
   mislead). Add context_watch.windows["claude-fable-5-1"] to
   .sterling/config.json."
   I understood this to have been fixed in the last update.

2. The clone's own .sterling/config.json DOES carry the entry
   ("claude-fable-5-1": 1000000, also "claude-opus-4-8"). The consuming
   project's .sterling/config.json does NOT — its windows block is still
   default / claude-fable-5 / claude-opus-5 / claude-sonnet-5 /
   claude-haiku-4-5. So the fix landed in the clone's config but never
   migrated to consuming projects' configs.

3. The remedy H10 names cannot be carried out from a session:
   - H15 store guard denies every raw Edit/Write/shell write into .sterling/
     (and denied a python3 read of config.json as an unrecognized verb).
   - config_set refuses the key: "'context_watch.windows.claude-fable-5-1'
     is not on the allowlist — allowed paths: models.<key>, tdd.enabled,
     mutation_verification.enabled, sparring_partner.enabled,
     sparring_partner.model, delegation.max_concurrent,
     maintenance_queue.deep_threshold, delivery.<key>,
     dispatch_register.stale_minutes, review_ledger.stale_days."
   A hook that instructs the user to add a key no sanctioned mechanism can
   write is a P5 problem: the degraded path is announced but the only exit
   is a hand edit outside the enforcement surface.

ASKS
a) Migrate context_watch.windows defaults into consuming projects on
   /sterling:update (or have H10 fall back to a model-family prefix match,
   e.g. claude-fable-5-1 -> claude-fable-5, before falling to 200000).
b) Either add context_watch.windows.<model> to the config_set allowlist, or
   change H10's message to name the route that actually works today.
c) Clarify whether the 11/11 stale agents in this project are expected after
   an update, and what step re-syncs them — the banner names the staleness
   but not the remedy.

Workaround applied locally: none yet; awaiting guidance before hand-editing
config.json outside the guard.

## Sterling response (2026-09-09)

Findings, each re-checkable at HEAD 1ef128a:

1. The fix never shipped. `templates/default-config.json:15-21` maps only claude-fable-5 / opus-5 / sonnet-5 / haiku-4-5. The clone's live `.sterling/config.json` carries fable-5-1 and opus-4-8 because it was hand-edited, so the authoring machine never saw the gap. Nothing migrates window entries.
2. What shipped 2026-09-08 was `config_set` with a fixed 10-key allowlist (`packages/mcp-server/src/tools.ts:1240-1251`); `context_watch` is not on it, and H10's remedy text (`scripts/hooks/h10-direct-capture.mjs:343`) predates the tool.
3. The 11 stale agents: OpenSterling is a sibling on the authoring machine (registered 2026-09-07 at 0.14.1). `/sterling:merge` never syncs siblings and `/sterling:update` on an already-current clone skips the agent sync unless `--force`. Synced by hand 2026-09-09 (`node scripts/sync-agents.mjs --target /mnt/c/Users/cuj/OpenSterling` → 11 refreshed). RESTART the OpenSterling session, then run `enforcement_reconcile {adopt:true}` there before the first agent Bash call (H17 latch).

Disposition (decision `context-window-from-platform-statusline-and-config-write-policy-tree`, board objective `context-gauge-and-config-policy-2026-09`): the prefix fallback in ask (a) stays rejected (a guess is not a source); the window will come from the platform's statusLine `context_window_size`, bound to the session; `config_set` authorization moves to a write-policy tree beside the schema so every tunable, including `context_watch.windows.<model>`, is writable without an allowlist change; the merge and every update fan agent sync out to registered siblings.

Workaround until S1/S2 land: edit `.sterling/config.json` in an EXTERNAL editor (not a tool call — H15 gates the agent tool channel only, by design) and add `"claude-fable-5-1": 1000000` under `context_watch.windows`. That is the honest route today; H10's message will be corrected to say so.
