// H1 SessionStart: STORAGE LINE (board 6ca1a3c5, decision
// storage-backend-is-its-own-config-key-written-only-by-store-move). Informational
// and read-only: H1 states where the project's stores live, after the Handoff
// files line. Four separate states (anti_pattern
// config-derived-posture-line-collapses-absent-into-unusable): an ABSENT key is
// SQLite (the routing default, stated as "not set"), 'sqlite' is SQLite stated
// explicitly, 'postgres' is Served Postgres, any other value is UNRECOGNIZED with
// its raw value (never SQLite), and an unreadable or non-object config is UNKNOWN
// (never the default). Harness copied from h1-project-mode-line.test.mjs.
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

// A SQLite store file sits beside every config, so a hook that reads the store backend
// from disk finds one; H1 itself only states the setting and opens no Postgres store.
function project(rawConfig) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1-storage-'));
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

const storageLines = (ctx) => ctx.split('\n').filter((l) => l.startsWith('Storage:'));
const TAIL = 'TUI System tab; switch with the move-store skill';

function storageLineFor(rawConfig) {
  const dir = project(rawConfig);
  try {
    return storageLines(context(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// No credentials or project identity exist in this fixture, so the Postgres store cannot be
// opened and H1 takes its early DEGRADED exit. The line must still be stated there: that is
// where a reader most needs to see which backend the config names.
test('H1 states Storage: SERVED POSTGRES for config.storage postgres, also on the DEGRADED early exit', () => {
  const dir = project({ ...BASE_CONFIG, storage: 'postgres' });
  try {
    const ctx = context(dir);
    assert.match(ctx, /Sterling store: DEGRADED/);
    assert.deepEqual(storageLines(ctx), [`Storage: SERVED POSTGRES (config.storage — ${TAIL})`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H1 puts the Storage line after the Handoff files line on the normal path', () => {
  const dir = project({ ...BASE_CONFIG, storage: 'sqlite' });
  try {
    const ctx = context(dir);
    assert.ok(ctx.indexOf('Handoff files:') !== -1 && ctx.indexOf('Handoff files:') < ctx.indexOf('Storage:'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H1 states Storage: SQLITE for an explicit sqlite and tells an absent key apart', () => {
  assert.deepEqual(storageLineFor({ ...BASE_CONFIG, storage: 'sqlite' }), [`Storage: SQLITE (config.storage — ${TAIL})`]);
  assert.deepEqual(storageLineFor({ ...BASE_CONFIG }), [`Storage: SQLITE (config.storage not set, so SQLite — ${TAIL})`]);
});

test('H1 shows an unrecognized config.storage as UNRECOGNIZED with its raw value, never as SQLite', () => {
  for (const [value, shown] of [['mysql', '"mysql"'], ['Postgres', '"Postgres"'], [5, '5'], [null, 'null'], [true, 'true']]) {
    const lines = storageLineFor({ ...BASE_CONFIG, storage: value });
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith(`Storage: UNRECOGNIZED (${shown}) — config.storage must be 'sqlite' or 'postgres'`), lines[0]);
    assert.doesNotMatch(lines[0], /SQLITE|SERVED POSTGRES/);
  }
});

test('H1 reports Storage: UNKNOWN, never the SQLite default, for an unreadable or non-object config', () => {
  for (const raw of ['{ not json', '[]', 'true', 'false', '0', '""', '"x"', '5']) {
    const lines = storageLineFor(raw);
    assert.equal(lines.length, 1, `config ${raw}`);
    assert.ok(lines[0].startsWith('Storage: UNKNOWN — the project config could not be read, so config.storage could not be determined.'), `config ${raw}: ${lines[0]}`);
    assert.match(lines[0], /NOT the SQLite default/);
    assert.doesNotMatch(lines[0], /Storage: SQLITE/);
  }
});
