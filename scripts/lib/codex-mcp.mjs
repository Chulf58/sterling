// Codex sparring-partner probe + MCP entry (decision sparring-partner-partnership-shape,
// board a0714d0b, concept article sparring-partner). Runs ONLY on init's PLUGIN-REPO
// branch (target === pluginRoot): probes for the OFFICIAL `codex mcp-server` stdio
// subcommand (no third-party wrapper — research_finding foreign_dadf858e) and, when present,
// auto-wires it beside the existing `sterling` entry in .claude-plugin/sterling-mcp.json.
//
// PROBE: `codex` resolvable on PATH, `codex mcp-server --help` succeeding, AND
// `codex login status` exiting 0. The help invocation verifies the exact subcommand
// without starting an interactive session. Any spawn failure (binary absent, non-zero
// exit, timeout) is treated as ABSENT (P5 degraded-
// loud) — init reports a loud `codex mcp: skipped — <reason>` line and wires nothing,
// never blocking the rest of init. The probe result is machine-truth: it belongs in the
// gitignored generated .claude-plugin/sterling-mcp.json, never in committed config.
//
// Pure(ish) and side-effect-free beyond its short capability/login spawns: spawnFn/env are injectable so
// tests can stub the codex binary via PATH or inject a canned spawn result, without
// depending on the real machine's Codex install/login state.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROBE_TIMEOUT_MS = 5000;

// probeResult.reason is a TERSE, machine-readable literal ('binary-absent' |
// 'mcp-server-missing' | 'not-logged-in' | 'timeout') — codexSkipLine (below) is what turns it into an
// actionable message. This literal form is also what the STERLING_CODEX_PROBE
// init.mjs seam produces when forcing an outcome, so real and forced probes
// compose identically through withCodexEntry/codexSkipLine.
export function probeCodex({ spawnFn = spawnSync, timeoutMs = PROBE_TIMEOUT_MS, env = process.env } = {}) {
  const run = (args) => {
    try {
      return spawnFn('codex', args, { encoding: 'utf8', timeout: timeoutMs, env });
    } catch {
      return null;
    }
  };
  const versionResult = run(['--version']);
  if (!versionResult) return { ok: false, reason: 'binary-absent' };
  if (versionResult.signal || versionResult.error?.code === 'ETIMEDOUT') return { ok: false, reason: 'timeout' };
  if ((versionResult.error && versionResult.status == null) || versionResult.status !== 0) return { ok: false, reason: 'binary-absent' };
  const version = String(versionResult.stdout ?? '').match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] ?? 'unknown version';
  const capabilityResult = run(['mcp-server', '--help']);
  if (!capabilityResult) return { ok: false, reason: 'binary-absent' };
  if (capabilityResult.signal || capabilityResult.error?.code === 'ETIMEDOUT') return { ok: false, reason: 'timeout' };
  if (capabilityResult.error && capabilityResult.status == null) return { ok: false, reason: 'binary-absent' };
  const capabilityHelp = `${capabilityResult.stdout ?? ''}\n${capabilityResult.stderr ?? ''}`;
  if (capabilityResult.status !== 0 || !/\bcodex\s+mcp-server\b/i.test(capabilityHelp)) {
    return { ok: false, reason: 'mcp-server-missing', version };
  }
  let result;
  result = run(['login', 'status']);
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
  if (result.error && result.status == null) {
    return { ok: false, reason: 'binary-absent' };
  }
  if (result.status !== 0) {
    return { ok: false, reason: 'not-logged-in' };
  }
  return { ok: true };
}

// The official codex mcp-server stdio subcommand — no wrapper (research_finding foreign_dadf858e).
// The bare `codex` spelling is what probeCodex proves: its success means "the `codex` on
// PATH ran". (An absolute-path override once existed for the native-Windows probe's result;
// that probe was retired with the native launcher — decision native-windows-launcher-retired-
// wsl2-only — so nothing produces a probe result carrying a command anymore, and
// withCodexEntry no longer looks for one.)
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
export function codexSkipLine(reason, version) {
  const text = reason === 'mcp-server-missing'
    ? `Codex CLI ${version ?? 'unknown version'} does not support \`mcp-server\`; the supported route is a user-scope pinned Codex MCP server (such as Codex 0.153.4)`
    : (REASON_TEXT[reason] ?? reason);
  return `codex mcp: skipped — ${text}`;
}

// USER-SCOPE CHECK (decision sterling-ships-as-a-marketplace-plugin-authoring-machine-
// keeps-its-clone, ruling point 2). The codex server is registered in the user-level
// Claude config (`claude mcp add --scope user`), which Claude Code keeps in
// `<CLAUDE_CONFIG_DIR or home>/.claude.json` under a top-level `mcpServers`. init only
// READS that file: a missing file is "not registered", an unparseable one is reported as
// unreadable (never guessed at). Pure apart from the read; env/home are injectable.
export function userScopeCodexServer({ env = process.env, home = homedir(), readFile = readFileSync } = {}) {
  const path = join(env.CLAUDE_CONFIG_DIR || home, '.claude.json');
  let raw;
  try {
    raw = readFile(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { found: false, path };
    return { found: false, path, unreadable: err?.code ?? err?.message ?? String(err) };
  }
  try {
    const servers = JSON.parse(raw)?.mcpServers;
    const found = Boolean(servers && typeof servers === 'object' && Object.prototype.hasOwnProperty.call(servers, 'codex'));
    return { found, path };
  } catch (err) {
    return { found: false, path, unreadable: `not valid JSON (${err?.message ?? err})` };
  }
}

// The registration command for a Codex whose `mcp-server` subcommand the probe proved.
export const CODEX_USER_ADD_COMMAND = 'claude mcp add --scope user codex -- codex mcp-server';

// The pinned route (finding codex-mcp-bridge-needs-codex-0-153-4-pinned-side-install):
// 0.153.4 is the last codex-cli with `mcp-server`. The PATH env is required because codex
// is a `#!/usr/bin/env node` script and a version-manager node is not on the spawn PATH.
const PINNED_INSTALL = 'npm i -g --prefix ~/.local/codex-mcp-0.153.4 @openai/codex@0.153.4';
const pinnedAddCommand = (nodeBinDir) =>
  `claude mcp add --scope user -e PATH=${nodeBinDir}:/usr/local/bin:/usr/bin:/bin codex -- ~/.local/codex-mcp-0.153.4/bin/codex mcp-server`;

// The ONE loud line init prints (P5) when no codex server is in the user-level config.
// `probe` is probeCodex's result (or the STERLING_CODEX_PROBE forced equivalent) and only
// selects the remedy: a working `codex mcp-server` gets the plain add command, every
// failure keeps codexSkipLine's reason text, and an `mcp-server-missing` Codex (0.154+)
// gets the pinned side-install plus its exact add command.
export function codexUserScopeLine(probe, { nodeBinDir, unreadable } = {}) {
  const unread = unreadable ? ` (the user-level Claude config could not be read: ${unreadable})` : '';
  if (probe.ok) return `codex mcp: no codex server at user scope${unread} — register it with: ${CODEX_USER_ADD_COMMAND}`;
  const skip = codexSkipLine(probe.reason, probe.version);
  if (probe.reason === 'mcp-server-missing') {
    return `${skip}${unread}. Install and register it: ${PINNED_INSTALL} && ${pinnedAddCommand(nodeBinDir ?? '<node bin dir>')}`;
  }
  return `${skip}${unread}`;
}
