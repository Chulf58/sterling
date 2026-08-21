// Codex sparring-partner probe + MCP entry (decision sparring-partner-partnership-shape,
// board a0714d0b, concept article sparring-partner). Runs ONLY on init's PLUGIN-REPO
// branch (target === pluginRoot): probes for the OFFICIAL `codex mcp-server` stdio
// subcommand (no third-party wrapper — research_finding dadf858e) and, when present,
// auto-wires it beside the existing `sterling` entry in .claude-plugin/sterling-mcp.json.
//
// PROBE: `codex` resolvable on PATH AND `codex login status` exiting 0. Any spawn
// failure (binary absent, non-zero exit, timeout) is treated as ABSENT (P5 degraded-
// loud) — init reports a loud `codex mcp: skipped — <reason>` line and wires nothing,
// never blocking the rest of init. The probe result is machine-truth: it belongs in the
// gitignored generated .claude-plugin/sterling-mcp.json, never in committed config.
//
// Pure(ish) and side-effect-free beyond the one spawn: spawnFn/env are injectable so
// tests can stub the codex binary via PATH or inject a canned spawn result, without
// depending on the real machine's Codex install/login state.
import { spawnSync } from 'node:child_process';

const PROBE_TIMEOUT_MS = 5000;

// probeResult.reason is a TERSE, machine-readable literal ('binary-absent' |
// 'not-logged-in' | 'timeout') — codexSkipLine (below) is what turns it into an
// actionable message. This literal form is also what the STERLING_CODEX_PROBE
// init.mjs seam produces when forcing an outcome, so real and forced probes
// compose identically through withCodexEntry/codexSkipLine.
export function probeCodex({ spawnFn = spawnSync, timeoutMs = PROBE_TIMEOUT_MS, env = process.env } = {}) {
  let result;
  try {
    result = spawnFn('codex', ['login', 'status'], { encoding: 'utf8', timeout: timeoutMs, env });
  } catch {
    result = null;
  }
  if (!result) {
    return { ok: false, reason: 'binary-absent' };
  }
  // spawnSync on a TIMEOUT sets BOTH result.error (code 'ETIMEDOUT') AND
  // result.signal (the kill signal) — this check must come BEFORE the generic
  // error branch below, or every real timeout misreports as binary-absent.
  if (result.signal || result.error?.code === 'ETIMEDOUT') {
    return { ok: false, reason: 'timeout' };
  }
  // spawnSync sets .error (e.g. ENOENT) rather than throwing when the binary
  // cannot be resolved on PATH — treat that, and any wrapper-thrown failure, as absent.
  if (result.error) {
    return { ok: false, reason: 'binary-absent' };
  }
  if (result.status !== 0) {
    return { ok: false, reason: 'not-logged-in' };
  }
  return { ok: true };
}

// The official codex mcp-server stdio subcommand — no wrapper (research_finding dadf858e).
export const CODEX_MCP_ENTRY = { command: 'codex', args: ['mcp-server'] };

// Given the mcpServers object init is about to write (already carrying `sterling`) and
// a probe result, returns the mcpServers object WITH or WITHOUT the codex entry. Pure —
// no fs — so the create/matches/differs ensure comparison in init.mjs stays deterministic
// and this merge is independently unit-testable.
export function withCodexEntry(mcpServers, probeResult) {
  return probeResult.ok ? { ...mcpServers, codex: CODEX_MCP_ENTRY } : { ...mcpServers };
}

// Maps probeCodex's terse reason literals to the actionable text named at the
// loud skip line (P5 degraded-loud) — an unrecognized reason still prints
// something distinguishable rather than throwing (defensive, never expected
// with the two callers in this repo: the real probe and the init.mjs seam).
const REASON_TEXT = {
  'binary-absent': '`codex` binary not found on PATH (install the Codex CLI: npm i -g @openai/codex)',
  'not-logged-in': 'not logged in to ChatGPT (run `codex login`)',
  timeout: '`codex login status` did not respond within the probe timeout',
};

// The exact loud skip line init prints (P5 degraded-loud) — naming WHICH condition
// failed (binary absent vs not logged in vs timeout).
export function codexSkipLine(reason) {
  return `codex mcp: skipped — ${REASON_TEXT[reason] ?? reason}`;
}
