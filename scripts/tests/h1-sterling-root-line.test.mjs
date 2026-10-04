// H1 SessionStart — STERLING ROOT line (decision
// session-start-prints-the-sterling-root-plain-text-instructions-use-it, GitHub issue #16).
// Plain-text instructions run scripts as node "<Sterling root>/bin/<name>.mjs" and say the root
// is the one session start printed, because ${CLAUDE_PLUGIN_ROOT} is not in the Bash tool's
// environment. So H1 prints `STERLING ROOT: <absolute path>` on every SessionStart source, from
// the running hook's own location (the walk-up, never the STERLING_PLUGIN_ROOT env value), and
// states loudly when the root cannot be resolved instead of printing a wrong path or nothing.
// Harness copied from scripts/tests/h1-project-mode-line.test.mjs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildSeamHook } from './lib/seam-hook.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const BASE_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
};

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1-root-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(BASE_CONFIG));
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  return dir;
}

function context(dir, source, hookPath = join(root, 'scripts', 'hooks', 'h1-session-start.mjs'), env = {}) {
  const input = { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'SessionStart', source };
  const r = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(input), encoding: 'utf8', cwd: dir, timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', NO_COLOR: '1', STERLING_NO_BANNER: '1', ...env },
  });
  assert.equal(r.status, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

const rootLines = (ctx) => ctx.split('\n').filter((l) => l.startsWith('STERLING ROOT:'));

for (const source of ['startup', 'clear', 'resume', 'compact']) {
  test(`H1 (${source}): prints one STERLING ROOT line with the running hook's plugin root`, () => {
    const dir = project();
    try {
      const ctx = context(dir, source, undefined, { STERLING_PLUGIN_ROOT: '/not/the/root' });
      assert.deepEqual(rootLines(ctx), [`STERLING ROOT: ${root}`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('H1: the STERLING ROOT line is immediately followed by the MACHINE ROLE line when one is printed', async () => {
  // MACHINE ROLE is printed only when the session cwd IS the plugin root (machineRoleLine). A
  // seam-built bundle in a temp dir that also carries .claude-plugin/plugin.json is its own
  // plugin root, so a project opened there prints MACHINE ROLE: AUTHORING.
  const seam = await buildSeamHook('h1-session-start.mjs');
  try {
    mkdirSync(join(seam.dir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(seam.dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'sterling', version: '0.0.0-test' }));
    mkdirSync(join(seam.dir, '.sterling'), { recursive: true });
    writeFileSync(join(seam.dir, '.sterling', 'config.json'), JSON.stringify({ ...BASE_CONFIG, machine_role: 'authoring' }));
    new SterlingStore(join(seam.dir, '.sterling', 'sterling.db')).close();
    const lines = context(seam.dir, 'startup', seam.hookPath).split('\n').filter((l) => l.length > 0);
    const at = lines.findIndex((l) => l.startsWith('STERLING ROOT:'));
    assert.ok(at >= 0, 'the STERLING ROOT line is present');
    assert.equal(lines[at], `STERLING ROOT: ${seam.dir}`);
    assert.match(lines[at + 1], /^MACHINE ROLE: AUTHORING/, 'MACHINE ROLE follows the root line directly');
  } finally {
    seam.cleanup();
  }
});

test('H1: with no MACHINE ROLE line, the STERLING ROOT line is still directly followed by the TDD posture line', () => {
  const dir = project();
  try {
    const lines = context(dir, 'startup').split('\n').filter((l) => l.length > 0);
    const at = lines.findIndex((l) => l.startsWith('STERLING ROOT:'));
    assert.ok(at >= 0);
    assert.ok(!lines.some((l) => l.startsWith('MACHINE ROLE:')), 'fixture precondition: no MACHINE ROLE here');
    assert.match(lines[at + 1], /^TDD/i, `next line is the TDD posture line, got: ${lines[at + 1]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// H1's early exits that emit additionalContext. The `if (!store)` exit is taken by a project
// whose store is blocked (unreadable or newer schema) and by one with .sterling/config.json but no
// sterling.db yet; both are Sterling projects whose instructions name <Sterling root>, so both
// print the line. A directory with no .sterling at all is not a Sterling project and prints nothing.
function stdoutOf(dir, source = 'startup') {
  const input = { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'SessionStart', source };
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'hooks', 'h1-session-start.mjs')], {
    input: JSON.stringify(input), encoding: 'utf8', cwd: dir, timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', NO_COLOR: '1', STERLING_NO_BANNER: '1' },
  });
  assert.equal(r.status, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
  return r.stdout;
}

test('H1: a project whose store is blocked (unreadable header) still prints the STERLING ROOT line on the no-store exit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1-root-blocked-'));
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(BASE_CONFIG));
    writeFileSync(join(dir, '.sterling', 'sterling.db'), 'not a sqlite database');
    const out = JSON.parse(stdoutOf(dir));
    assert.match(out.systemMessage, /schema/i, 'fixture precondition: the blocked-store exit was taken');
    assert.deepEqual(rootLines(out.hookSpecificOutput.additionalContext), [`STERLING ROOT: ${root}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H1: a Sterling project with a config but no store yet prints the STERLING ROOT line; a non-Sterling directory prints nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1-root-nostore-'));
  const plain = mkdtempSync(join(tmpdir(), 'sterling-h1-root-plain-'));
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(BASE_CONFIG));
    const out = JSON.parse(stdoutOf(dir));
    assert.deepEqual(rootLines(out.hookSpecificOutput.additionalContext), [`STERLING ROOT: ${root}`]);
    assert.equal(stdoutOf(plain), '', 'a directory with no .sterling prints nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});

test('H1: an unresolvable root prints a loud line, never the env value and never silence', async () => {
  const seam = await buildSeamHook('h1-session-start.mjs');
  const dir = project();
  try {
    const ctx = context(dir, 'startup', seam.hookPath, { STERLING_PLUGIN_ROOT: root });
    const lines = rootLines(ctx);
    assert.equal(lines.length, 1, 'exactly one STERLING ROOT line');
    assert.match(lines[0], /^STERLING ROOT: UNRESOLVED/);
    assert.ok(!lines[0].includes(root), 'the env seam value is never printed as the root');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    seam.cleanup();
  }
});
