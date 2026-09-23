# Subagent sidecar probe (THROWAWAY)

Spec: decision `h22-start-attribution-joins-through-subagent-meta-sidecar-after-a-live-probe` (knowledge_get e2fcc4c0), point (1). This probe measures whether `~/.claude/projects/<proj>/<session>/subagents/agent-<agent_id>.meta.json` (with `toolUseId`) is readable and correct when SubagentStart fires. Nothing relies on the sidecar until this probe passes.

- `subagent-sidecar-probe.mjs` is the hook command. It always exits 0 with empty stdout, and appends one line per event to `$SIDECAR_PROBE_OUT`, or `$CLAUDE_PROJECT_DIR/.sterling/transient/sidecar-probe.jsonl` when that is unset. At Start it polls the sidecar every 10 ms for up to 2000 ms (override with `SIDECAR_PROBE_POLL_BUDGET_MS`). Keep the hook `timeout` above that budget.
- `subagent-sidecar-probe-report.mjs [file] [--json]` prints the verdict table. Exit codes: 0 PASS, 1 FAIL, 2 NO-DATA, 3 unreadable input.

## Register (by hand, then relaunch; `/clear` does not reload hooks)

Merge into `.claude/settings.local.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Agent|Task", "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/scripts/probes/subagent-sidecar-probe.mjs\"", "timeout": 10 }] }
    ],
    "SubagentStart": [
      { "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/scripts/probes/subagent-sidecar-probe.mjs\"", "timeout": 10 }] }
    ],
    "PostToolUse": [
      { "matcher": "Agent|Task", "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/scripts/probes/subagent-sidecar-probe.mjs\"", "timeout": 10 }] }
    ]
  }
}
```

The `Task` alternative mirrors the `Task|Agent` matcher H22 uses in `hooks/hooks.json`. After the run, remove the block and delete the jsonl.

## Run protocol (from the decision)

1. Start from a clean output file: `rm -f .sterling/transient/sidecar-probe.jsonl`.
2. Run several 6-way batches where all six Agent calls in one message use the SAME `subagent_type`, with distinct prompts. Run some batches with `run_in_background: true` and some in the foreground. Include at least one `general-purpose` batch and one named-agent batch.
3. Resume: continue a finished agent through SendMessage (and an Agent resume, if available). The report flags a reused `agent_id` whose sidecar still names an already-claimed `toolUseId` as `STALE`.
4. Run on WSL/drvfs (this clone under `/mnt/c`).
5. `node scripts/probes/subagent-sidecar-probe-report.mjs`. The verdict is PASS only if every Start read a valid sidecar within the hook's lifetime that matches a Pre of the same session and type, no Post contradicts it, and no Start reuses a key.

The missing, malformed, stale-from-resume and 50-ms-late sidecar cases are simulated in `scripts/tests/subagent-sidecar-probe.test.mjs`, not in the live batch. To replay a case by hand, pipe a synthetic payload into the probe: `echo '{"hook_event_name":"SubagentStart",...}' | SIDECAR_PROBE_OUT=/tmp/x.jsonl node scripts/probes/subagent-sidecar-probe.mjs`.

Not measured by this probe: the child's first action, and whether H19 and H22 run concurrently with this hook. The `line1` column (hash of the child jsonl's first message against the Pre prompt hash) is supporting evidence only and does not gate the verdict.
