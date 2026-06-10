# PROBES.md — §16.0 Layer 0 platform probe findings

Committed once per spec §16.0. Probe scripts were throwaway and have been deleted; this file is the durable record.

## Environment

- **Date:** 2026-06-10
- **Claude Code CLI:** 2.1.170 (`claude.exe`, Windows)
- **OS:** Windows 11 Enterprise 10.0.26200; Node v24.14.0
- **Method:** scratch project `C:\Users\cuj\sterling-probes-scratch` (deleted after), hand-placed throwaway agents in `.claude/agents/` — Sterling's init machinery was not used. Driver: headless `claude -p` (fresh process per run, `--model haiku`, `--permission-mode bypassPermissions`). Evidence was collected from artifacts written by independent processes (a no-dependency stdio MCP server appending to an evidence log on every `tools/call`; hook scripts dumping their stdin JSON to log files), not from model self-report.
- **Docs verified before probing (per §0.3):** the spec's docs-map URL `https://docs.anthropic.com/en/docs/claude-code/claude_code_docs_map.md` 301-redirects to `https://code.claude.com/docs/en/claude_code_docs_map.md` — use the latter. Current `hooks.md` confirms: PreToolUse uses `hookSpecificOutput.permissionDecision` (no top-level decision field), values `allow | deny | ask | defer` (`defer` is newer than the spec's three — no impact on Sterling, which only emits `allow`/`deny`); exit 2 blocks, exit 1 is non-blocking; matchers case-sensitive. Current `sub-agents.md` confirms plugin subagents ignore `hooks`/`mcpServers`/`permissionMode` frontmatter — spec §2.2's plugin-distributor / project-enforcement-surface design holds.

## Probe 1 — Subagents can call MCP tools: **PASS**

- Project-installed agent (`.claude/agents/mcp-prober.md`, `tools: mcp__probe__probe_marker` only) was spawned via the Agent tool and called the MCP tool.
- Evidence: the MCP server **process itself** logged `{"tool":"probe_marker","value":"PROBE1-SUBAGENT-MCP"}` to its evidence file; the subagent received and reported the tool's response text.
- The server was a project `.mcp.json` stdio server inherited from the main conversation (current docs: subagents inherit MCP tools by default; per-agent `mcpServers` frontmatter also exists for project agents).
- **The pre-recorded outbox fallback in §16.0 is NOT needed.** `handoff_write` / `agent_exit` as MCP tools are viable.

## Probe 2 — Frontmatter hooks block inside spawned subagents: **PASS**

All hooks were defined in the **agent's frontmatter** (project-installed agent) and fired inside the spawned subagent:

- **Exit 2 blocks:** PreToolUse hook on `Write` exiting 2 — file was not created; hook's stdin was logged; the hook's stderr text was surfaced to the subagent as the block reason.
- **`hookSpecificOutput.permissionDecision: "deny"` blocks:** same setup with JSON output, exit 0 — file not created; `permissionDecisionReason` surfaced to the subagent.
- **Exit 1 does NOT block:** file was created. Confirms exit-code semantics exactly as documented (only exit 2 blocks; 1 is a non-blocking error).
- **Matchers are case-sensitive:** a parallel matcher `"write"` (lowercase) with a logging hook never fired while `"Write"` fired in the same agent — its log file was never created.
- **Blocking works under `--permission-mode bypassPermissions`** — hook denial is independent of the permission mode (matters for Sterling's headless/spawned contexts).

## Probe 3 — In-subagent hook input: **PASS**

PreToolUse stdin inside the subagent contained: `session_id`, `transcript_path`, `cwd`, `permission_mode`, **`agent_id`** (e.g. `a36ac8046f78ed53a`), **`agent_type`** (the agent's name), `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`. PostToolUse additionally: `tool_response`, `duration_ms`.

- **`agent_id` present:** yes, on every in-subagent hook event.
- **`transcript_path` resolution:** points to the **parent session** transcript, NOT the agent's own. The subagent's own transcript is at
  `~/.claude/projects/<project>/<session_id>/subagents/agent-<agent_id>.jsonl` — i.e. **derivable from `session_id` + `agent_id`**. Its entries carry `isSidechain: true` and an `agentId` field matching the hook input.
- **`message.usage` parseable from the agent transcript tail:** yes — assistant entries have `message.usage` with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, etc.
- **Design consequence for H6:** resolve the agent's transcript from `agent_id`, never read `transcript_path` as if it were the agent's own.

## Probe 4 — H14-shaped Bash allowlist blocks inside a coder-shaped agent: **PASS**

- Coder-shaped agent (`tools: Read, Write, Edit, Bash`) with a frontmatter PreToolUse `Bash` hook (allowlist: commands starting `echo `).
- `git status` was **denied pre-execution** with the hook's exact reason string (`STERLING-PROBE4: command not on allowlist: git status`); the hook log captured the full command plus `agent_id`/`agent_type`.
- Allowlisted `echo sterling-probe-allowlist-ok` proceeded and returned its output — the hook discriminates, not just blocks.

## Probe 5 — Init-installed agents in `.claude/agents/` after restart: **PASS**

- Every probe run was a fresh `claude` process (headless), i.e. restart semantics on each run: hand-placed `.claude/agents/*.md` files were visible, spawnable via the Agent tool, and their frontmatter hooks executed and blocked (probes 2–4).
- An explicit listing run in a fresh process showed all six hand-placed agents alongside the built-ins.
- Plugin-served agents ignoring `hooks`/`mcpServers`/`permissionMode` was re-confirmed against current docs (not probe-tested; already designed around in §2.2).

## Critical operational findings (beyond pass/fail)

1. **Hook commands on Windows execute under git bash, not cmd.** Windows-style backslash paths in hook `command` strings are mangled (backslashes consumed as escapes) and the hook command then **fails silently as a non-blocking error** — the tool call proceeds with enforcement absent and nothing visible in normal output. This initially made probes 2–4 appear to fail. **Sterling must emit every hook command with forward-slash, double-quoted absolute paths** (e.g. `'"C:/path with spaces/node.exe" "C:/repo/hooks/h6.mjs"'`), and the hook-emission path deserves a consistency check for backslashes. This is the platform behavior behind the spec's POSIX-path discipline applying to *hook command strings*, not just stored paths.
2. **Silent-failure mode of broken hook commands is real and quiet** (P5 hazard): a misconfigured hook does not halt anything by itself. Sterling should self-verify its hooks fire (e.g. H6 heartbeat/evidence expectations) rather than assume registration equals enforcement.
3. **Workspace trust was investigated and ruled out as a gate:** hooks registered and fired in a directory never opened interactively (no `~/.claude.json` project entry), in `-p` mode. Agents, `.mcp.json` servers (with `enableAllProjectMcpServers: true` in `.claude/settings.local.json`), and hooks all load there.
4. **Debugging hooks headless:** `--debug` alone prints nothing usable in `-p` mode; use `--debug hooks --debug-file <path>`. The log shows hook registration, matching, execution, and per-hook success/error.
5. Probe driver detail: headless runs were executed from inside another Claude Code session (env `CLAUDECODE=1` inherited) with no observed interference.

## Verdict

All five existential probes **PASS** on Claude Code 2.1.170. No design conversation required; §16.1 Slice 1 (distribution foundation) is unblocked.
