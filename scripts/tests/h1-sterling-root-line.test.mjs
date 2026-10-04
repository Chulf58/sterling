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

test('H1: the STERLING ROOT line sits next to the MACHINE ROLE line', () => {
  const dir = project();
  try {
    const lines = context(dir, 'startup').split('\n').filter((l) => l.length > 0);
    const at = lines.findIndex((l) => l.startsWith('STERLING ROOT:'));
    assert.ok(at >= 0, 'the STERLING ROOT line is present');
    const role = lines.findIndex((l) => l.startsWith('MACHINE ROLE:'));
    // MACHINE ROLE is stated only on some machines; when it is, the two are adjacent.
    if (role >= 0) assert.equal(Math.abs(role - at), 1, 'adjacent to MACHINE ROLE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
