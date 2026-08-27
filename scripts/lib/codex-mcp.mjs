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

// probeCodexWin — the NATIVE-WINDOWS counterpart (board 43051819 slice A). init.mjs
// runs under WSL node, so a bare spawnSync('codex', ...) would resolve `codex` under
// WSL's OWN PATH (or find nothing, since a WSL-side install is a different binary from
// the Windows-side one) — wrong side entirely for the native-claude sterling-mcp-win.json
// this feeds. Resolution instead goes through `where.exe codex` (WSL interop reaching
// the WINDOWS PATH, same mechanism as init.mjs's own whereWin('node')), THEN the
// resolved path is probed with `login status` exactly like probeCodex above. Same
// {ok, reason} contract PLUS `command` on success — the exact executable the probe
// spawned, which is what gets written into the MCP entry (board 4c3a8e59; a bare
// `codex` entry is not what the probe proved). Same injectable spawnFn/env/timeoutMs seams (one spawnFn
// serves both the where.exe call and the login-status call — tests dispatch on the
// first arg to stub each independently).
export function probeCodexWin({ spawnFn = spawnSync, timeoutMs = PROBE_TIMEOUT_MS, env = process.env } = {}) {
  let codexPath;
  // STERLING_CODEX_WIN_PATH, when DEFINED (even empty), bypasses where.exe detection —
  // mirrors STERLING_WIN_NODE's role for init.mjs's native-Windows node resolution: a
  // path forces that path; '' forces the binary-absent path. Undefined -> auto-detect
  // via `where.exe codex` through the injected spawnFn (test isolation without needing
  // a real Windows machine).
  if (env.STERLING_CODEX_WIN_PATH !== undefined) {
    codexPath = env.STERLING_CODEX_WIN_PATH || undefined;
  } else {
    let whereResult;
    try {
      whereResult = spawnFn('where.exe', ['codex'], { encoding: 'utf8', timeout: timeoutMs, env });
    } catch {
      whereResult = null;
    }
    // Same ordering rationale as the login-status timeout check below: a
    // timed-out where.exe RESOLUTION must be classified 'timeout', not
    // folded into the generic miss/error path below (which would misreport
    // it as 'binary-absent') — and it must never proceed to login status.
    if (whereResult && (whereResult.signal || whereResult.error?.code === 'ETIMEDOUT')) {
      return { ok: false, reason: 'timeout' };
    }
    if (whereResult && !whereResult.error && whereResult.status === 0) {
      const lines = String(whereResult.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      codexPath = lines.find((l) => l.toLowerCase().endsWith('.exe')) ?? lines[0];
    }
  }
  if (!codexPath) {
    return { ok: false, reason: 'binary-absent' };
  }
  let result;
  try {
    result = spawnFn(codexPath, ['login', 'status'], { encoding: 'utf8', timeout: timeoutMs, env });
  } catch {
    result = null;
  }
  if (!result) {
    return { ok: false, reason: 'binary-absent' };
  }
  // Same ordering rationale as probeCodex: a timeout sets BOTH .error (ETIMEDOUT) AND
  // .signal, so this check must precede the generic .error branch below.
  if (result.signal || result.error?.code === 'ETIMEDOUT') {
    return { ok: false, reason: 'timeout' };
  }
  if (result.error) {
    return { ok: false, reason: 'binary-absent' };
  }
  if (result.status !== 0) {
    return { ok: false, reason: 'not-logged-in' };
  }
  // `command: codexPath` — the EXACT executable this probe just spawned successfully
  // (decision host-native-init-with-dev-machine-escape-hatch, board 4c3a8e59). Returning
  // only {ok:true} threw the resolution away, so the written entry (bare `codex`) was a
  // DIFFERENT command from the one the probe proved: on Windows `codex` is typically npm's
  // codex.cmd, which node cannot spawn shell-lessly, and PATH is a measured-unreliable
  // oracle on the native host (research_finding native-windows-platform-measurements-2026-08-27).
  // Persisting the probed path makes probe success actually EVIDENCE for the entry: the
  // probe spawned this exact string shell-lessly via spawnSync, so the MCP client can too.
  return { ok: true, command: codexPath };
}

// The official codex mcp-server stdio subcommand — no wrapper (research_finding dadf858e).
// The bare `codex` command is the FALLBACK spelling, used when a probe result carries no
// resolved path (probeCodex resolves `codex` on PATH by spawning that same bare command,
// so there its success does prove the entry). A probe that DID resolve an absolute path
// (probeCodexWin) overrides `command` with it — see codexEntryFor below.
export const CODEX_MCP_ENTRY = { command: 'codex', args: ['mcp-server'] };

// The codex entry a given probe result justifies: the probed absolute command when the
// probe resolved one, else the bare CODEX_MCP_ENTRY spelling. `args` is always the
// official mcp-server subcommand — only the command spelling varies.
function codexEntryFor(probeResult) {
  return probeResult.command
    ? { command: probeResult.command, args: [...CODEX_MCP_ENTRY.args] }
    : CODEX_MCP_ENTRY;
}

// Given the mcpServers object init is about to write (already carrying `sterling`) and
// a probe result, returns the mcpServers object WITH or WITHOUT the codex entry. Pure —
// no fs — so the create/matches/differs ensure comparison in init.mjs stays deterministic
// and this merge is independently unit-testable.
export function withCodexEntry(mcpServers, probeResult) {
  return probeResult.ok ? { ...mcpServers, codex: codexEntryFor(probeResult) } : { ...mcpServers };
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

// ---------------------------------------------------------------------------
// CONSULT-TIME failure surfacing (board 923e3836) — distinct from the
// init-time probe above. probeCodex only answers "is codex wire-eligible at
// init?"; it says nothing about a MID-SESSION consult (a real
// mcp__codex__codex / mcp__codex__codex-reply exchange) failing later
// because the copied ChatGPT OAuth token (C:/Users/<user>/.codex/auth.json
// -> ~/.codex/auth.json, finding codex-mcp-live-probe-this-machine) expired.
// That failure shape is explicitly UNMEASURED (board 923e3836), so this
// classifies by pattern-matching obvious auth markers in the raw error text
// rather than a closed reason enum like REASON_TEXT above — and the generic
// (non-auth) branch always carries the raw error text, so the first real
// failure measures the shape instead of being swallowed by a wrong guess
// (P5: fail loud, never a silent skip or a bare stack trace).
const AUTH_MARKER_RE = /\b(401|unauthorized|auth|token expired)\b/i;

// True when `errorText` looks auth-shaped (401 / unauthorized / auth / token
// expired, case-insensitive) — a heuristic, not a confirmed error contract,
// because the real auth-expiry error shape has not yet been observed.
export function looksLikeAuthFailure(errorText) {
  return AUTH_MARKER_RE.test(String(errorText ?? ''));
}

// Turns a consult-time failure (any error/rejection surfacing from an
// mcp__codex__codex or mcp__codex__codex-reply call) into a LOUD, actionable
// message — never a silent skip, never a bare stack trace. Auth-shaped
// errors get the actionable recovery hint (re-copy the token / codex login);
// anything else gets a generic transport-failure message that still carries
// the raw error text, so an unmeasured failure shape gets captured the
// moment it is first observed.
export function consultFailureMessage(error) {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  if (looksLikeAuthFailure(raw)) {
    return `Codex consult failed — likely auth expiry: re-copy the token / run \`codex login\`. Raw error: ${raw}`;
  }
  return `Codex consult failed — transport error (not auth-shaped): ${raw}`;
}
