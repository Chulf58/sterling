// H1 SessionStart — PROJECT MODE LINE (decision
// project-mode-hobby-work-toggle-decides-flow, slice S1). Informational only:
// H1 states the project's config.mode next to the MACHINE ROLE / TDD posture
// lines. A missing key means hobby; an invalid value reads INVALID (never as
// either flow); an unreadable config reads UNKNOWN (never the default).
// Harness copied from scripts/tests/h1-tdd-posture-line.test.mjs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const BASE_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
};

function project(rawConfig) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1-mode-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), typeof rawConfig === 'string' ? rawConfig : JSON.stringify(rawConfig));
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  return dir;
}

function context(dir) {
  const input = { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'SessionStart', source: 'startup' };
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'hooks', 'h1-session-start.mjs')], {
    input: JSON.stringify(input), encoding: 'utf8', cwd: dir, timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', NO_COLOR: '1', STERLING_NO_BANNER: '1', STERLING_PLUGIN_ROOT: root },
  });
  assert.equal(r.status, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

const modeLines = (ctx) => ctx.split('\n').filter((l) => l.startsWith('Project mode:'));

const WORK_LINE = 'Project mode: WORK (config.mode — TUI System tab) — the OpenCode agents and handoff files are written and maintained.';
const HOBBY_LINE = 'Project mode: HOBBY (config.mode — TUI System tab) — the OpenCode agents and handoff files are not written or maintained in hobby mode; existing ones may remain from an earlier work period.';

for (const [label, cfg, expected] of [
  ['work', { ...BASE_CONFIG, mode: 'work' }, WORK_LINE],
  ['hobby', { ...BASE_CONFIG, mode: 'hobby' }, HOBBY_LINE],
  ['a missing key (hobby)', BASE_CONFIG, HOBBY_LINE],
]) {
  test(`H1 states the project mode exactly once, full text: ${label}`, () => {
    const dir = project(cfg);
    try {
      const lines = modeLines(context(dir));
      assert.deepEqual(lines, [expected]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('H1 reads an invalid mode as INVALID, never as either flow', () => {
  const dir = project({ ...BASE_CONFIG, mode: 'Work' });
  try {
    const lines = modeLines(context(dir));
    assert.equal(lines.length, 1);
    assert.equal(lines[0], "Project mode: INVALID ('Work') — config.mode must be 'hobby' or 'work'; init, sync-agents and /sterling:update refuse to act on it until it is fixed (TUI System tab).");
    assert.doesNotMatch(lines[0], /HOBBY|WORK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H1 reads an unreadable config as UNKNOWN, never the hobby default', () => {
  const dir = project('{ not json');
  try {
    const lines = modeLines(context(dir));
    assert.equal(lines.length, 1);
    assert.equal(lines[0], 'Project mode: UNKNOWN — the project config could not be read, so config.mode could not be determined. This is NOT the hobby default: repair the config.');
    assert.doesNotMatch(lines[0], /HOBBY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the project-mode line sits right after the TDD posture line', () => {
  const dir = project({ ...BASE_CONFIG, mode: 'work' });
  try {
    const ctx = context(dir);
    const tdd = ctx.indexOf('TDD posture:');
    const mode = ctx.indexOf('Project mode:');
    assert.ok(tdd !== -1 && mode > tdd, 'the mode line follows the TDD posture line');
    assert.equal(ctx.slice(tdd, mode).split('\n\n').length, 2, 'nothing sits between the two lines');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
