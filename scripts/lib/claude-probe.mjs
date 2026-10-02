// Is Claude Code on this machine? Same shape as probeOpenCode in opencode-install.mjs
// (decision init-without-claude-code-probes-and-skips-claude-artifacts-loudly): init
// asks before it writes the Claude-only project files.
import { spawnSync } from 'node:child_process';

/** `claude --version` → { installed, version, major } or { installed: false, reason }. */
export function probeClaude({ env = process.env } = {}) {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8', env, timeout: 20_000 });
  if (r.error) return { installed: false, reason: r.error.code === 'ENOENT' ? 'no `claude` on PATH' : `claude --version could not run (${r.error.message})` };
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(`${r.stdout}${r.stderr}`);
  if (r.status !== 0 || !m) return { installed: false, reason: `claude --version exited ${r.status} without a version: ${`${r.stdout}${r.stderr}`.trim().slice(0, 200)}` };
  return { installed: true, version: m[0], major: Number(m[1]) };
}

/**
 * probeClaude behind the STERLING_CLAUDE_PROBE test seam: unset or '' runs the real probe,
 * 'ok' forces present, 'absent' forces absent. Any other value throws (P5), so a caller
 * checks it before writing anything.
 */
export function probeClaudeWithOverride({ env = process.env } = {}) {
  const override = env.STERLING_CLAUDE_PROBE;
  if (!override) return probeClaude({ env });
  if (override === 'ok') return { installed: true, version: 'forced' };
  if (override === 'absent') return { installed: false, reason: 'STERLING_CLAUDE_PROBE=absent' };
  throw new Error(`STERLING_CLAUDE_PROBE must be 'ok' or 'absent' (got '${override}')`);
}
