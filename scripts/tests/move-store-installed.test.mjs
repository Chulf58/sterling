// bin/move-store.mjs runs from an installed plugin copy (board 013190cf). The
// plugin installs from git, and packages/*/dist/ is gitignored, so an installed
// copy has no compiled store; scripts/move-store.mjs imports it and fails there
// with ERR_MODULE_NOT_FOUND. The test copies the COMMITTED bin bundle and its
// Postgres worker into a temp tree with no packages/*/dist and no node_modules,
// and runs it against temp projects under a temp HOME, so the machine's real
// credentials, registry and the Served database are never reached. Each run
// must end in the script's own refusal, never a module-load error.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const base = mkdtempSync(join(tmpdir(), 'sterling-move-installed-'));
after(() => rmSync(base, { recursive: true, force: true }));

// The installed layout: bin/ bundles, scripts/ sources, packages/store with no dist.
const plugin = join(base, 'plugin');
const home = join(base, 'home');
before(() => {
  for (const rel of ['bin/move-store.mjs', 'bin/pg-worker.js', 'scripts/move-store.mjs', 'packages/store/package.json']) {
    mkdirSync(dirname(join(plugin, rel)), { recursive: true });
    copyFileSync(join(repo, rel), join(plugin, rel));
  }
  mkdirSync(home);
});

function run(entry, args) {
  const r = spawnSync(process.execPath, [join(plugin, entry), ...args], {
    cwd: base,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, STERLING_REGISTRY_DB: join(base, 'registry.db') },
    timeout: 60_000,
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/, `${entry} ${args.join(' ')} failed to load:\n${out}`);
  return r;
}

function workProject(name, { identity = true } = {}) {
  const dir = join(base, name);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode: 'work', stack_tags: [], domain_paths: {} }, null, 2));
  if (identity) writeFileSync(join(dir, '.sterling', 'project.json'), JSON.stringify({ project_id: randomUUID() }));
  return dir;
}

const configOf = (dir) => readFileSync(join(dir, '.sterling', 'config.json'), 'utf8');

test('the copied tree has no compiled store: the scripts/ source cannot load there', () => {
  const r = spawnSync(process.execPath, [join(plugin, 'scripts', 'move-store.mjs'), '--to', 'pg', '--dry-run'], { cwd: base, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ERR_MODULE_NOT_FOUND/);
});

test('bin/move-store.mjs: no arguments is a usage error naming the bin command', () => {
  const r = run('bin/move-store.mjs', []);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--to must be pg or sqlite, got nothing/);
  assert.match(r.stderr, /usage: node bin\/move-store\.mjs --to pg\|sqlite/);
});

test('bin/move-store.mjs --to pg --dry-run: a work project with no project.json is refused by name', () => {
  const dir = workProject('no-identity', { identity: false });
  const before = configOf(dir);
  const r = run('bin/move-store.mjs', ['--to', 'pg', '--dry-run', '--project', dir]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /MoveIdentityMissingError: .*project\.json is missing/);
  assert.equal(configOf(dir), before);
});

test('bin/move-store.mjs --to pg --dry-run: missing credentials are refused by name', () => {
  const dir = workProject('no-creds-move');
  const r = run('bin/move-store.mjs', ['--to', 'pg', '--dry-run', '--project', dir]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /MoveCredentialsError: Postgres credentials file '.*served\.json' cannot be read: ENOENT/);
});

test('bin/move-store.mjs --attach --dry-run: missing credentials are refused by name', () => {
  const dir = workProject('no-creds-attach');
  const before = configOf(dir);
  const r = run('bin/move-store.mjs', ['--attach', '--dry-run', '--project', dir]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /MoveCredentialsError: Postgres credentials file '.*served\.json' cannot be read: ENOENT/);
  assert.equal(configOf(dir), before);
});

test('bin/move-store.mjs --attach --dry-run: the Postgres worker loads beside the bundle and reports the refused connection', async () => {
  // A loopback port that was just free, so the connection is refused locally.
  const port = await new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const creds = join(home, '.sterling', 'credentials', 'served.json');
  mkdirSync(dirname(creds), { recursive: true });
  writeFileSync(creds, JSON.stringify({ host: '127.0.0.1', port, database: 'none', user: 'none', password: '', connect_timeout_ms: 2000 }));
  chmodSync(creds, 0o600);
  try {
    const dir = workProject('refused');
    const r = run('bin/move-store.mjs', ['--attach', '--dry-run', '--project', dir]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /ECONNREFUSED/);
  } finally {
    rmSync(creds);
  }
});
