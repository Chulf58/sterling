// Postgres-storage refusal for the two SQLite-only scripts (board 9af3fdd0, issue
// Chulf58/sterling#26 item 7): scripts/domain-doctor.mjs and
// scripts/migration-preflight.mjs do SQLite file forensics and a v1 -> v2
// SQLite migration preflight, which have no meaning where config.storage is
// 'postgres'. The verdict is the storage, in any mode (a hobby project can be on
// Postgres). Both refuse there with exit 4 before opening anything; a project on
// SQLite is unchanged, whatever its mode. The invoking project
// is the Sterling root of the cwd (a linked worktree resolves to its main
// checkout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCTOR = join(repo, 'scripts', 'domain-doctor.mjs');
const PREFLIGHT = join(repo, 'scripts', 'migration-preflight.mjs');
const REFUSED = 4;

function project(config) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hobby-only-')));
  if (config !== undefined) {
    mkdirSync(join(dir, '.sterling'));
    writeFileSync(join(dir, '.sterling', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  return dir;
}

// A real WAL-mode store file (checkpointed and closed, so no sidecars exist).
function store(dir) {
  const path = join(dir, 'probe.db');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE records (id TEXT PRIMARY KEY, type TEXT, status TEXT, body TEXT)');
  db.exec("INSERT INTO records VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'decision', 'active', '{}')");
  db.close();
  return path;
}

function snapshot(dir) {
  return readdirSync(dir).sort().map((name) => {
    const full = join(dir, name);
    return name === '.sterling' ? name : `${name}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`;
  });
}

function run(script, args, cwd) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd, timeout: 60_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

for (const [name, script, argsFor] of [
  ['domain-doctor', DOCTOR, (db) => ['show', '--db', db, '--id', 'aaaaaaaa']],
  ['migration-preflight', PREFLIGHT, (db) => ['--db', db]],
]) {
  test(`${name}: refuses on Postgres storage (hobby and work mode alike) with exit 4, naming the script and the storage, opening nothing`, () => {
    for (const mode of ['hobby', 'work']) refusesOnPostgres(mode);
  });

  function refusesOnPostgres(mode) {
    const dir = project({ mode, storage: 'postgres' });
    try {
      const db = store(dir);
      const before = snapshot(dir);
      const r = run(script, argsFor(db), dir);
      assert.equal(r.code, REFUSED, r.stderr);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, new RegExp(`^${name}: refused`, 'm'));
      assert.match(r.stderr, /config\.storage is 'postgres'/);
      assert.match(r.stderr, /Postgres/);
      assert.match(r.stderr, /exit 4/);
      assert.deepEqual(snapshot(dir), before, 'store bytes unchanged and no -wal/-shm created');
      assert.deepEqual(readdirSync(dir).sort(), ['.sterling', 'probe.db']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test(`${name}: the refusal comes before argument checks, so a bad --db on Postgres storage is still exit 4`, () => {
    const dir = project({ mode: 'hobby', storage: 'postgres' });
    try {
      const r = run(script, name === 'domain-doctor' ? ['show', '--db', join(dir, 'missing.db'), '--id', 'x'] : ['--db', join(dir, 'missing.db')], dir);
      assert.equal(r.code, REFUSED, r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${name}: an invalid config.storage refuses loudly instead of guessing sqlite`, () => {
    const dir = project({ storage: 'pg' });
    try {
      const r = run(script, argsFor(store(dir)), dir);
      assert.equal(r.code, REFUSED, r.stderr);
      assert.match(r.stderr, /config\.storage/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${name}: a project on SQLite storage is not refused, whatever its mode (explicit, absent key, work mode, or no config)`, () => {
    for (const config of [{ mode: 'hobby' }, { mode: 'work' }, { mode: 'work', storage: 'sqlite' }, {}, undefined]) {
      const dir = project(config);
      try {
        const r = run(script, argsFor(store(dir)), dir);
        assert.notEqual(r.code, REFUSED, `${JSON.stringify(config)}: ${r.stderr}`);
        assert.doesNotMatch(r.stderr, /config\.storage is 'postgres'/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test(`${name}: a linked worktree of a Postgres-storage project is refused through its main checkout`, () => {
    const dir = project({ mode: 'hobby', storage: 'postgres' });
    const wt = `${dir}-wt`;
    try {
      const git = (...a) => {
        const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
      };
      git('init', '-q');
      writeFileSync(join(dir, 'f.txt'), 'x');
      git('add', 'f.txt');
      git('commit', '-q', '-m', 'init');
      git('worktree', 'add', '-q', wt);
      const r = run(script, ['--db', join(wt, 'none.db')], wt);
      assert.equal(r.code, REFUSED, r.stderr);
      assert.match(r.stderr, /config\.storage is 'postgres'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(wt, { recursive: true, force: true });
    }
  });
}
