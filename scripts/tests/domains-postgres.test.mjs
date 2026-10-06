// scripts/domains.mjs with Postgres storage (issue Chulf58/sterling#26 item 7;
// decision storage-backend-is-its-own-config-key-written-only-by-store-move).
// A project whose config.storage is 'postgres' has its domain stores in the
// Postgres store registry, so the map lists those and never the domain folders
// under ~/.sterling/domains; --apply mounts a domain whose Postgres store exists
// and refuses, by name and before writing, one that has none. Nothing falls back
// to SQLite. The unreachable-database test needs no server; the rest need
// STERLING_TEST_PG=1 and use their own sterling_test_<random> namespace, dropped
// after. Each child runs under a scratch HOME that holds a copy of the credentials.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAIN_DESCRIPTION_KEY, PgBridge, PgDriver, SterlingStore, createPgStore, ensurePgLayout, readPgCredentials } from '@sterling/store';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PG = process.env.STERLING_TEST_PG === '1' ? false : 'set STERLING_TEST_PG=1 to run against Served';

const scratch = [];
const bridges = [];
const namespaces = [];
after(() => {
  for (const ns of namespaces) {
    for (const bridge of bridges) {
      try {
        for (const row of bridge.query('SELECT nspname FROM pg_namespace WHERE starts_with(nspname, $1)', [`${ns}_`]).rows) bridge.query(`DROP SCHEMA "${String(row.nspname)}" CASCADE`);
        break;
      } catch {
        // the next bridge, if this one is closed
      }
    }
  }
  for (const b of bridges) b.close();
  for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const tmp = (label) => {
  const d = mkdtempSync(join(tmpdir(), `sterling-domains-pg-${label}-`));
  scratch.push(d);
  return d;
};

function homeWith(credentialsFile) {
  const home = tmp('home');
  mkdirSync(join(home, '.sterling', 'credentials'), { recursive: true });
  const path = join(home, '.sterling', 'credentials', 'served.json');
  if (typeof credentialsFile === 'string') copyFileSync(credentialsFile, path);
  else writeFileSync(path, JSON.stringify(credentialsFile));
  chmodSync(path, 0o600);
  return home;
}

function project(home, config) {
  const dir = join(tmp('proj'), 'pgproj');
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: 'pgproj', toolchains: [], backup_opt_out: true, mode: 'work', storage: 'postgres', ...config }, null, 2));
  return dir;
}

function run(home, dir, args = [], namespace) {
  const env = { ...process.env, HOME: home, STERLING_REGISTRY_DB: join(home, 'registry.db') };
  if (namespace) env.STERLING_TEST_PG_NAMESPACE = namespace;
  else delete env.STERLING_TEST_PG_NAMESPACE;
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'domains.mjs'), ...args], { encoding: 'utf8', cwd: dir, timeout: 90_000, env });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('the database unreachable: the report exits 2 naming Postgres, writes nothing and never reads the domain folders', () => {
  const home = homeWith({ host: '127.0.0.1', port: 1, database: 'app', user: 'app', password: 'not-a-secret', connect_timeout_ms: 2000 });
  mkdirSync(join(home, '.sterling', 'domains', 'localonly'), { recursive: true });
  writeFileSync(join(home, '.sterling', 'domains', 'localonly', 'sterling.db'), '');
  const dir = project(home, { stack_tags: ['alpha'] });
  writeFileSync(join(dir, '.sterling', 'project.json'), JSON.stringify({ project_id: randomUUID() }));
  const before = readFileSync(join(dir, '.sterling', 'config.json'), 'utf8');
  const r = run(home, dir);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /storage 'postgres': the Postgres store database could not be reached/);
  assert.doesNotMatch(r.stderr, /not-a-secret|localonly/);
  assert.equal(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'), before);
  assert.deepEqual(readdirSync(join(dir, '.sterling')).sort(), ['config.json', 'project.json']);
});

test('a Postgres-storage project with no identity file is refused by name', () => {
  const home = homeWith({ host: '127.0.0.1', port: 1, database: 'app', user: 'app', password: 'not-a-secret' });
  const dir = project(home, { stack_tags: ['alpha'] });
  const r = run(home, dir, ['--apply', '--add', 'alpha']);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /store settings of .* cannot be used \(ProjectIdentityError/);
});

// A project plus domain stores under a fresh sterling_test_ namespace.
function served(domains) {
  const ns = `sterling_test_${randomBytes(6).toString('hex')}`;
  namespaces.push(ns);
  const bridge = new PgBridge(readPgCredentials());
  bridges.push(bridge);
  const metaSchema = `${ns}_meta`;
  ensurePgLayout(bridge, metaSchema);
  const id = randomUUID();
  createPgStore(bridge, { kind: 'test', name: 'pgproj', schema: `${ns}_p_${id.replace(/-/g, '')}`, metaSchema });
  for (const [name, description] of Object.entries(domains)) {
    const schema = `${ns}_d_${name}`;
    createPgStore(bridge, { kind: 'test', name, schema, metaSchema });
    if (description !== null) {
      const store = new SterlingStore(`postgres:${schema}`, { driver: new PgDriver(bridge, { schema, metaSchema }) });
      store.setMeta(DOMAIN_DESCRIPTION_KEY, description);
      store.close();
    }
  }
  const schemas = () => bridge.query('SELECT nspname FROM pg_namespace WHERE starts_with(nspname, $1) ORDER BY nspname', [`${ns}_`]).rows.map((r) => String(r.nspname));
  return { ns, id, schemas };
}

const servedCredentials = join(homedir(), '.sterling', 'credentials', 'served.json');

test('the map lists the Postgres domain stores with their descriptions, never the domain folders', { skip: PG }, () => {
  const s = served({ alpha: 'Alpha facts', bare: null });
  const home = homeWith(servedCredentials);
  mkdirSync(join(home, '.sterling', 'domains', 'localonly'), { recursive: true });
  writeFileSync(join(home, '.sterling', 'domains', 'localonly', 'sterling.db'), '');
  const dir = project(home, { stack_tags: ['alpha'] });
  writeFileSync(join(dir, '.sterling', 'project.json'), JSON.stringify({ project_id: s.id }));
  const r = run(home, dir, ['--json'], s.ns);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const map = JSON.parse(r.stdout);
  const byName = Object.fromEntries(map.domains.map((d) => [d.name, d]));
  assert.equal(byName.alpha.has_store, true);
  assert.equal(byName.alpha.description, 'Alpha facts');
  assert.equal(byName.alpha.path, `postgres:${s.ns}_d_alpha`);
  assert.equal(byName.bare.has_store, true, 'a store created but never opened is listed');
  assert.equal(byName.bare.description, null);
  assert.equal(byName.localonly, undefined, 'the SQLite domain folder is not part of a Postgres project\'s map');
  assert.ok(map.notes.some((n) => /keeps its stores in Postgres/.test(n)));
});

test('--apply mounts a domain whose Postgres store exists, creating no store anywhere', { skip: PG }, () => {
  const s = served({ alpha: 'Alpha facts', beta: 'Beta facts' });
  const home = homeWith(servedCredentials);
  const dir = project(home, { stack_tags: ['alpha', 'sterling'] });
  writeFileSync(join(dir, '.sterling', 'project.json'), JSON.stringify({ project_id: s.id }));
  const schemasBefore = s.schemas();
  const r = run(home, dir, ['--apply', '--add', 'beta'], s.ns);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8')).stack_tags, ['alpha', 'beta', 'sterling']);
  assert.deepEqual(s.schemas(), schemasBefore, 'no Postgres schema was created');
  assert.equal(existsSync(join(home, '.sterling', 'domains')), false, 'no SQLite domain store was created');
});

test('--apply refuses a domain with no Postgres store by name and writes nothing', { skip: PG }, () => {
  const s = served({ alpha: 'Alpha facts' });
  const home = homeWith(servedCredentials);
  const dir = project(home, { stack_tags: ['alpha', 'sterling'] });
  writeFileSync(join(dir, '.sterling', 'project.json'), JSON.stringify({ project_id: s.id }));
  const before = readFileSync(join(dir, '.sterling', 'config.json'), 'utf8');
  const schemasBefore = s.schemas();
  const r = run(home, dir, ['--apply', '--add', 'gamma', '--description', 'gamma=Gamma facts'], s.ns);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /'gamma' has no Postgres domain store, and this command creates domain stores only on SQLite storage/);
  assert.match(r.stderr, /Nothing was written/);
  assert.equal(readFileSync(join(dir, '.sterling', 'config.json'), 'utf8'), before);
  assert.deepEqual(s.schemas(), schemasBefore);
  assert.equal(existsSync(join(home, '.sterling', 'domains')), false);
});
