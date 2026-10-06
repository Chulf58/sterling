// scripts/lib/project.mjs routes through @sterling/store/routing (issue
// Chulf58/sterling#26 item 5; decision
// storage-backend-is-its-own-config-key-written-only-by-store-move): a project
// whose config.storage is 'postgres' has openers that fail by name when
// the identity, the credentials or the server is missing, and write nothing;
// the hobby openers keep their SQLite behaviour (covered by every other script
// suite). The read-only open against Served needs STERLING_TEST_PG=1 and uses
// its own sterling_test_<random> namespace, dropped after.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PgBridge, createPgStore, ensurePgLayout, readPgCredentials } from '@sterling/store';

const projectLib = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'project.mjs')).href;
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tempDir = (label) => {
  const d = mkdtempSync(join(tmpdir(), `sterling-project-routing-${label}-`));
  dirs.push(d);
  return d;
};

function project(config, identity) {
  const root = tempDir('project');
  mkdirSync(join(root, '.sterling'));
  writeFileSync(join(root, '.sterling', 'config.json'), JSON.stringify(config));
  if (identity !== undefined) writeFileSync(join(root, '.sterling', 'project.json'), JSON.stringify({ project_id: identity }));
  return root;
}

function homeWith(creds) {
  const home = tempDir('home');
  mkdirSync(join(home, '.sterling', 'credentials'), { recursive: true });
  const path = join(home, '.sterling', 'credentials', 'served.json');
  writeFileSync(path, JSON.stringify(creds));
  chmodSync(path, 0o600);
  return home;
}

// Runs one opener in a child (the openers exit on refusal) and, when it opens,
// prints what the handle saw and whether a write was refused.
function runOpener(opener, root, env = {}) {
  const probe = join(tempDir('probe'), 'probe.mjs');
  writeFileSync(
    probe,
    `import { ${opener} } from ${JSON.stringify(projectLib)};\n` +
      `const opened = ${opener}(process.argv[2]);\n` +
      `const out = { count: opened.store.count({}) };\n` +
      `try { opened.store.create({ id: '${randomUUID()}', type: 'reference_material', created_at: '2026-10-06T00:00:00.000Z', updated_at: '2026-10-06T00:00:00.000Z', author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [], title: 't', kind: 'doc', location: 'x', summary: 's', source_date: '2026-10-06', capture_date: '2026-10-06', basis: 'platform' }); out.write = 'landed'; } catch (e) { out.write = e.constructor.name; }\n` +
      `(opened.close ?? (() => opened.store.close()))();\n` +
      `process.stdout.write(JSON.stringify(out));\n`,
  );
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', probe, root], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env } });
}

const UNREACHABLE = { host: '127.0.0.1', port: 1, database: 'app', user: 'app', password: 'not-a-secret', connect_timeout_ms: 2000 };

for (const opener of ['openProject', 'openMounted', 'openProjectReadOnly']) {
  test(`${opener}: a Postgres-storage project with the database unreachable exits 1 naming StoreUnreachableError; nothing is written`, () => {
    const root = project({ mode: 'work', storage: 'postgres', stack_tags: ['alpha'] }, randomUUID());
    const r = runOpener(opener, root, { HOME: homeWith(UNREACHABLE) });
    assert.equal(r.status, 1, `stdout=${r.stdout}`);
    assert.match(r.stderr, /^StoreUnreachableError: storage 'postgres': the Postgres store database at 127\.0\.0\.1:1\/app is unreachable/m);
    assert.doesNotMatch(r.stderr, /not-a-secret/);
    assert.deepEqual(readdirSync(join(root, '.sterling')).sort(), ['config.json', 'project.json']);
  });
}

test('openProject: a Postgres-storage project with no identity file exits 1 naming ProjectIdentityError', () => {
  const root = project({ mode: 'work', storage: 'postgres' });
  const r = runOpener('openProject', root, { HOME: homeWith(UNREACHABLE) });
  assert.equal(r.status, 1, `stdout=${r.stdout}`);
  assert.match(r.stderr, /^ProjectIdentityError: storage 'postgres' needs the project identity file/m);
  assert.deepEqual(readdirSync(join(root, '.sterling')), ['config.json']);
});

test('openProject: a Postgres-storage project with no credentials file exits 1 naming StoreSettingsError', () => {
  const root = project({ mode: 'work', storage: 'postgres' }, randomUUID());
  const r = runOpener('openProject', root, { HOME: tempDir('empty-home') });
  assert.equal(r.status, 1, `stdout=${r.stdout}`);
  assert.match(r.stderr, /^StoreSettingsError: storage 'postgres': Postgres credentials file .*served\.json' cannot be read/m);
});

test('openProjectReadOnly with Postgres storage: reads the Postgres store and refuses every write', { skip: process.env.STERLING_TEST_PG === '1' ? false : 'set STERLING_TEST_PG=1 to run against Served' }, () => {
  const ns = `sterling_test_${randomBytes(6).toString('hex')}`;
  const id = randomUUID();
  const bridge = new PgBridge(readPgCredentials());
  try {
    ensurePgLayout(bridge, `${ns}_meta`);
    createPgStore(bridge, { kind: 'test', name: 'read-only project', schema: `${ns}_p_${id.replace(/-/g, '')}`, metaSchema: `${ns}_meta` });
    const root = project({ mode: 'work', storage: 'postgres' }, id);
    const env = { STERLING_TEST_PG_NAMESPACE: ns };
    const ro = runOpener('openProjectReadOnly', root, env);
    assert.equal(ro.status, 0, ro.stderr);
    assert.deepEqual(JSON.parse(ro.stdout), { count: 0, write: 'PgTransactionOpenError' });
    const rw = runOpener('openProject', root, env);
    assert.equal(rw.status, 0, rw.stderr);
    assert.deepEqual(JSON.parse(rw.stdout), { count: 0, write: 'landed' }, 'the writable opener writes, so the refusal above is the read-only open\'s');
  } finally {
    try {
      const rows = bridge.query('SELECT nspname FROM pg_namespace WHERE starts_with(nspname, $1)', [`${ns}_`]).rows;
      for (const row of rows) bridge.query(`DROP SCHEMA "${String(row.nspname)}" CASCADE`);
    } finally {
      bridge.close();
    }
  }
});
